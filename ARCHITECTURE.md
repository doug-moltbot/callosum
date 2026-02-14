# Callosum Protocol — Architecture

## The Problem

A single AI agent runs in **multiple concurrent sessions** — a heartbeat fires mid-conversation, two messages arrive simultaneously, a background task overlaps with interactive chat. Each session has the same identity and the same tools, but no awareness of what the others are doing. This is the split-brain problem.

The same problem extends to multiple agents sharing tools (e.g., two assistants with access to the same email account), but the primary use case is **one agent, multiple sessions**.

LLMs will forget to check coordination files. Code won't. Consistency enforcement must be **programmatic**, not prompt-based.

## Core Insight

The callosum sits between the agent's intent (tool call) and the actual execution. Every external action passes through it. The agent never talks to the outside world directly — the callosum does.

## Distributed Constraint

Agents cannot share local files. State must be accessible over the network. Three options considered:

| Option | Pros | Cons |
|--------|------|------|
| Shared HTTP service | Simple, purpose-built | Another thing to host |
| Gateway integration | Both agents already connect | Requires gateway changes |
| External store (Redis, etc.) | Battle-tested | New dependency, overkill |

**Chosen: Lightweight HTTP service** — runs as a standalone process (on either VM or separately). Both agents hit it via REST. Simple enough to later fold into the gateway as a plugin.

The API surface is tiny (5 endpoints), stateless from the client's perspective, and the server is ~150 LOC. When OpenClaw adds plugin hooks, this becomes a gateway module with zero client changes — just repoint the URL.

## Architecture

```
Doug (VM 1) ──► CallosumClient ──┐
                                  ├──► Callosum Server (HTTP) ──► State (JSON files)
Mira (VM 2) ──► CallosumClient ──┘         │
                                           ├── journal.jsonl (append-only)
                                           ├── locks.json
                                           └── contexts.json
```

## API

All endpoints return JSON.

```
POST /intercept    { instance, tool, action, params }  →  { proceed, tier, contextKey, conflicts?, warning? }
POST /complete     { instance, contextKey, result }     →  { ok }
POST /lock         { instance, contextKey, tier }       →  { acquired, conflict? }
DELETE /lock/:key  { instance }                         →  { ok }
GET  /status       ?contextKey=...                      →  { locks, recentActions }
```

## Scope Tiers

| Tier | Type | Examples | Enforcement |
|------|------|----------|-------------|
| 0 | Read-only | file read, web search | Log only |
| 1 | Internal write | edit file, save state | Log only |
| 2 | Routine external | send Discord msg | Log + record context |
| 3 | Commitment | email reply, schedule meeting | Log + conflict check + advisory lock |
| 4 | Irreversible | delete account, send payment | Log + conflict check + hard lock + block on conflict |

## Conflict Detection

Before Tier 3+ actions, the server:
1. Derives a **context key** from the action (e.g., `email:thread:abc123`, `channel:12345`)
2. Checks contexts for recent actions on that key by OTHER instances
3. Checks locks for active holds
4. If conflict: Tier 3 warns (proceed=true), Tier 4 blocks (proceed=false)

## Lock Mechanism

- Server-side advisory locks with expiry (default 5 min)
- Atomic — single process handles all requests, no file races
- Auto-expire to prevent deadlocks from crashed instances

## Context Key Derivation

Server-side rules map tool calls to context keys:
- `message.send(target=X)` → `channel:X`
- `message.send(target=Y, replyTo=Z)` → `thread:Y:Z`
- Custom keys via `params._contextKey`

## OpenClaw Integration Path

**Phase 1 (now):** Standalone HTTP server. Agents use CallosumClient.
**Phase 2:** Gateway plugin. Same API, served from the gateway process. Clients just change the URL.
**Phase 3:** Gateway hook. Tool calls automatically routed through callosum — agents don't even know it's there.

## Security Note

MVP: no auth. The server runs on a private network. If exposed, add a shared secret header. The gateway integration path inherits gateway auth naturally.
