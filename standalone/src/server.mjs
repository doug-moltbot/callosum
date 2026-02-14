/**
 * Callosum Server — Lightweight HTTP service for cross-VM coordination
 * 
 * Runs on one VM, both agents hit it via REST.
 * Tiny: 5 endpoints, ~150 LOC, no dependencies beyond Node stdlib.
 */

import http from 'http';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const STATE_DIR = process.env.CALLOSUM_STATE || join(process.cwd(), 'state');
const PORT = parseInt(process.env.CALLOSUM_PORT || '7700');
const LOCK_TTL = 300_000; // 5 min
const CONFLICT_WINDOW = 600_000; // 10 min

mkdirSync(STATE_DIR, { recursive: true });

// --- State files ---
const journalPath = join(STATE_DIR, 'journal.jsonl');
const locksPath = join(STATE_DIR, 'locks.json');
const contextsPath = join(STATE_DIR, 'contexts.json');

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// --- Tier Classification ---
const TIER_RULES = [
  { tier: 0, match: (t, a) => ['read', 'search', 'snapshot', 'status', 'list'].includes(a) || ['web_search', 'web_fetch', 'memory_search', 'memory_get'].includes(t) },
  { tier: 1, match: (t, a) => ['write', 'edit'].includes(t) },
  { tier: 4, match: (t, a, p) => a === 'delete' || p?._irreversible },
  { tier: 3, match: (t, a, p) => p?._commitment || (t === 'message' && a === 'send' && p?.replyTo) },
  { tier: 2, match: (t) => ['message', 'nodes', 'tts'].includes(t) },
];

function classifyTier(tool, action, params = {}) {
  if (params._tier !== undefined) return params._tier;
  for (const r of TIER_RULES) if (r.match(tool, action, params)) return r.tier;
  return 1;
}

function deriveContextKey(tool, action, params = {}) {
  if (params._contextKey) return params._contextKey;
  if (tool === 'message') {
    const target = params.target || params.channel || 'unknown';
    return params.replyTo ? `thread:${target}:${params.replyTo}` : `channel:${target}`;
  }
  return `${tool}:${action}`;
}

// --- Lock management ---
function cleanLocks(locks) {
  const now = Date.now();
  for (const [k, v] of Object.entries(locks)) {
    if (v.expires < now) delete locks[k];
  }
  return locks;
}

// --- Handlers ---
function handleIntercept(body) {
  const { instance, tool, action, params = {} } = body;
  if (!instance || !tool || !action) return { error: 'missing instance, tool, or action', status: 400 };

  const tier = classifyTier(tool, action, params);
  const contextKey = deriveContextKey(tool, action, params);
  const entry = { id: randomUUID().slice(0, 12), instance, timestamp: Date.now(), tool, action, tier, contextKey };

  // Always journal
  appendFileSync(journalPath, JSON.stringify(entry) + '\n');

  // Tier 0-2: pass through
  if (tier <= 2) return { proceed: true, tier, contextKey };

  // Tier 3-4: check conflicts
  const contexts = readJSON(contextsPath, {});
  const history = (contexts[contextKey] || []).filter(e => e.timestamp > Date.now() - CONFLICT_WINDOW && e.instance !== instance);
  
  const locks = cleanLocks(readJSON(locksPath, {}));
  const activeLock = locks[contextKey];
  const lockedByOther = activeLock && activeLock.holder !== instance && activeLock.expires > Date.now();

  const hasConflict = history.length > 0 || lockedByOther;

  if (hasConflict && tier === 4) {
    appendFileSync(journalPath, JSON.stringify({ ...entry, status: 'BLOCKED', conflicts: history }) + '\n');
    return { proceed: false, tier, contextKey, blocked: true, conflicts: history, activeLock: lockedByOther ? activeLock : null };
  }

  // Acquire lock
  if (!lockedByOther) {
    locks[contextKey] = { holder: instance, acquired: Date.now(), expires: Date.now() + LOCK_TTL, tier };
    writeJSON(locksPath, locks);
  }

  return {
    proceed: true,
    tier,
    contextKey,
    warning: hasConflict || undefined,
    conflicts: hasConflict ? history : undefined,
    locked: !lockedByOther,
  };
}

function handleComplete(body) {
  const { instance, contextKey, result = 'ok' } = body;
  if (!instance || !contextKey) return { error: 'missing instance or contextKey', status: 400 };

  // Record in contexts
  const contexts = readJSON(contextsPath, {});
  if (!contexts[contextKey]) contexts[contextKey] = [];
  contexts[contextKey].push({ instance, timestamp: Date.now(), result });
  if (contexts[contextKey].length > 50) contexts[contextKey] = contexts[contextKey].slice(-50);
  writeJSON(contextsPath, contexts);

  // Release lock if held by this instance
  const locks = cleanLocks(readJSON(locksPath, {}));
  if (locks[contextKey]?.holder === instance) delete locks[contextKey];
  writeJSON(locksPath, locks);

  // Journal
  appendFileSync(journalPath, JSON.stringify({ instance, contextKey, result, timestamp: Date.now(), status: 'completed' }) + '\n');

  return { ok: true };
}

function handleStatus(query) {
  const locks = cleanLocks(readJSON(locksPath, {}));
  const contexts = readJSON(contextsPath, {});
  
  if (query.contextKey) {
    return {
      contextKey: query.contextKey,
      lock: locks[query.contextKey] || null,
      recentActions: (contexts[query.contextKey] || []).slice(-10),
    };
  }
  return { locks, contextCount: Object.keys(contexts).length };
}

function handleReleaseLock(body) {
  const { instance, contextKey } = body;
  const locks = cleanLocks(readJSON(locksPath, {}));
  if (locks[contextKey]?.holder === instance) {
    delete locks[contextKey];
    writeJSON(locksPath, locks);
    return { ok: true, released: true };
  }
  return { ok: false, error: 'not lock holder' };
}

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS for cross-VM
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && url.pathname === '/status') {
    const query = Object.fromEntries(url.searchParams);
    return respond(res, handleStatus(query));
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/lock/')) {
    const contextKey = decodeURIComponent(url.pathname.slice(6));
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        respond(res, handleReleaseLock({ instance: data.instance, contextKey }));
      } catch (e) { respond(res, { error: e.message }, 400); }
    });
    return;
  }

  if (req.method !== 'POST') {
    return respond(res, { error: 'method not allowed' }, 405);
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      let result;
      switch (url.pathname) {
        case '/intercept': result = handleIntercept(data); break;
        case '/complete': result = handleComplete(data); break;
        case '/lock': {
          const locks = cleanLocks(readJSON(locksPath, {}));
          const { instance, contextKey, tier = 3 } = data;
          if (locks[contextKey] && locks[contextKey].holder !== instance && locks[contextKey].expires > Date.now()) {
            result = { acquired: false, conflict: locks[contextKey] };
          } else {
            locks[contextKey] = { holder: instance, acquired: Date.now(), tier, expires: Date.now() + LOCK_TTL };
            writeJSON(locksPath, locks);
            result = { acquired: true };
          }
          break;
        }
        case '/release': result = handleReleaseLock(data); break;
        default: return respond(res, { error: 'not found' }, 404);
      }
      respond(res, result);
    } catch (e) {
      respond(res, { error: e.message }, 400);
    }
  });
});

function respond(res, data, status) {
  const code = data?.status || status || 200;
  if (data?.status) delete data.status;
  res.writeHead(code);
  res.end(JSON.stringify(data));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🧠 Callosum server listening on :${PORT}`);
  console.log(`   State: ${STATE_DIR}`);
});
