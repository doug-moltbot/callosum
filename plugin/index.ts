/**
 * Callosum Protocol — OpenClaw Plugin
 * Programmatic consistency enforcement for multi-agent coordination.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

// --- Tier Classification ---
type Tier = 0 | 1 | 2 | 3 | 4;

interface TierRule {
  tier: Tier;
  match: (tool: string, params: Record<string, unknown>) => boolean;
  contextKey?: (tool: string, params: Record<string, unknown>) => string | null;
}

const TIER_RULES: TierRule[] = [
  // Tier 4: Irreversible
  {
    tier: 4,
    match: (t, p) =>
      (t === "message" && p.action === "channel-delete") ||
      (t === "message" && p.action === "category-delete") ||
      (t === "gateway" && (p.action === "config.apply" || p.action === "update.run")),
    contextKey: (t, p) => `${t}:${p.action}`,
  },
  // Tier 3: Commitments
  {
    tier: 3,
    match: (t, p) =>
      t === "exec" &&
      typeof p.command === "string" &&
      (p.command.includes("smtp://") || (p.command.includes("himalaya") && p.command.includes("send"))),
    contextKey: (_t, p) => {
      const cmd = String(p.command || "");
      const rcptMatch = cmd.match(/--mail-rcpt\s+'?([^'\s]+)/);
      return rcptMatch ? `email:${rcptMatch[1]}` : "email:unknown";
    },
  },
  {
    tier: 3,
    match: (t, p) => t === "cron" && (p.action === "add" || p.action === "update"),
    contextKey: (_t, p) => `cron:${(p as any).jobId || "new"}`,
  },
  // Tier 2: Routine external
  {
    tier: 2,
    match: (t, p) =>
      t === "message" &&
      ["send", "edit", "react", "thread-reply", "thread-create", "poll"].includes(String(p.action)),
    contextKey: (_t, p) => `channel:${p.target || p.channel || "unknown"}`,
  },
  {
    tier: 2,
    match: (t) => t === "sessions_send" || t === "sessions_spawn",
    contextKey: (_t, p) => `session:${(p as any).sessionKey || (p as any).label || "unknown"}`,
  },
  // Tier 1: Internal writes
  {
    tier: 1,
    match: (t) => ["write", "edit"].includes(t),
    contextKey: (_t, p) => `file:${(p as any).path || (p as any).file_path || "unknown"}`,
  },
  {
    tier: 1,
    match: (t) => t === "exec",
    contextKey: () => null,
  },
  // Tier 0: Everything else
  {
    tier: 0,
    match: () => true,
    contextKey: () => null,
  },
];

function classify(tool: string, params: Record<string, unknown>): { tier: Tier; contextKey: string | null } {
  for (const rule of TIER_RULES) {
    if (rule.match(tool, params)) {
      return { tier: rule.tier, contextKey: rule.contextKey?.(tool, params) ?? null };
    }
  }
  return { tier: 0, contextKey: null };
}

// --- State Management ---
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
  contextKey: string | null;
  action: "intercept" | "complete" | "blocked";
  params_summary?: string;
  conflict?: string;
}

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
      const locks: Lock[] = JSON.parse(readFileSync(this.locksPath(), "utf-8"));
      return locks.filter((l) => l.expiresAt > Date.now());
    } catch { return []; }
  }

  private writeLocks(locks: Lock[]) {
    writeFileSync(this.locksPath(), JSON.stringify(locks, null, 2));
  }

  private readContexts(): ContextEntry[] {
    try {
      const entries: ContextEntry[] = JSON.parse(readFileSync(this.contextsPath(), "utf-8"));
      return entries.filter((e) => e.timestamp > Date.now() - 30 * 60 * 1000);
    } catch { return []; }
  }

  private writeContexts(entries: ContextEntry[]) {
    writeFileSync(this.contextsPath(), JSON.stringify(entries, null, 2));
  }

  appendJournal(entry: JournalEntry) {
    appendFileSync(this.journalPath(), JSON.stringify(entry) + "\n");
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
    return { locks: this.readLocks(), recentContexts: this.readContexts() };
  }
}

function summarizeParams(params: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.length > 100) safe[k] = v.slice(0, 80) + "…";
    else safe[k] = v;
  }
  return JSON.stringify(safe);
}

// --- Plugin Entry ---
export default function register(api: any) {
  const cfg = api.pluginConfig ?? {};
  const stateDir = cfg.stateDir || join(api.config?.agents?.defaults?.workspace || "/data/workspace", ".openclaw", "callosum-state");
  const lockExpiryMs = cfg.lockExpiryMs || 300_000;
  const instanceId = cfg.instanceId || api.config?.agentName || "unknown";

  const state = new CallosumState(stateDir, lockExpiryMs);
  const log = api.logger ?? { info: console.log, warn: console.warn, error: console.error };

  log.info(`[callosum] Plugin loaded. instance=${instanceId}, stateDir=${stateDir}`);

  // Write debug marker
  try {
    writeFileSync(join(stateDir, "_loaded.txt"), `Loaded at ${new Date().toISOString()}\ninstance=${instanceId}\n`);
  } catch {}

  // --- before_tool_call hook (typed hook system via api.on) ---
  api.on("before_tool_call", (event: any, _ctx: any) => {
    // Debug: write proof the hook fired
    try { appendFileSync(join(stateDir, "_hook_fired.txt"), `${new Date().toISOString()} before_tool_call: ${event?.toolName}\n`); } catch {}
    const { toolName, params } = event;
    const { tier, contextKey } = classify(toolName, params || {});

    // Log everything
    state.appendJournal({
      timestamp: new Date().toISOString(),
      instance: instanceId,
      tool: toolName,
      tier,
      contextKey,
      action: "intercept",
      params_summary: tier >= 2 ? summarizeParams(params || {}) : undefined,
    });

    // Tier 2+: record context
    if (tier >= 2 && contextKey) {
      state.recordContext(instanceId, contextKey, tier, toolName);
    }

    // Tier 3+: check conflicts
    if (tier >= 3 && contextKey) {
      const conflict = state.checkConflicts(instanceId, contextKey, tier);
      if (conflict.hasConflict) {
        if (tier >= 4) {
          state.appendJournal({
            timestamp: new Date().toISOString(),
            instance: instanceId,
            tool: toolName,
            tier,
            contextKey,
            action: "blocked",
            conflict: `Blocked by ${conflict.conflictWith}${(conflict as any).locked ? " (locked)" : ""}`,
          });
          return {
            block: true,
            blockReason: `[Callosum] Conflict: ${conflict.conflictWith} has an active action on "${contextKey}". Tier ${tier} action blocked.`,
          };
        }
        log.warn(`[callosum] Tier 3 conflict: ${conflict.conflictWith} on "${contextKey}"`);
      }
      state.acquireLock(instanceId, contextKey, tier);
    }

    return undefined;
  });

  // --- after_tool_call hook (typed hook system via api.on) ---
  api.on("after_tool_call", (event: any, _ctx: any) => {
    const { toolName, params } = event;
    const { tier, contextKey } = classify(toolName, params || {});

    if (tier >= 3 && contextKey) {
      state.appendJournal({
        timestamp: new Date().toISOString(),
        instance: instanceId,
        tool: toolName,
        tier,
        contextKey,
        action: "complete",
      });
      state.releaseLock(instanceId, contextKey);
    }
  });

  // --- Gateway RPC ---
  api.registerGatewayMethod("callosum.status", ({ respond }: any) => {
    respond(true, state.getStatus());
  });

  api.registerGatewayMethod("callosum.journal", ({ respond, params }: any) => {
    try {
      const journalPath = join(stateDir, "journal.jsonl");
      if (!existsSync(journalPath)) { respond(true, { entries: [] }); return; }
      const lines = readFileSync(journalPath, "utf-8").trim().split("\n");
      const limit = params?.limit || 50;
      const entries = lines.slice(-limit).map((l: string) => JSON.parse(l));
      respond(true, { entries });
    } catch (err: any) {
      respond(false, { error: err.message });
    }
  });

  log.info(`[callosum] Initialization complete. Hooks registered, RPC methods ready.`);
}
