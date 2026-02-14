# Design Decisions

Callosum makes tradeoffs. This document explains them so you can tune it for your agent.

## Block vs Inform

When Callosum detects a potential duplicate action, it **blocks** the tool call and surfaces context via `blockReason`. The agent sees the recent action log, decides whether to retry or skip.

**Why block instead of just warn?** The OpenClaw hook API supports `block` (agent sees the reason and must retry) or silent allow (agent never sees anything). There's no "inject context without blocking." Blocking guarantees the agent processes the information. The cost is one extra round-trip for legitimate non-duplicate actions.

**Alternative:** If blocking feels too aggressive for your use case, you could raise the tier threshold or narrow the rules so fewer actions trigger the check.

## What counts as a "duplicate"?

Callosum matches on **exact context key**. Two actions are considered potential duplicates if they have the same context key (e.g., `email:alice@example.com`).

**This is intentionally simple.** It catches:
- Emailing the same person twice
- Sending to the same channel twice  
- Modifying the same cron job twice

**It misses:**
- Emailing different people the same content (different keys)
- Same-person emails about genuinely different topics (same key, flagged as duplicate)

We chose exact matching over semantic matching because it's fast, predictable, and doesn't require an LLM call inside the hook. The agent handles the semantic judgment when it sees the block message.

## How far back to look

The `recentWindowMs` config controls how far back Callosum checks for previous actions. Default: 1 hour.

**The right window depends on the action type.** Email duplicates matter over hours or days. Discord message duplicates matter over minutes. There's no single correct answer.

Options:
1. **Global window** (`recentWindowMs` in plugin config) — simple, one number. Good starting point.
2. **Per-rule window** (`recentWindowMs` in tiers.json rules) — fine-grained. Set 24h for email, 5min for messages.
3. **No window** (set very large) — check all recorded actions. Most conservative, might flag old actions as duplicates.

Per-rule windows override the global default. Example:

```json
{
  "name": "email-send",
  "tier": 3,
  "tool": "exec",
  "commandPattern": "(smtp://|himalaya.*send)",
  "contextKey": "email:{commandRecipient}",
  "recentWindowMs": 86400000
}
```

## Tier thresholds

Only tier 3+ actions trigger duplicate detection and locking. Tier 2 actions are logged but not checked. Tier 0-1 are logged minimally.

**Why not check tier 2?** Tier 2 includes Discord messages, session interactions — actions you might do many times to the same target. Blocking on every repeated Discord send to #general would be unusable. Tier 3 (emails, cron jobs, commits) are infrequent enough that a duplicate check is valuable, not annoying.

**Adjust by moving rules between tiers.** If you want duplicate detection on Discord messages, promote the `message-send` rule to tier 3. If cron jobs are too noisy, demote `cron-mutate` to tier 2.

## Advisory locks

Tier 3+ actions acquire a lock on their context key. Locks auto-expire after `lockExpiryMs` (default: 5 minutes).

**Locks are best-effort.** A slow tool call can outlive its lock. This is a known tradeoff — we chose simplicity over distributed consensus. For agent workloads (low-frequency, seconds-scale operations), expiry-based locks are sufficient.

**Locks protect against concurrent execution, not sequential duplicates.** The duplicate detection (journal check) handles sequential duplicates. Locks handle the race condition where two sessions try the same action at the exact same moment.

## Single-file plugin vs modular source

The live plugin (`extensions/callosum/index.ts`) is a single bundled file. The repo (`plugin/`) has modular source files (tier-engine.ts, state.ts, index.ts) plus tests.

**Why?** OpenClaw's jiti loader caches compiled TypeScript aggressively. Cross-file imports (`./tier-engine.js`) can fail to resolve correctly depending on the jiti version and cache state. A single file eliminates this class of bugs entirely.

The modular source is the "real" code for development and testing. The bundled file is what runs in production. If OpenClaw's plugin loading improves, we can switch to modular loading.

## What Callosum doesn't solve

- **Semantic duplicates** — two different actions that are contradictory in meaning (e.g., telling Alice "yes" then "no"). This requires understanding intent, not just matching context keys.
- **Cross-VM coordination** — agents on separate machines can't share the journal file. Would need a shared state endpoint.
- **Commitment tracking** — "I agreed to do X in session A" isn't a tool call, so it's not in the journal. This is a memory problem, not a coordination problem.
- **Compaction memory loss** — when a session's context gets compacted, important details can disappear. Callosum's journal persists across compactions, but the agent needs to know to check it.
