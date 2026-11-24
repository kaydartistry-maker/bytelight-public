import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from './db/init.js';
import { isPreservedCloudThread, assertNativeThreadWritable } from './native-history.js';
import { leaseTurn } from './db/turn-leases.js';
import { recoverCutOffTurns, handleMessageSend } from './ws.js';
import { editMessage, createMessage } from './db/messages.js';
import { deleteThread } from './db/threads.js';
import { loadConfig } from '../config.js';
import { AgentService } from './agent.js';

test('native restoration reads legacy evidence without creating bridge tables or blocking new threads', () => {
  const db = initDb(':memory:');
  try {
    assert.equal(isPreservedCloudThread('native'), false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='letta_chat_threads'").get(), undefined);
    db.exec('CREATE TABLE letta_chat_threads(thread_id TEXT PRIMARY KEY); INSERT INTO letta_chat_threads VALUES (\'old\')');
    assert.equal(isPreservedCloudThread('old'), true);
    assert.equal(isPreservedCloudThread('native'), false);
    assert.throws(() => assertNativeThreadWritable('old'), /legacy_history_read_only/);
    assert.doesNotThrow(() => assertNativeThreadWritable('native'));
  } finally { db.close(); }
});

test('preserved Cloud history cannot dispatch, mutate, delete, or replay an old turn lease', async () => {
  loadConfig(`${process.cwd()}/.job-tmp/nonexistent-native-history-test-config`);
  const db = initDb(':memory:');
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO threads(id,name,type,created_at,last_activity_at) VALUES ('old','Preserved','named',?,?)").run(now, now);
    db.prepare("INSERT INTO messages(id,thread_id,sequence,role,content,content_type,created_at) VALUES ('m','old',1,'user','original','text',?)").run(now);
    db.exec('CREATE TABLE letta_chat_threads(thread_id TEXT PRIMARY KEY); INSERT INTO letta_chat_threads VALUES (\'old\')');
    const frames: Array<{ code?: string }> = [];
    let dispatches = 0;
    const agent = { processMessage: async () => { dispatches++; } } as unknown as Parameters<typeof recoverCutOffTurns>[0];
    const ws = { send: (text: string) => frames.push(JSON.parse(text)) } as unknown as Parameters<typeof handleMessageSend>[1];
    await handleMessageSend({ type: 'message', threadId: 'old', content: 'retry', contentType: 'text', clientId: 'fresh' }, ws, agent);
    assert.equal(frames[0]?.code, 'legacy_history_read_only');
    assert.throws(() => editMessage('m', 'replacement', now), /legacy_history_read_only/);
    assert.throws(() => deleteThread('old'), /legacy_history_read_only/);
    assert.throws(() => createMessage({ id: 'new', threadId: 'old', role: 'user', content: 'gateway append', createdAt: now }), /legacy_history_read_only/);
    const nativeAgent = new AgentService();
    await assert.rejects(nativeAgent.processMessage('old', 'direct gateway dispatch'), /legacy_history_read_only/);
    await assert.rejects(nativeAgent.processAutonomous('old', 'scheduled wake'), /legacy_history_read_only/);
    leaseTurn({ threadId: 'old', userMessageId: 'm', prompt: 'must never replay' });
    await recoverCutOffTurns(agent);
    assert.equal(dispatches, 0);
    assert.equal((db.prepare('SELECT content FROM messages WHERE id = ?').get('m') as { content: string }).content, 'original');
    assert.equal((db.prepare('SELECT count(*) AS n FROM turn_leases').get() as { n: number }).n, 0);
  } finally { db.close(); }
});
