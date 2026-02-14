/**
 * Callosum Tests
 * 
 * Run: npx tsx plugin/test.ts
 * 
 * Tests TierEngine, CallosumState, and template resolution in isolation.
 * No OpenClaw runtime needed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TierEngine, resolveTemplate, type TierRulesConfig } from "./tier-engine.js";
import { CallosumState } from "./state.js";

// ─── Load default rules ────────────────────────────────────────────────────

const defaultRules: TierRulesConfig = JSON.parse(
  readFileSync(join(__dirname, "tiers.json"), "utf-8")
);

// ═══════════════════════════════════════════════════════════════════════════

describe("TierEngine", () => {
  const engine = new TierEngine(defaultRules);

  describe("tier classification", () => {
    it("classifies channel-delete as tier 4", () => {
      const r = engine.classify("message", { action: "channel-delete" });
      assert.equal(r.tier, 4);
      assert.equal(r.ruleName, "channel-delete");
    });

    it("classifies category-delete as tier 4", () => {
      assert.equal(engine.classify("message", { action: "category-delete" }).tier, 4);
    });

    it("classifies config.apply as tier 4", () => {
      const r = engine.classify("gateway", { action: "config.apply" });
      assert.equal(r.tier, 4);
      assert.equal(r.ruleName, "config-apply");
    });

    it("classifies email send (smtp) as tier 3", () => {
      const r = engine.classify("exec", { command: "curl --url 'smtp://127.0.0.1:1025' --mail-rcpt 'alice@example.com'" });
      assert.equal(r.tier, 3);
      assert.equal(r.ruleName, "email-send");
      assert.equal(r.contextKey, "email:alice@example.com");
    });

    it("classifies himalaya send as tier 3", () => {
      assert.equal(engine.classify("exec", { command: "himalaya message send --to bob@test.com" }).tier, 3);
    });

    it("classifies cron add as tier 3", () => {
      const r = engine.classify("cron", { action: "add" });
      assert.equal(r.tier, 3);
      assert.equal(r.ruleName, "cron-mutate");
    });

    it("classifies message send as tier 2", () => {
      const r = engine.classify("message", { action: "send", target: "general" });
      assert.equal(r.tier, 2);
      assert.equal(r.contextKey, "channel:general");
    });

    it("classifies sessions_send as tier 2", () => {
      const r = engine.classify("sessions_send", { sessionKey: "abc123" });
      assert.equal(r.tier, 2);
      assert.equal(r.contextKey, "session:abc123");
    });

    it("classifies file write as tier 1", () => {
      const r = engine.classify("write", { path: "/data/workspace/test.md" });
      assert.equal(r.tier, 1);
      assert.equal(r.contextKey, "file:/data/workspace/test.md");
    });

    it("classifies general exec as tier 1", () => {
      assert.equal(engine.classify("exec", { command: "ls -la" }).tier, 1);
    });

    it("classifies read as tier 0", () => {
      assert.equal(engine.classify("read", { path: "/some/file" }).tier, 0);
    });

    it("classifies web_search as tier 0", () => {
      assert.equal(engine.classify("web_search", { query: "test" }).tier, 0);
    });

    it("classifies unknown tools as tier 0", () => {
      const r = engine.classify("made_up_tool", {});
      assert.equal(r.tier, 0);
      assert.equal(r.ruleName, "default");
    });
  });

  describe("context key templates", () => {
    it("resolves {params.target} with fallback to channel", () => {
      const r = engine.classify("message", { action: "send", channel: "bot-log" });
      assert.equal(r.contextKey, "channel:bot-log");
    });

    it("falls back to unknown when no params match", () => {
      const r = engine.classify("message", { action: "send" });
      assert.equal(r.contextKey, "channel:unknown");
    });

    it("extracts email recipient from --mail-rcpt", () => {
      const r = engine.classify("exec", { command: "curl --url 'smtp://127.0.0.1:1025' --mail-rcpt 'test@example.com' -T -" });
      assert.equal(r.contextKey, "email:test@example.com");
    });
  });

  describe("rule ordering (first match wins)", () => {
    it("email exec matches tier 3 before general exec tier 1", () => {
      assert.equal(engine.classify("exec", { command: "curl --url 'smtp://localhost:1025'" }).tier, 3);
    });

    it("channel-delete matches tier 4 before message send tier 2", () => {
      assert.equal(engine.classify("message", { action: "channel-delete" }).tier, 4);
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
          { name: "multi", tier: 2, tool: ["read", "write", "edit"] },
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

  it("resolves {params.X}", () => {
    assert.equal(resolveTemplate("{params.action}", "msg", { action: "send" }), "send");
  });

  it("resolves fallback chain", () => {
    assert.equal(resolveTemplate("{params.target|params.channel|unknown}", "msg", { channel: "general" }), "general");
  });

  it("falls back to literal", () => {
    assert.equal(resolveTemplate("{params.target|fallback}", "msg", {}), "fallback");
  });

  it("falls back to unknown", () => {
    assert.equal(resolveTemplate("{params.x|params.y}", "msg", {}), "unknown");
  });

  it("resolves commandRecipient", () => {
    assert.equal(resolveTemplate("email:{commandRecipient}", "exec", { command: "--mail-rcpt 'a@b.com'" }), "email:a@b.com");
  });
});

describe("CallosumState", () => {
  let tmpDir: string;
  let state: CallosumState;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "callosum-test-"));
    state = new CallosumState(tmpDir, 300_000);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires and releases locks", () => {
    assert.equal(state.acquireLock("doug", "email:alice@test.com", 3), true);
    assert.equal(state.readLocks().length, 1);
    state.releaseLock("doug", "email:alice@test.com");
    assert.equal(state.readLocks().length, 0);
  });

  it("blocks conflicting locks from different instances", () => {
    assert.equal(state.acquireLock("doug", "email:bob@test.com", 3), true);
    assert.equal(state.acquireLock("mira", "email:bob@test.com", 3), false);
    state.releaseLock("doug", "email:bob@test.com");
    assert.equal(state.acquireLock("mira", "email:bob@test.com", 3), true);
    state.releaseLock("mira", "email:bob@test.com");
  });

  it("allows same instance to refresh lock", () => {
    assert.equal(state.acquireLock("doug", "cron:job1", 3), true);
    assert.equal(state.acquireLock("doug", "cron:job1", 3), true);
    assert.equal(state.readLocks().length, 1);
    state.releaseLock("doug", "cron:job1");
  });

  it("detects conflicts between instances", () => {
    state.acquireLock("doug", "channel:general", 3);
    const result = state.checkConflicts("mira", "channel:general", 3);
    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictWith, "doug");
    state.releaseLock("doug", "channel:general");
  });

  it("no conflict for same instance", () => {
    state.acquireLock("doug", "channel:general", 3);
    assert.equal(state.checkConflicts("doug", "channel:general", 3).hasConflict, false);
    state.releaseLock("doug", "channel:general");
  });

  it("expired locks are cleaned up", () => {
    const shortState = new CallosumState(tmpDir, 1); // 1ms expiry
    shortState.acquireLock("doug", "email:test@test.com", 3);
    const start = Date.now();
    while (Date.now() - start < 10) {} // wait for expiry
    assert.equal(shortState.readLocks().length, 0);
    assert.equal(shortState.acquireLock("mira", "email:test@test.com", 3), true);
    shortState.releaseLock("mira", "email:test@test.com");
  });

  it("appends and reads journal entries", () => {
    state.appendJournal({
      timestamp: new Date().toISOString(),
      instance: "doug",
      tool: "exec",
      tier: 1,
      ruleName: "exec-general",
      contextKey: null,
      action: "intercept",
    });
    const entries = state.getJournal(10);
    assert.ok(entries.length >= 1);
    assert.equal(entries[entries.length - 1].tool, "exec");
  });
});

console.log("\n🧪 Running Callosum tests...\n");
