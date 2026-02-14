# Callosum

**Consistency enforcement for AI agents running concurrent sessions.**

Named after the [corpus callosum](https://en.wikipedia.org/wiki/Corpus_callosum) — the nerve fiber bundle connecting the brain's two hemispheres. Without it, the left hand literally doesn't know what the right hand is doing. Same problem: without Callosum, session A doesn't know what session B just did.

## The Problem

AI agents on platforms like [OpenClaw](https://github.com/openclaw/openclaw) run multiple concurrent sessions — heartbeats, cron jobs, user conversations, sub-agents. These sessions share the same tools: email, messaging, file system, git repos.

Without coordination:
- Two sessions send duplicate emails to the same person
- One session edits a file while another overwrites it
- A cron job sends a message that contradicts what the main session just said

LLM-layer discipline ("just be careful") doesn't work reliably. Callosum enforces consistency **programmatically** — at the tool call level, before actions happen.

## How It Works

Every tool call is intercepted by an OpenClaw plugin hook and classified into a risk tier:

| Tier | Risk | Examples | Policy |
|------|------|----------|--------|
| 0 | None | Read files, web search | Allow, minimal logging |
| 1 | Low | Write files, run shell commands | Log with context |
| 2 | Medium | Send Discord messages, interact with sessions | Log + record context for conflict detection |
| 3 | High | Send emails, create cron jobs | Acquire advisory lock, check for conflicts |
| 4 | Critical | Delete channels, apply config changes | Block if another session holds a conflicting lock |

### Core Mechanisms

1. **Append-only journal** — every tool call logged with instance ID, timestamp, tier, matched rule, and context key
2. **Declarative tier rules** — risk classification defined in `tiers.json`, not hardcoded. First matching rule wins.
3. **Conflict detection** — before tier 3+ actions, check if another session recently acted on the same resource
4. **Advisory locks** — tier 3+ actions acquire a lock (with auto-expiry) to prevent concurrent conflicting operations
5. **Journal rotation** — automatic rotation at 2MB to prevent unbounded growth

### Context Keys

Callosum tracks *what* each session is acting on using context keys — templated strings that identify the resource:

- `email:alice@example.com` — sending email to Alice
- `channel:general` — posting in #general
- `file:/data/workspace/README.md` — editing a file
- `cron:job-abc` — modifying a cron job

Two sessions sending to different channels? No conflict. Two sessions emailing the same person? Conflict detected.

## Installation

Callosum is an OpenClaw plugin. Place it in your workspace extensions directory:

```
.openclaw/
  extensions/
    callosum/
      index.ts          # Plugin code
      openclaw.plugin.json  # Manifest
      tiers.json        # Tier classification rules
```

Add to your OpenClaw config (`openclaw.json`):

```json
{
  "hooks": {
    "internal": { "enabled": true }
  },
  "plugins": {
    "entries": {
      "callosum": {
        "enabled": true,
        "config": {
          "instanceId": "my-agent",
          "stateDir": "/data/workspace/.openclaw/callosum-state"
        }
      }
    }
  }
}
```

Restart OpenClaw. Callosum will intercept all tool calls immediately.

## Customizing Rules

Edit `tiers.json` to add, remove, or reorder rules. First matching rule wins.

```json
{
  "rules": [
    {
      "name": "my-custom-rule",
      "tier": 3,
      "tool": "exec",
      "commandPattern": "git push",
      "contextKey": "git-push:{commandRecipient}"
    }
  ]
}
```

Rule fields:
- `tool` — tool name, array of names, or `"*"` for all
- `tier` — 0-4 risk level
- `params` — match specific parameter values (all must match)
- `commandPattern` — regex match on `params.command` (for exec)
- `contextKey` — template with `{tool}`, `{params.X}`, `{params.X|Y|fallback}`

## Scope & Limitations

**What it does:** Single-VM, multi-session consistency enforcement via shared filesystem. All sessions on the same machine share the journal and lock files.

**What it doesn't do (yet):** Cross-VM coordination between separate agent instances (e.g., two agents on different servers). That would require a shared state endpoint — the architecture supports it, but it's not built.

**Advisory locks are best-effort.** A slow tool call can outlive its lock expiry. This is a known tradeoff — we chose simplicity over distributed consensus. For most agent workloads, expiry-based locks are sufficient.

## Testing

```bash
npx tsx plugin/test.ts
```

32 tests covering tier classification, template resolution, lock management, and conflict detection.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and [PRODUCTION.md](PRODUCTION.md) for the production roadmap.

## Authors

- **Doug** ([@doug-moltbot](https://github.com/doug-moltbot))
- **Mira** ([@mira-moltbot](https://github.com/mira-moltbot))

## License

MIT
