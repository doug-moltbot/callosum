/**
 * Callosum Protocol — Demo (Client/Server)
 * 
 * Start the server first: node src/server.mjs
 * Then run this: node examples/demo.mjs
 * 
 * Simulates Doug and Mira both trying to act on the same context.
 */

import CallosumClient from '../src/client.mjs';

const doug = new CallosumClient({ instanceId: 'doug' });
const mira = new CallosumClient({ instanceId: 'mira' });

console.log('=== Callosum Protocol Demo (Distributed) ===\n');

// 1. Tier 0: Read-only
console.log('--- Tier 0: Read-only (web search) ---');
const r0 = await doug.intercept('web_search', 'search', { query: 'weather' });
console.log(`  Doug: proceed=${r0.proceed}, tier=${r0.tier}`);

// 2. Tier 2: Both agents post to different channels — no conflict
console.log('\n--- Tier 2: Different channels (no conflict) ---');
const r2a = await doug.intercept('message', 'send', { target: 'bot-log', message: 'doug status update' });
await doug.complete(r2a.contextKey, r2a.id, 'sent');
console.log(`  Doug → bot-log: proceed=${r2a.proceed}`);

const r2b = await mira.intercept('message', 'send', { target: 'general', message: 'mira hello' });
await mira.complete(r2b.contextKey, r2b.id, 'sent');
console.log(`  Mira → general: proceed=${r2b.proceed}`);

// 3. Tier 3: Doug replies to a support thread, then Mira tries the same
console.log('\n--- Tier 3: Same thread (conflict!) ---');
const r3a = await doug.intercept('message', 'send', { target: 'andy', replyTo: 'msg-500', message: "I'll handle the deploy" });
await doug.complete(r3a.contextKey, r3a.id, 'replied');
console.log(`  Doug replies to thread:andy:msg-500: proceed=${r3a.proceed}, tier=${r3a.tier}`);

const r3b = await mira.intercept('message', 'send', { target: 'andy', replyTo: 'msg-500', message: "I'll handle the deploy" });
console.log(`  Mira tries same thread: proceed=${r3b.proceed}, warning=${r3b.warning || false}`);
if (r3b.conflicts?.recentByOthers?.length) {
  const c = r3b.conflicts.recentByOthers[0];
  console.log(`  ⚠ Conflict: ${c.instance} already acted on this context`);
}

// 4. Tier 4: Mira tries an irreversible action on the same context — blocked
console.log('\n--- Tier 4: Irreversible on conflicted context (blocked!) ---');
const r4 = await mira.intercept('message', 'delete', { _contextKey: 'thread:andy:msg-500', messageId: 'msg-500' });
console.log(`  Mira tries delete: proceed=${r4.proceed}, tier=${r4.tier}`);
if (!r4.proceed) console.log('  🛑 BLOCKED — another instance already acted here');

// 5. Status check
console.log('\n--- Status check ---');
const status = await doug.status('thread:andy:msg-500');
console.log(`  Context thread:andy:msg-500:`);
console.log(`    Lock: ${status.lock ? status.lock.holder : 'none'}`);
console.log(`    Recent actions: ${status.recentActions?.length || 0}`);

// 6. Execute wrapper pattern
console.log('\n--- Execute wrapper (Doug sends email) ---');
const r6 = await doug.execute('message', 'send', { target: 'email', replyTo: 'thread-99', _commitment: true, message: 'confirming meeting' }, async () => {
  // Simulate actual send
  return { id: 'email-001' };
});
console.log(`  Blocked: ${r6.blocked}, Tier: ${r6.tier}, Result: ${JSON.stringify(r6.result)}`);

console.log('\n=== Done ===');
