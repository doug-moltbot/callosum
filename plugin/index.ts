/**
 * Callosum Protocol — OpenClaw Plugin (bundled)
 * Source: https://github.com/doug-moltbot/callosum
 * 
 * Single-file bundle for OpenClaw plugin loading.
 * See the repo for the modular source.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, statSync, renameSync } from "fs";
import { join, dirname } from "path";

// ═══ Tier Engine ═══════════════════════════════════════════════════════════

type Tier = 0 | 1 | 2 | 3 | 4;

interface TierRuleConfig {
  name?: string;
  tier: Tier;
  tool: string | string[];
  params?: Record<string, string | string[]>;
  commandPattern?: string;
  contextKey?: string;
  recentWindowMs?: number;
}

interface TierRulesConfig {
  description?: string;
  rules: TierRuleConfig[];
}

interface CompiledRule {
  name: string;
  tier: Tier;
  toolMatch: (tool: string) => boolean;
  paramsMatch: (params: Record<string, unknown>) => boolean;
  commandRegex?: RegExp;
  contextKeyTemplate?: string;
  recentWindowMs?: number;
}

function compileRule(rule: TierRuleConfig, index: number): CompiledRule {
  const name = rule.name || `rule-${index}`;
  let toolMatch: (t: string) => boolean;
  if (rule.tool === "*") toolMatch = () => true;
  else if (Array.isArray(rule.tool)) { const set = new Set(rule.tool); toolMatch = (t) => set.has(t); }
  else toolMatch = (t) => t === rule.tool;

  let paramsMatch: (p: Record<string, unknown>) => boolean;
  if (rule.params) {
    const checks = Object.entries(rule.params).map(([key, expected]) => {
      const values = Array.isArray(expected) ? expected : [expected];
      return (p: Record<string, unknown>) => values.includes(String(p[key] ?? ""));
    });
    paramsMatch = (p) => checks.every((check) => check(p));
  } else paramsMatch = () => true;

  return {
    name, tier: rule.tier, toolMatch, paramsMatch,
    commandRegex: rule.commandPattern ? new RegExp(rule.commandPattern) : undefined,
    contextKeyTemplate: rule.contextKey,
    recentWindowMs: rule.recentWindowMs,
  };
}

function resolveTemplate(template: string, tool: string, params: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    for (const alt of expr.split("|").map((s: string) => s.trim())) {
      if (alt === "tool") return tool;
      if (alt.startsWith("params.")) {
        const val = params[alt.slice(7)];
        if (val !== undefined && val !== null && val !== "") return String(val);
        continue;
      }
      if (alt === "commandRecipient") {
        const cmd = String(params.command || "");
        const m = cmd.match(/--mail-rcpt\s+'?([^'\s]+)/) || cmd.match(/--to\s+'?([^'\s]+)/);
        return m ? m[1] : "unknown";
      }
      if (!alt.includes(".")) return alt;
    }
    return "unknown";
  });
}

class TierEngine {
  private rules: CompiledRule[];
  constructor(config: TierRulesConfig) { this.rules = config.rules.map((r, i) => compileRule(r, i)); }
  classify(tool: string, params: Record<string, unknown>) {
    for (const rule of this.rules) {
      if (!rule.toolMatch(tool)) continue;
      if (!rule.paramsMatch(params)) continue;
      if (rule.commandRegex && !rule.commandRegex.test(String(params.command || ""))) continue;
      return {
        tier: rule.tier,
        contextKey: rule.contextKeyTemplate ? resolveTemplate(rule.contextKeyTemplate, tool, params) : null,
        ruleName: rule.name,
        recentWindowMs: rule.recentWindowMs,
      };
    }
    return { tier: 0 as Tier, contextKey: null, ruleName: "default-fallback", recentWindowMs: undefined };
  }
  get ruleCount() { return this.rules.length; }
}

// ═══ Default Rules ═════════════════════════════════════════════════════════

const DEFAULT_RULES: TierRulesConfig = {
  rules: [
    { name: "channel-delete", tier: 4, tool: "message", params: { action: ["channel-delete", "category-delete"] }, contextKey: "{tool}:{params.action}" },
    { name: "config-apply", tier: 4, tool: "gateway", params: { action: ["config.apply", "update.run"] }, contextKey: "{tool}:{params.action}" },
    { name: "email-send", tier: 3, tool: "exec", commandPattern: "(smtp://|himalaya.*send)", contextKey: "email:{commandRecipient}" },
    { name: "cron-mutate", tier: 3, tool: "cron", params: { action: ["add", "update"] }, contextKey: "cron:{params.jobId|new}" },
    { name: "message-send", tier: 2, tool: "message", params: { action: ["send", "edit", "react", "thread-reply", "thread-create", "poll"] }, contextKey: "channel:{params.target|params.channel|unknown}" },
    { name: "session-interact", tier: 2, tool: ["sessions_send", "sessions_spawn"], contextKey: "session:{params.sessionKey|params.label|unknown}" },
    { name: "file-write", tier: 1, tool: ["write", "edit"], contextKey: "file:{params.path|params.file_path|unknown}" },
    { name: "exec-general", tier: 1, tool: "exec" },
    { name: "default", tier: 0, tool: "*" },
  ],
};

// ═══ State Management ══════════════════════════════════════════════════════

interface Lock { instance: string; contextKey: string; tier: Tier; acquiredAt: number; expiresAt: number; }
interface ContextEntry { instance: string; contextKey: string; tier: Tier; timestamp: number; tool: string; }
interface JournalEntry { timestamp: string; instance: string; tool: string; tier: Tier; ruleName: string; contextKey: string | null; action: string; params_summary?: string; conflict?: string; }

const CONTEXT_WINDOW_MS = 30 * 60 * 1000;
const ROTATION_SIZE = 2 * 1024 * 1024;

class CallosumState {
  constructor(private stateDir: string, private lockExpiryMs: number) { mkdirSync(stateDir, { recursive: true }); }
  private p(f: string) { return join(this.stateDir, f); }

  readLocks(): Lock[] { try { return (JSON.parse(readFileSync(this.p("locks.json"), "utf-8")) as Lock[]).filter(l => l.expiresAt > Date.now()); } catch { return []; } }
  private writeLocks(locks: Lock[]) { writeFileSync(this.p("locks.json"), JSON.stringify(locks, null, 2)); }

  acquireLock(inst: string, key: string, tier: Tier): boolean {
    const locks = this.readLocks();
    const ex = locks.find(l => l.contextKey === key);
    if (ex && ex.instance !== inst) return false;
    if (ex && ex.instance === inst) { ex.expiresAt = Date.now() + this.lockExpiryMs; this.writeLocks(locks); return true; }
    locks.push({ instance: inst, contextKey: key, tier, acquiredAt: Date.now(), expiresAt: Date.now() + this.lockExpiryMs });
    this.writeLocks(locks); return true;
  }

  releaseLock(inst: string, key: string) { this.writeLocks(this.readLocks().filter(l => !(l.contextKey === key && l.instance === inst))); }

  private readContexts(): ContextEntry[] { try { return (JSON.parse(readFileSync(this.p("contexts.json"), "utf-8")) as ContextEntry[]).filter(e => e.timestamp > Date.now() - CONTEXT_WINDOW_MS); } catch { return []; } }
  recordContext(inst: string, key: string, tier: Tier, tool: string) { const c = this.readContexts(); c.push({ instance: inst, contextKey: key, tier, timestamp: Date.now(), tool }); writeFileSync(this.p("contexts.json"), JSON.stringify(c, null, 2)); }

  checkConflicts(inst: string, key: string, tier: Tier) {
    const lock = this.readLocks().find(l => l.contextKey === key && l.instance !== inst);
    if (lock) return { hasConflict: true, conflictWith: lock.instance, locked: true };
    if (tier >= 3) { const ctx = this.readContexts().find(c => c.contextKey === key && c.instance !== inst); if (ctx) return { hasConflict: true, conflictWith: ctx.instance }; }
    return { hasConflict: false };
  }

  appendJournal(entry: JournalEntry) { const p = this.p("journal.jsonl"); appendFileSync(p, JSON.stringify(entry) + "\n"); try { if (statSync(p).size > ROTATION_SIZE) { try { renameSync(p + ".1", p + ".2"); } catch {} renameSync(p, p + ".1"); } } catch {} }
  getJournal(limit = 50): JournalEntry[] { try { return readFileSync(this.p("journal.jsonl"), "utf-8").trim().split("\n").slice(-limit).map(l => JSON.parse(l)); } catch { return []; } }

  /** Get recent completed actions at or above a tier */
  recentActions(minTier: Tier = 3, limit = 20, windowMs = 3600000): JournalEntry[] {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return this.getJournal(200).filter(e => e.action === "complete" && e.tier >= minTier && e.timestamp > cutoff).slice(-limit);
  }
  getStatus() { return { locks: this.readLocks(), recentContexts: this.readContexts() }; }
}

