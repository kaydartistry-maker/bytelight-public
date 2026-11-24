import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from './db/init.js';
import { handleMessageSend } from './ws.js';
test('native WS exact retries return the durable receipt without dispatch or mutation', async () => {
  const db = initDb(':memory:');
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO threads(id,name,type,created_at,last_activity_at) VALUES ('t','test','named',?,?)").run(now,now);
    db.prepare("INSERT INTO messages(id,thread_id,sequence,role,content,content_type,metadata,reply_to_id,created_at,client_id) VALUES ('m','t',1,'user','hello','text',?,NULL,?,'client')").run(JSON.stringify({prosody:{tone:'soft'},attachments:['file']}),now);
    const frames: Record<string,unknown>[] = [];
    const ws = {send:(raw:string)=>frames.push(JSON.parse(raw))} as unknown as Parameters<typeof handleMessageSend>[1];
    const agent = new Proxy({}, {get(){throw new Error('Inference must not be dispatched for retries');}}) as Parameters<typeof handleMessageSend>[2];
    const message = {type:'message' as const,clientId:'client',threadId:'t',content:'hello',contentType:'text' as const,metadata:{attachments:['file'],prosody:{tone:'soft'}}};
    await handleMessageSend(message,ws,agent);
    assert.deepEqual(frames.pop(),{type:'message_ack',clientId:'client',messageId:'m',threadId:'t',status:'duplicate'});
    for (const changed of [{content:'changed'},{threadId:'other'},{replyToId:'other'},{metadata:{attachments:['other']}}]) {
      await handleMessageSend({...message,...changed},ws,agent);
      const error = frames.pop(); assert.equal(error?.type,'error'); assert.equal(error?.code,'client_id_conflict');
    }
    assert.equal((db.prepare('SELECT count(*) n FROM messages').get() as {n:number}).n,1);
  } finally { db.close(); }
});
