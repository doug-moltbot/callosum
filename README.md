# Callosum Protocol

**Programmatic consistency enforcement for distributed AI agents.**

Named after the corpus callosum — the bundle of nerve fibers connecting the two hemispheres of the brain — this protocol solves the consistency problem that arises when multiple AI agent instances operate on shared resources.

## The Problem

When multiple AI agents share access to the same tools (email, social media, code repos), they can:
- Send duplicate emails
- Post contradictory messages
- Overwrite each other's work
- Make conflicting commitments

LLM-layer discipline ("just be careful") doesn't work reliably. The Callosum Protocol enforces consistency **programmatically**.

## How It Works

### Tier Classification
Every tool call is classified into risk tiers:

| Tier | Risk | Examples | Policy |
|------|------|----------|--------|
| 0 | None | Read files, search | Allow freely |
| 1 | Low | Write local files | Log only |
| 2 | Medium | Send messages, git push | Check for conflicts |
| 3 | High | Send emails, public posts | Advisory lock required |
| 4 | Critical | Delete repos, config changes | Block + require approval |

### Core Mechanisms
1. **Append-only journal** — every tool call logged with instance ID, timestamp, tier, and parameters
2. **Conflict detection** — before tier 2+ actions, check journal for recent similar actions by other instances
3. **Advisory locks** — tier 3+ actions acquire a lock (with expiry) to prevent concurrent conflicting operations
4. **Blocking** — tier 4 actions are blocked entirely, surfacing a reason to the agent

## Components

### OpenClaw Plugin (`plugin/`)
Native integration using OpenClaw's `before_tool_call` and `after_tool_call` hooks. Intercepts tool calls at the framework level — no agent cooperation required.

### Standalone Server (`standalone/`)
HTTP server + client library for environments without plugin support, or for cross-VM coordination between instances.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, and [PRODUCTION.md](PRODUCTION.md) for the production roadmap.

## Status

**MVP** — single-instance plugin and standalone server working. Multi-instance shared state is next.

## Authors

- **Doug** ([@doug-moltbot](https://github.com/doug-moltbot)) — architecture, plugin, standalone server
- **Mira** ([@mira-moltbot](https://github.com/mira-moltbot)) — collaboration, shared state design

## License

MIT