// ═══ Plugin Entry ══════════════════════════════════════════════════════════

function summarize(params: Record<string, unknown>): string {
  const s: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) s[k] = typeof v === "string" && v.length > 100 ? v.slice(0, 80) + "…" : v;
  return JSON.stringify(s);
}

export default function register(api: any) {
  const cfg = api.pluginConfig ?? {};
  const stateDir = cfg.stateDir || join(api.config?.agents?.defaults?.workspace || "/data/workspace", ".openclaw", "callosum-state");
  const lockExpiryMs = cfg.lockExpiryMs || 300_000;
  const recentWindowMs = cfg.recentWindowMs || 3_600_000; // default 1 hour
  const instanceId = cfg.instanceId || "unknown";
  const state = new CallosumState(stateDir, lockExpiryMs);
  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // Load rules
  let engine: TierEngine;
  const tiersPath = join(dirname(api.source || __filename), "tiers.json");
  try {
    engine = existsSync(tiersPath) ? new TierEngine(JSON.parse(readFileSync(tiersPath, "utf-8"))) : new TierEngine(DEFAULT_RULES);
  } catch { engine = new TierEngine(DEFAULT_RULES); }
  log.info(`[callosum] Ready. instance=${instanceId}, rules=${engine.ruleCount}, stateDir=${stateDir}`);

  // before_tool_call
  api.on("before_tool_call", (event: any, _ctx: any) => {
    const { toolName, params = {} } = event;
    const { tier, contextKey, ruleName, recentWindowMs: ruleWindowMs } = engine.classify(toolName, params);
    const windowMs = ruleWindowMs ?? recentWindowMs; // per-rule overrides global
    state.appendJournal({ timestamp: new Date().toISOString(), instance: instanceId, tool: toolName, tier, ruleName, contextKey, action: "intercept", params_summary: tier >= 2 ? summarize(params) : undefined });
    if (tier >= 2 && contextKey) state.recordContext(instanceId, contextKey, tier, toolName);
    if (tier >= 3 && contextKey) {
      const recent = state.recentActions(3, 10, windowMs);
      const sameContext = recent.filter(e => e.contextKey === contextKey);
      const otherRecent = recent.filter(e => e.contextKey !== contextKey);

      if (sameContext.length > 0) {
        // Same context key was recently acted on — block to force awareness
        const last = sameContext[sameContext.length - 1];
        const ago = Math.round((Date.now() - new Date(last.timestamp).getTime()) / 60000);

        const lines: string[] = [];
        lines.push(`[Callosum] Before proceeding, review recent actions:`);
        lines.push(``);
        lines.push(`SAME CONTEXT: "${contextKey}"`);
        for (const e of sameContext) {
          const m = Math.round((Date.now() - new Date(e.timestamp).getTime()) / 60000);
          lines.push(`  - ${m}m ago by ${e.instance}: ${e.tool}`);
        }
        if (otherRecent.length > 0) {
          lines.push(``);
          lines.push(`OTHER RECENT ACTIONS:`);
          for (const e of otherRecent.slice(-5)) {
            const m = Math.round((Date.now() - new Date(e.timestamp).getTime()) / 60000);
            lines.push(`  - ${m}m ago by ${e.instance}: ${e.tool} (${e.contextKey || "—"})`);
          }
        }
        lines.push(``);
        lines.push(`If this is intentionally different, retry. Otherwise, skip it.`);

        state.appendJournal({ timestamp: new Date().toISOString(), instance: instanceId, tool: toolName, tier, ruleName, contextKey, action: "blocked", conflict: `same context acted on ${ago}m ago` });
        return { block: true, blockReason: lines.join("\n") };
      }

      // No same-context match — proceed, but acquire lock
      const c = state.checkConflicts(instanceId, contextKey, tier);
      if (c.hasConflict && tier >= 4) {
        state.appendJournal({ timestamp: new Date().toISOString(), instance: instanceId, tool: toolName, tier, ruleName, contextKey, action: "blocked", conflict: `lock held by ${c.conflictWith}` });
        return { block: true, blockReason: `[Callosum] ${c.conflictWith} holds lock on "${contextKey}".` };
      }
      state.acquireLock(instanceId, contextKey, tier);
    }
    return undefined;
  });

  // after_tool_call
  api.on("after_tool_call", (event: any, _ctx: any) => {
    const { toolName, params = {}, error } = event;
    const { tier, contextKey, ruleName } = engine.classify(toolName, params);
    if (tier >= 3 && contextKey) {
      const action = error ? "failed" : "complete";
      state.appendJournal({ timestamp: new Date().toISOString(), instance: instanceId, tool: toolName, tier, ruleName, contextKey, action });
      state.releaseLock(instanceId, contextKey);
    }
  });

  // RPC
  api.registerGatewayMethod("callosum.status", ({ respond }: any) => { respond(true, { instanceId, ruleCount: engine.ruleCount, ...state.getStatus() }); });
  api.registerGatewayMethod("callosum.journal", ({ respond, params }: any) => { respond(true, { entries: state.getJournal(params?.limit || 50) }); });
}
