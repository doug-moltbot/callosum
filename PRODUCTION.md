# Callosum → Production: What It Would Actually Take

## Current State
Working MVP: HTTP server (~150 LOC) + client (~60 LOC). Tier classification, conflict detection, locking all work. Not wired into anything real.

## The Integration Problem
The whole point is that enforcement can't be at the LLM layer. The agent shouldn't be able to skip the check. Three realistic paths:

---

### Path 1: OpenClaw Plugin (Most Realistic)

OpenClaw plugins can register **agent tools** and **gateway RPC methods**, running in-process with the gateway. Both agents already connect to the same gateway.

**How it works:**
1. Build a plugin that registers a `callosum` tool (like `cron` or `message`)
2. The plugin maintains callosum state in the gateway process (in-memory + persisted to disk)
3. Agents call `callosum.intercept` before external actions, `callosum.complete` after
4. The gateway is the single source of truth — both Doug and Mira hit the same process

**What's needed:**
- Write a TypeScript plugin following OpenClaw's plugin SDK (`HOOK.md` + manifest + handler)
- Register RPC methods: `callosum.intercept`, `callosum.complete`, `callosum.status`, `callosum.release`
- State stored in gateway's data dir (survives restarts)
- Install via `openclaw plugins install` or workspace plugin dir

**Still relies on LLM discipline?** Partially — the agent still has to *call* the callosum tool. But the tool itself enforces the logic. The agent can't call `message.send` *through* the callosum and skip the check.

**Gap:** Agents can still call `message.send` directly, bypassing callosum. To truly enforce it, we'd need...

---

### Path 2: OpenClaw Hook — Tool Pre-Execution (Ideal, Doesn't Exist Yet)

OpenClaw hooks fire on events like `command:new`, `gateway:startup`, etc. There's a `tool_result_persist` hook that transforms tool results. But there's no **`tool:pre-execute`** hook — one that fires before a tool call runs and can block it.

**If this existed:**
1. Every tool call would pass through the hook before execution
2. The hook checks callosum state
3. If conflict on Tier 3+: inject a warning into the tool result or block entirely
4. The agent literally cannot bypass it — it's gateway-level middleware

**What's needed:**
- An OpenClaw core change: add `tool:pre-execute` event to the hook system
- The hook receives `{ tool, action, params, sessionKey }` and can return `{ proceed: false, message: "blocked by callosum" }`
- We'd write a hook that implements the callosum logic
- PR to OpenClaw or feature request

**This is the real answer.** But it requires an OpenClaw core change.

---

### Path 3: Hybrid — Plugin + Agent Instructions (Pragmatic)

Combine Path 1 with strong agent-level instructions:

1. **Plugin** provides the callosum tool (shared state via gateway)
2. **AGENTS.md** instructs: "Before ANY Tier 3+ action, call `callosum.intercept`. This is mandatory."
3. **HEARTBEAT.md** includes callosum status check
4. **Audit**: Periodically diff the decision journal against actual tool calls to detect bypasses

**Why this is pragmatic:**
- The plugin handles the hard part (shared state, conflict detection, locking)
- Agent instructions handle the "call it before acting" part (imperfect but usually works)
- Audit catches when it doesn't
- No OpenClaw core changes needed

**Gap:** An agent can still forget/skip the check. But the audit trail makes bypasses visible. And "usually enforced + auditable" is a huge step up from "hope the LLM remembers."

---

## Recommended Path

**Phase 1 (now):** Path 3 — build the plugin, add instructions, start using it
**Phase 2 (later):** Propose `tool:pre-execute` hook to OpenClaw → Path 2

## Effort Estimate

| Component | Effort | Notes |
|-----------|--------|-------|
| OpenClaw plugin (TypeScript) | ~2 days | Follow plugin SDK, register RPC methods |
| State persistence | ~1 day | JSON files in gateway data dir |
| Agent instructions (AGENTS.md etc) | ~1 hour | Already know what to write |
| Audit script | ~1 day | Compare journal vs actual tool calls |
| OpenClaw PR for pre-execute hook | ~1 week+ | Core change, needs buy-in from maintainers |

## The Honest Assessment

The callosum *concept* is sound. The MVP *code* works. The gap is integration:
- **Plugin path**: Feasible now, but agents can bypass it (enforcement is advisory)
- **Hook path**: True enforcement, but requires OpenClaw core changes
- **Hybrid**: Best near-term option — mostly enforced, auditable, no core changes

The force-push incident wouldn't have been prevented by any of these — that was a direct `exec` call, not a tool the callosum would intercept. True Tier 4 enforcement for arbitrary shell commands is an even harder problem (sandboxing, not just coordination).
