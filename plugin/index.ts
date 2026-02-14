/**
 * Callosum Protocol — OpenClaw Plugin
 * 
 * Consistency enforcement for distributed agent instances.
 * Intercepts every tool call via before_tool_call / after_tool_call hooks,
 * classifies by risk tier, logs to an append-only journal, detects
 * conflicts, and blocks dangerous concurrent actions.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { TierEngine, type TierRulesConfig } from "./tier-engine.js";
import { CallosumState, type JournalEntry } from "./state.js";

// ─── Default rules (fallback if tiers.json not found) ──────────────────────

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

  // Load tier rules
  let engine: TierEngine;
  const tiersPath = join(dirname(api.source || __filename), "tiers.json");
  try {
    if (existsSync(tiersPath)) {
      const rulesConfig = JSON.parse(readFileSync(tiersPath, "utf-8")) as TierRulesConfig;
      engine = new TierEngine(rulesConfig);
      log.info(`[callosum] Loaded ${engine.ruleCount} tier rules from ${tiersPath}`);
    } else {
      engine = new TierEngine(DEFAULT_RULES);
      log.info(`[callosum] Using ${engine.ruleCount} built-in default rules`);
    }
  } catch (err) {
    log.warn(`[callosum] Failed to load tiers.json, using defaults: ${err}`);
    engine = new TierEngine(DEFAULT_RULES);
  }

  log.info(`[callosum] Ready. instance=${instanceId}, stateDir=${stateDir}`);

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
            conflict: `Blocked: ${conflict.conflictWith}${conflict.locked ? " (locked)" : ""}`,
          });
          return {
            block: true,
            blockReason: `[Callosum] Conflict: ${conflict.conflictWith} holds lock on "${contextKey}". Tier ${tier} action blocked.`,
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
}
