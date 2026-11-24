import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@bytelight/shared';
import { sameMessageEnvelope } from './message-envelope.js';
test('clientId retry accepts only the original complete envelope', () => {
  const existing = {role:'user',thread_id:'t',content:'hello',content_type:'text',reply_to_id:'reply',metadata:{attachments:['file'],prosody:{tone:'soft'}}} as unknown as Message;
  const msg = {type:'message' as const,threadId:'t',content:'hello',contentType:'text' as const,replyToId:'reply',metadata:{prosody:{tone:'soft'},attachments:['file']}};
  assert.equal(sameMessageEnvelope(existing,msg),true);
  for (const change of [{threadId:'other'},{content:'changed'},{contentType:'image' as const},{replyToId:'other'},{metadata:{attachments:['different']}}]) assert.equal(sameMessageEnvelope(existing,{...msg,...change}),false);
});
