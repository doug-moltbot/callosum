/**
 * Callosum Plugin Tests
 * 
 * Run: npx tsx plugin/test.ts
 * 
 * Tests the core logic (TierEngine, CallosumState) in isolation —
 * no OpenClaw runtime needed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── We need to extract testable pieces from index.ts. Since the plugin
//    inlines everything, we'll import the module and test via its exports.
//    For now, duplicate the key classes here for testing. In production,
//    these would be separate modules.

// ─── TierEngine (duplicated for test isolation) ────────────────────────────

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
      if (!alt.includes(".")) return alt;
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

// ─── Load the default tiers.json ───────────────────────────────────────────

const defaultRules: TierRulesConfig = JSON.parse(
  readFileSync(join(__dirname, "tiers.json"), "utf-8")
);

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("TierEngine", () => {
  const engine = new TierEngine(defaultRules);

  describe("tier classification", () => {
    it("classifies channel-delete as tier 4", () => {
      const result = engine.classify("message", { action: "channel-delete" });
      assert.equal(result.tier, 4);
      assert.equal(result.ruleName, "channel-delete");
    });

    it("classifies category-delete as tier 4", () => {
      const result = engine.classify("message", { action: "category-delete" });
      assert.equal(result.tier, 4);
    });

    it("classifies config.apply as tier 4", () => {
      const result = engine.classify("gateway", { action: "config.apply" });
      assert.equal(result.tier, 4);
      assert.equal(result.ruleName, "config-apply");
    });

    it("classifies email send (smtp) as tier 3", () => {
      const result = engine.classify("exec", { command: "curl --url 'smtp://127.0.0.1:1025' --mail-rcpt 'alice@example.com'" });
      assert.equal(result.tier, 3);
      assert.equal(result.ruleName, "email-send");
      assert.equal(result.contextKey, "email:alice@example.com");
    });

    it("classifies himalaya send as tier 3", () => {
      const result = engine.classify("exec", { command: "himalaya message send --to bob@test.com" });
      assert.equal(result.tier, 3);
      assert.equal(result.ruleName, "email-send");
    });

    it("classifies cron add as tier 3", () => {
      const result = engine.classify("cron", { action: "add" });
      assert.equal(result.tier, 3);
      assert.equal(result.ruleName, "cron-mutate");
    });

    it("classifies message send as tier 2", () => {
      const result = engine.classify("message", { action: "send", target: "general" });
      assert.equal(result.tier, 2);
      assert.equal(result.ruleName, "message-send");
      assert.equal(result.contextKey, "channel:general");
    });

    it("classifies sessions_send as tier 2", () => {
      const result = engine.classify("sessions_send", { sessionKey: "abc123" });
      assert.equal(result.tier, 2);
      assert.equal(result.contextKey, "session:abc123");
    });

    it("classifies file write as tier 1", () => {
      const result = engine.classify("write", { path: "/data/workspace/test.md" });
      assert.equal(result.tier, 1);
      assert.equal(result.contextKey, "file:/data/workspace/test.md");
    });

    it("classifies general exec as tier 1", () => {
      const result = engine.classify("exec", { command: "ls -la" });
      assert.equal(result.tier, 1);
      assert.equal(result.ruleName, "exec-general");
    });

    it("classifies read as tier 0 (default)", () => {
      const result = engine.classify("read", { path: "/some/file" });
      assert.equal(result.tier, 0);
      assert.equal(result.ruleName, "default");
    });

    it("classifies web_search as tier 0", () => {
      const result = engine.classify("web_search", { query: "test" });
      assert.equal(result.tier, 0);
    });

    it("classifies unknown tools as tier 0", () => {
      const result = engine.classify("made_up_tool", {});
      assert.equal(result.tier, 0);
      assert.equal(result.ruleName, "default");
    });
  });

  describe("context key templates", () => {
    it("resolves {params.target} with fallback", () => {
      const result = engine.classify("message", { action: "send", channel: "bot-log" });
      assert.equal(result.contextKey, "channel:bot-log");
    });

    it("falls back to 'unknown' when no params match", () => {
      const result = engine.classify("message", { action: "send" });
      assert.equal(result.contextKey, "channel:unknown");
    });

    it("extracts email recipient from --mail-rcpt", () => {
      const result = engine.classify("exec", {
        command: "curl --url 'smtp://127.0.0.1:1025' --mail-rcpt 'test@example.com' -T -"
      });
      assert.equal(result.contextKey, "email:test@example.com");
    });
  });

  describe("rule ordering (first match wins)", () => {
    it("email exec matches tier 3 before general exec tier 1", () => {
      const result = engine.classify("exec", { command: "curl --url 'smtp://localhost:1025'" });
      assert.equal(result.tier, 3);
      assert.equal(result.ruleName, "email-send");
    });

    it("message channel-delete matches tier 4 before message send tier 2", () => {
      const result = engine.classify("message", { action: "channel-delete" });
      assert.equal(result.tier, 4);
    });
  });

  describe("custom rules", () => {
    it("supports user-defined rules", () => {
      const custom = new TierEngine({
        rules: [
          { name: "block-browser", tier: 4, tool: "browser", contextKey: "browser" },
          { name: "allow-all", tier: 0, tool: "*" },
        ],
      });
      assert.equal(custom.classify("browser", {}).tier, 4);
      assert.equal(custom.classify("read", {}).tier, 0);
      assert.equal(custom.ruleCount, 2);
    });

    it("handles array tool matching", () => {
      const custom = new TierEngine({
        rules: [
          { name: "multi-tool", tier: 2, tool: ["read", "write", "edit"] },
          { name: "default", tier: 0, tool: "*" },
        ],
      });
      assert.equal(custom.classify("read", {}).tier, 2);
      assert.equal(custom.classify("write", {}).tier, 2);
      assert.equal(custom.classify("exec", {}).tier, 0);
    });
  });
});

describe("resolveTemplate", () => {
  it("resolves {tool}", () => {
    assert.equal(resolveTemplate("{tool}:test", "exec", {}), "exec:test");
  });

  it("resolves {params.X} with value", () => {
    assert.equal(resolveTemplate("{params.action}", "msg", { action: "send" }), "send");
  });

  it("resolves fallback chain", () => {
    assert.equal(
      resolveTemplate("{params.target|params.channel|unknown}", "msg", { channel: "general" }),
      "general"
    );
  });

  it("falls back to literal", () => {
    assert.equal(
      resolveTemplate("{params.target|fallback}", "msg", {}),
      "fallback"
    );
  });

  it("falls back to unknown when nothing matches", () => {
    assert.equal(
      resolveTemplate("{params.x|params.y}", "msg", {}),
      "unknown"
    );
  });

  it("resolves commandRecipient", () => {
    assert.equal(
      resolveTemplate("email:{commandRecipient}", "exec", { command: "--mail-rcpt 'a@b.com'" }),
      "email:a@b.com"
    );
  });
});

describe("CallosumState", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "callosum-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Inline a minimal CallosumState for testing
  class TestState {
    private stateDir: string;
    private lockExpiryMs: number;

    constructor(stateDir: string, lockExpiryMs = 300_000) {
      this.stateDir = stateDir;
      this.lockExpiryMs = lockExpiryMs;
    }

    private locksPath() { return join(this.stateDir, "locks.json"); }

    readLocks(): any[] {
      try {
        return (JSON.parse(readFileSync(this.locksPath(), "utf-8")) as any[])
          .filter((l: any) => l.expiresAt > Date.now());
      } catch { return []; }
    }

    writeLocks(locks: any[]) {
      writeFileSync(this.locksPath(), JSON.stringify(locks, null, 2));
    }

    acquireLock(instance: string, contextKey: string, tier: number): boolean {
      const locks = this.readLocks();
      const existing = locks.find((l: any) => l.contextKey === contextKey);
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

    releaseLock(instance: string, contextKey: string) {
      const locks = this.readLocks();
      this.writeLocks(locks.filter((l: any) => !(l.contextKey === contextKey && l.instance === instance)));
    }

    checkConflicts(instance: string, contextKey: string) {
      const locks = this.readLocks();
      const conflict = locks.find((l: any) => l.contextKey === contextKey && l.instance !== instance);
      return conflict ? { hasConflict: true, conflictWith: conflict.instance } : { hasConflict: false };
    }
  }

  it("acquires and releases locks", () => {
    const state = new TestState(tmpDir);
    assert.equal(state.acquireLock("doug", "email:alice@test.com", 3), true);
    assert.equal(state.readLocks().length, 1);
    state.releaseLock("doug", "email:alice@test.com");
    assert.equal(state.readLocks().length, 0);
  });

  it("blocks conflicting locks from different instances", () => {
    const state = new TestState(tmpDir);
    assert.equal(state.acquireLock("doug", "email:bob@test.com", 3), true);
    assert.equal(state.acquireLock("mira", "email:bob@test.com", 3), false);
    state.releaseLock("doug", "email:bob@test.com");
    assert.equal(state.acquireLock("mira", "email:bob@test.com", 3), true);
    state.releaseLock("mira", "email:bob@test.com");
  });

  it("allows same instance to re-acquire (refresh) lock", () => {
    const state = new TestState(tmpDir);
    assert.equal(state.acquireLock("doug", "cron:job1", 3), true);
    assert.equal(state.acquireLock("doug", "cron:job1", 3), true);
    assert.equal(state.readLocks().length, 1);
    state.releaseLock("doug", "cron:job1");
  });

  it("detects conflicts between instances", () => {
    const state = new TestState(tmpDir);
    state.acquireLock("doug", "channel:general", 3);
    const result = state.checkConflicts("mira", "channel:general");
    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictWith, "doug");
    state.releaseLock("doug", "channel:general");
  });

  it("no conflict when same instance", () => {
    const state = new TestState(tmpDir);
    state.acquireLock("doug", "channel:general", 3);
    const result = state.checkConflicts("doug", "channel:general");
    assert.equal(result.hasConflict, false);
    state.releaseLock("doug", "channel:general");
  });

  it("expired locks are cleaned up", () => {
    const state = new TestState(tmpDir, 1); // 1ms expiry
    state.acquireLock("doug", "email:test@test.com", 3);
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 10) {} // spin wait 10ms
    assert.equal(state.readLocks().length, 0);
    // Now mira can acquire
    assert.equal(state.acquireLock("mira", "email:test@test.com", 3), true);
    state.releaseLock("mira", "email:test@test.com");
  });
});

console.log("\n🧪 Running Callosum tests...\n");
