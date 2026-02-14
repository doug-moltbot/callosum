/**
 * Callosum Protocol — OpenClaw Plugin
 * 
 * Consistency enforcement for distributed agent instances.
 * Intercepts every tool call, classifies by risk tier, logs to an
 * append-only journal, detects conflicts, and blocks dangerous
 * concurrent actions.
 * 
 * Uses declarative tier rules from tiers.json (via TierEngine).
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync, statSync } from "fs";
import { join, dirname } from "path";

// ─── Tier Engine (inline for plugin portability) ───────────────────────────

type Tier = 0 | 1 | 2 | 3 | 4;

interface TierRuleConfig {
  name?: string;
  tier: Tier;
  tool: string | string[];
  params?: Record<string, string | string[]>;
  commandPattern?: string;
  contextKey?: string;
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
}

function compileRule(rule: TierRuleConfig, index: number): CompiledRule {
  const name = rule.name || `rule-${index}`;
  let toolMatch: (t: string) => boolean;
  if (rule.tool === "*") {
    toolMatch = () => true;
  } else if (Array.isArray(rule.tool)) {
    const set = new Set(rule.tool);
    toolMatch = (t) => set.has(t);
  } else {
    toolMatch = (t) => t === rule.tool;
  }

  let paramsMatch: (p: Record<string, unknown>) => boolean;
  if (rule.params) {
    const checks = Object.entries(rule.params).map(([key, expected]) => {
      const values = Array.isArray(expected) ? expected : [expected];
      return (p: Record<string, unknown>) => values.includes(String(p[key] ?? ""));
    });
    paramsMatch = (p) => checks.every((check) => check(p));
  } else {
    paramsMatch = () => true;
  }

  let commandRegex: RegExp | undefined;
  if (rule.commandPattern) {
    commandRegex = new RegExp(rule.commandPattern);
  }

  return { name, tier: rule.tier, toolMatch, paramsMatch, commandRegex, contextKeyTemplate: rule.contextKey };
}

function resolveTemplate(template: string, tool: string, params: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    const alternatives = expr.split("|").map((s: string) => s.trim());
    for (const alt of alternatives) {
      if (alt === "tool") return tool;
      if (alt.startsWith("params.")) {
        const val = params[alt.slice(7)];
        if (val !== undefined && val !== null && val !== "") return String(val);
        continue;
      }
      if (alt === "commandRecipient") {
        const cmd = String(params.command || "");
        const match = cmd.match(/--mail-rcpt\s+'?([^'\s]+)/) || cmd.match(/--to\s+'?([^'\s]+)/);
        return match ? match[1] : "unknown";
      }
      if (!alt.includes(".")) return alt; // literal fallback
    }
    return "unknown";
  });
}

class TierEngine {
  private rules: CompiledRule[];

  constructor(config: TierRulesConfig) {
    this.rules = config.rules.map((r, i) => compileRule(r, i));
  }

  classify(tool: string, params: Record<string, unknown>): { tier: Tier; contextKey: string | null; ruleName: string } {
    for (const rule of this.rules) {
      if (!rule.toolMatch(tool)) continue;
      if (!rule.paramsMatch(params)) continue;
      if (rule.commandRegex && !rule.commandRegex.test(String(params.command || ""))) continue;
      const contextKey = rule.contextKeyTemplate
        ? resolveTemplate(rule.contextKeyTemplate, tool, params)
        : null;
      return { tier: rule.tier, contextKey, ruleName: rule.name };
    }
    return { tier: 0, contextKey: null, ruleName: "default-fallback" };
  }

  get ruleCount(): number { return this.rules.length; }
}

// ─── Default rules (used if tiers.json not found) ──────────────────────────

const DEFAULT_RULES: TierRulesConfig = {
  description: "Built-in default tier rules",
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

// ─── State Management ──────────────────────────────────────────────────────

interface Lock {
  instance: string;
  contextKey: string;
  tier: Tier;
  acquiredAt: number;
  expiresAt: number;
}

interface ContextEntry {
  instance: string;
  contextKey: string;
  tier: Tier;
  timestamp: number;
  tool: string;
}

interface JournalEntry {
  timestamp: string;
  instance: string;
  tool: string;
  tier: Tier;
  ruleName: string;
  contextKey: string | null;
  action: "intercept" | "complete" | "blocked";
  params_summary?: string;
  conflict?: string;
}

const MAX_JOURNAL_LINES = 10_000;
const JOURNAL_ROTATE_KEEP = 1; // number of old files to keep

class CallosumState {
  private stateDir: string;
  private lockExpiryMs: number;

  constructor(stateDir: string, lockExpiryMs: number) {
    this.stateDir = stateDir;
    this.lockExpiryMs = lockExpiryMs;
    mkdirSync(stateDir, { recursive: true });
  }

  private locksPath() { return join(this.stateDir, "locks.json"); }
  private contextsPath() { return join(this.stateDir, "contexts.json"); }
  private journalPath() { return join(this.stateDir, "journal.jsonl"); }

  private readLocks(): Lock[] {
    try {
      return (JSON.parse(readFileSync(this.locksPath(), "utf-8")) as Lock[])
        .filter((l) => l.expiresAt > Date.now());
    } catch { return []; }
  }

  private writeLocks(locks: Lock[]) {
    writeFileSync(this.locksPath(), JSON.stringify(locks, null, 2));
  }

  private readContexts(): ContextEntry[] {
    try {
      return (JSON.parse(readFileSync(this.contextsPath(), "utf-8")) as ContextEntry[])
        .filter((e) => e.timestamp > Date.now() - 30 * 60 * 1000);
    } catch { return []; }
  }

  private writeContexts(entries: ContextEntry[]) {
    writeFileSync(this.contextsPath(), JSON.stringify(entries, null, 2));
  }

  appendJournal(entry: JournalEntry) {
    const journalPath = this.journalPath();
    appendFileSync(journalPath, JSON.stringify(entry) + "\n");
    this.maybeRotateJournal(journalPath);
  }

  private maybeRotateJournal(journalPath: string) {
    try {
      const stat = statSync(journalPath);
      // Rotate if file exceeds ~2MB (rough proxy for line count, avoids reading the whole file)
      if (stat.size > 2 * 1024 * 1024) {
        const rotated = journalPath + ".1";
        // Remove older rotations
        for (let i = JOURNAL_ROTATE_KEEP; i >= 1; i--) {
          const old = journalPath + `.${i + 1}`;
          try { renameSync(journalPath + `.${i}`, old); } catch {}
        }
        try { renameSync(journalPath + `.${JOURNAL_ROTATE_KEEP + 1}`, "/dev/null"); } catch {}
        renameSync(journalPath, rotated);
      }
    } catch {}
  }

  checkConflicts(instance: string, contextKey: string, tier: Tier) {
    const locks = this.readLocks();
    const lockConflict = locks.find((l) => l.contextKey === contextKey && l.instance !== instance);
    if (lockConflict) return { hasConflict: true, conflictWith: lockConflict.instance, locked: true };
    if (tier >= 3) {
      const contexts = this.readContexts();
      const recent = contexts.find((c) => c.contextKey === contextKey && c.instance !== instance);
      if (recent) return { hasConflict: true, conflictWith: recent.instance };
    }
    return { hasConflict: false };
  }

  acquireLock(instance: string, contextKey: string, tier: Tier): boolean {
    const locks = this.readLocks();
    const existing = locks.find((l) => l.contextKey === contextKey);
    if (existing && existing.instance !== instance) return false;
    if (existing && existing.instance === instance) {
      existing.expiresAt = Date.now() + this.lockExpiryMs;
      this.writeLocks(locks);
      return true;
    }
    locks.push({ instance, contextKey, tier, acquiredAt: Date.now(), expiresAt: Date.now() + this.lockExpiryMs });
    this.writeLocks(locks);
    return true;
  }

  recordContext(instance: string, contextKey: string, tier: Tier, tool: string) {
    const contexts = this.readContexts();
    contexts.push({ instance, contextKey, tier, timestamp: Date.now(), tool });
    this.writeContexts(contexts);
  }

  releaseLock(instance: string, contextKey: string) {
    const locks = this.readLocks();
    this.writeLocks(locks.filter((l) => !(l.contextKey === contextKey && l.instance === instance)));
  }

  getStatus() {
    return {
      locks: this.readLocks(),
      recentContexts: this.readContexts(),
      journalLines: this.countJournalLines(),
    };
  }

  private countJournalLines(): number {
    try {
      return readFileSync(this.journalPath(), "utf-8").trim().split("\n").length;
    } catch { return 0; }
  }

  getJournal(limit: number = 50): JournalEntry[] {
    try {
      const lines = readFileSync(this.journalPath(), "utf-8").trim().split("\n");
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function summarizeParams(params: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.length > 100) safe[k] = v.slice(0, 80) + "…";
    else safe[k] = v;
  }
  return JSON.stringify(safe);
}

// ─── Plugin Entry ──────────────────────────────────────────────────────────

export default function register(api: any) {
  const cfg = api.pluginConfig ?? {};
  const stateDir = cfg.stateDir || join(api.config?.agents?.defaults?.workspace || "/data/workspace", ".openclaw", "callosum-state");
  const lockExpiryMs = cfg.lockExpiryMs || 300_000;
  const instanceId = cfg.instanceId || "unknown";

  const state = new CallosumState(stateDir, lockExpiryMs);
  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  // Load tier rules: try tiers.json next to plugin, fall back to defaults
  let engine: TierEngine;
  const tiersPath = join(dirname(api.source || __filename), "tiers.json");
  try {
    if (existsSync(tiersPath)) {
      const rulesConfig = JSON.parse(readFileSync(tiersPath, "utf-8")) as TierRulesConfig;
      engine = new TierEngine(rulesConfig);
      log.info(`[callosum] Loaded ${engine.ruleCount} tier rules from ${tiersPath}`);
    } else {
      engine = new TierEngine(DEFAULT_RULES);
      log.info(`[callosum] Using ${engine.ruleCount} built-in default tier rules`);
    }
  } catch (err) {
    log.warn(`[callosum] Failed to load tiers.json, using defaults: ${err}`);
    engine = new TierEngine(DEFAULT_RULES);
  }

  log.info(`[callosum] Plugin loaded. instance=${instanceId}, stateDir=${stateDir}`);

  // ── before_tool_call ──
  api.on("before_tool_call", (event: any, _ctx: any) => {
    const { toolName, params = {} } = event;
    const { tier, contextKey, ruleName } = engine.classify(toolName, params);

    state.appendJournal({
      timestamp: new Date().toISOString(),
      instance: instanceId,
      tool: toolName,
      tier,
      ruleName,
      contextKey,
      action: "intercept",
      params_summary: tier >= 2 ? summarizeParams(params) : undefined,
    });

    if (tier >= 2 && contextKey) {
      state.recordContext(instanceId, contextKey, tier, toolName);
    }

    if (tier >= 3 && contextKey) {
      const conflict = state.checkConflicts(instanceId, contextKey, tier);
      if (conflict.hasConflict) {
        if (tier >= 4) {
          state.appendJournal({
            timestamp: new Date().toISOString(),
            instance: instanceId,
            tool: toolName,
            tier,
            ruleName,
            contextKey,
            action: "blocked",
            conflict: `Blocked: ${conflict.conflictWith}${(conflict as any).locked ? " (locked)" : ""}`,
          });
          return {
            block: true,
            blockReason: `[Callosum] Conflict: ${conflict.conflictWith} has an active lock on "${contextKey}". Tier ${tier} action blocked.`,
          };
        }
        log.warn(`[callosum] Conflict on "${contextKey}" with ${conflict.conflictWith} (tier ${tier}, rule: ${ruleName})`);
      }
      state.acquireLock(instanceId, contextKey, tier);
    }

    return undefined;
  });

  // ── after_tool_call ──
  api.on("after_tool_call", (event: any, _ctx: any) => {
    const { toolName, params = {} } = event;
    const { tier, contextKey, ruleName } = engine.classify(toolName, params);

    if (tier >= 3 && contextKey) {
      state.appendJournal({
        timestamp: new Date().toISOString(),
        instance: instanceId,
        tool: toolName,
        tier,
        ruleName,
        contextKey,
        action: "complete",
      });
      state.releaseLock(instanceId, contextKey);
    }
  });

  // ── Gateway RPC ──
  api.registerGatewayMethod("callosum.status", ({ respond }: any) => {
    respond(true, { instanceId, ruleCount: engine.ruleCount, ...state.getStatus() });
  });

  api.registerGatewayMethod("callosum.journal", ({ respond, params }: any) => {
    respond(true, { entries: state.getJournal(params?.limit || 50) });
  });

  log.info(`[callosum] Ready. ${engine.ruleCount} rules, instance=${instanceId}`);
}
