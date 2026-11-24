import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('full native BL route composition restores removed product features', () => {
 const api = source('./api.ts');
 for (const file of ['canvas-routes','journal','field-notes','treehouse','spotify','gif','theater','spellbook']) {
  assert.equal(existsSync(new URL(`./${file}.ts`, import.meta.url)), true);
  assert.ok(api.includes(`'./${file}.js'`), `${file} mounted`);
 }
 assert.doesNotMatch(api, /createLetta|createChatModelRoutes|messagesOwnerGuard/);
 assert.match(api, /createBuilderRoutes/);
 assert.match(api, /createMemoryRoutes/);
 assert.match(api, /createXrayRoutes/);
 assert.match(api, /studioRouter/); // history images still used by kept Messages
});
test('native chat and startup have no Letta flag or Cloud-session dependency', () => {
 const ws = source('../services/ws.ts');
 assert.doesNotMatch(ws, /BYTELIGHT_LETTA|lettaChatConfig|lettaThreadOwnership|ordinary_chat_unavailable|setLettaChatBridge/);
 assert.match(ws, /agentService\.processMessage/);
 assert.match(ws, /case 'canvas_create'/);
 const server = source('../server.ts');
 assert.doesNotMatch(server, /LettaChatBridge|letta-chat-config/);
 assert.match(server, /migrateSecrets\(\)/);
 assert.match(server, /migrateLegacyCredentialStores\(config\)/);
});
