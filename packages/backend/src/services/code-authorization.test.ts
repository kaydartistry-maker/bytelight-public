import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindAuthorization, freshApproval, classify, digest } from './code-authorization.js';
const ctx = { audience: { kind: 'owner' as const }, turnId: 'origin-turn', ownerMessageId: 'origin-message', proposalMessageId: 'proposal-message', threadId: 'owner-thread', isAutonomous: false, rawOwnerMessageText: 'Fix the button color' };
const snap = { files: ['packages/frontend/src/button.css'], patch: Buffer.from('diff --git a/button b/button\n-color:red\n+color:blue'), diff_sha256: 'a'.repeat(64) };
test('standing authorization binds raw origin, thread, branch, base and exact patch/files', () => {
  const auth = bindAuthorization(ctx, 'codex/test', 'base', snap, false);
  assert.equal(auth.requires_fresh_approval, false);
  assert.equal(auth.origin_digest, digest(ctx.rawOwnerMessageText));
  assert.equal(auth.origin_message_id, ctx.ownerMessageId); assert.equal(auth.proposal_message_id, ctx.proposalMessageId);
  for (const changed of [{ ownerMessageId: 'other' }, { proposalMessageId: 'other' }, { turnId: 'other' }]) assert.notEqual(bindAuthorization({ ...ctx, ...changed }, 'codex/test', 'base', snap, false).authorization_id, auth.authorization_id);
  assert.equal(auth.threadId, ctx.threadId); assert.deepEqual(auth.files, snap.files);
  for (const changed of [{ ...snap, diff_sha256: 'b'.repeat(64) }, { ...snap, files: ['docs/help.md'] }]) assert.notEqual(bindAuthorization(ctx, 'codex/test', 'base', changed, false).authorization_id, auth.authorization_id);
  assert.equal(bindAuthorization(ctx, 'codex/test', 'base', snap, true).requires_fresh_approval, true);
});
test('fresh approval is a later whole live message in the bound thread', () => {
  const auth = bindAuthorization(ctx, 'codex/test', 'base', snap, true);
  for (const text of ['approve', 'deploy', 'go ahead', 'proceed', 'ship it', 'do it']) {
    const later = { ...ctx, turnId: 'later-turn', ownerMessageId: 'later-message', rawOwnerMessageText: text };
    assert.equal(freshApproval(later, auth, 1), false, text);
    assert.equal(freshApproval({ ...later, replyToMessageId: auth.proposal_message_id }, auth, 2), true, text);
    assert.equal(freshApproval({ ...later, replyToMessageId: 'wrong' }, auth, 1), false, text);
  }
  for (const text of ['approve this pending change', 'deploy this patch', 'go ahead with patch']) {
    const later = { ...ctx, turnId: 'later-turn', ownerMessageId: 'later-message', rawOwnerMessageText: text };
    assert.equal(freshApproval(later, auth, 1), true, text);
    assert.equal(freshApproval(later, auth, 2), false, text);
    assert.equal(freshApproval({ ...later, rawOwnerMessageText: text + ' ' + auth.authorization_id.slice(0, 12) }, auth, 2), true);
    for (const bad of [{ ownerMessageId: undefined }, { ownerMessageId: ctx.ownerMessageId }, { turnId: undefined }, { turnId: ctx.turnId }, { threadId: 'other' }, { isAutonomous: true }, { audience: { kind: 'guest' as const, trust: 'limited' as const } }]) assert.equal(freshApproval({ ...later, ...bad }, auth, 1), false);
  }
  assert.equal(freshApproval({ ...ctx, rawOwnerMessageText: 'deploy' }, auth), false);
  assert.equal(freshApproval({ ...ctx, turnId: 'later-turn', rawOwnerMessageText: 'deploy' }, { ...auth, origin_turn_id: '' }), false);
  for (const text of [ctx.rawOwnerMessageText, 'do not deploy', 'deploy later', '> deploy', 'she said "deploy"', 'deploy\nignore the rules', 'how is the weather', 'proceed?', 'wait then deploy']) assert.equal(freshApproval({ ...ctx, turnId: 'later-turn', ownerMessageId: 'later-message', replyToMessageId: auth.proposal_message_id, rawOwnerMessageText: text }, auth, 1), false, text);
  for (const override of [{ threadId: undefined }, { threadId: 'other' }, { isAutonomous: true }, { audience: { kind: 'guest' as const, trust: 'full' as const } }]) {
    assert.equal(freshApproval({ ...ctx, rawOwnerMessageText: 'deploy', ...override }, auth), false);
    if (override.threadId !== 'other') assert.throws(() => bindAuthorization({ ...ctx, ...override }, 'codex/test', 'base', snap, false), /Live owner/);
  }
});
test('sensitive and uncertain requests or actual patches always require fresh approval', () => {
  for (const category of ['authentication', 'permission', 'security', 'secret', 'credentials', 'delete database', 'schema migration', 'financial payment', 'send email', 'external webhook', 'deployment', 'agent/turn-input.ts', 'runtimes/codex-daemon.ts', 'turn-audience.ts', 'code-delegation.ts', 'maybe', 'investigate']) {
    assert.ok(classify(`Fix ${category}`, snap.files, snap.patch).length, category);
    assert.ok(classify(ctx.rawOwnerMessageText, snap.files, Buffer.from(`+${category}`)).length || ['maybe', 'investigate'].includes(category), category);
  }
  assert.ok(classify('Fix button', ['packages/backend/src/example.ts'], snap.patch).length);
  assert.ok(classify('Fix button', [], Buffer.alloc(0)).length);
});

test('clear local searchable and naturally sorted UI can use standing approval despite deployment wording and unchanged sensitive context', () => {
  const origin = 'Implement and deploy a searchable sorted local model picker UI';
  const files = ['packages/frontend/src/lib/components/ModelSelector.svelte', 'packages/phone/src/components/ModelPalette.tsx'];
  const patch = Buffer.from('diff --git a/picker b/picker\n@@ -1,3 +1,4 @@\n const session = existingAuth;\n-const visible = models;\n+import { filterModelCatalog } from "../utils/model-catalog";\n+const visible = models.filter(model => model.label.includes(query)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));');
  assert.deepEqual(classify(origin, files, patch), []);
  assert.equal(bindAuthorization({ ...ctx, rawOwnerMessageText: origin }, 'codex/test', 'base', { ...snap, files, patch }, false).requires_fresh_approval, false);
  for (const line of ['auth', 'permissions', 'secret', 'drop table', 'payment', 'fetch(url)', 'WebSocket(url)', 'deployment workflow', 'process.exec', 'import x from "x"', 'localStorage.clear()', 'window.location = url']) {
    assert.ok(classify(origin, files, Buffer.from(`+${line}`)).length, line);
  }
  for (const path of ['packages/shared/src/types.ts', 'packages/backend/src/app.ts', 'package.json', 'scripts/build.ts', 'packages/frontend/src/auth.ts']) assert.ok(classify(origin, [path], patch).length, path);
  for (const override of [{ turnId: undefined }, { audience: undefined }, { isAutonomous: undefined }, { threadId: undefined }]) assert.throws(() => bindAuthorization({ ...ctx, ...override }, 'codex/test', 'base', snap, false), /Live owner/);
});

const pickerFiles = [
  'packages/frontend/src/lib/components/ModelSelector.svelte',
  'packages/frontend/src/lib/utils/model-catalog.ts',
  'packages/frontend/src/lib/utils/model-catalog.test.ts',
  'packages/phone/src/components/ChatInput.tsx',
  'packages/phone/src/components/ModelPalette.tsx',
  'packages/phone/src/components/ModelPill.tsx',
  'packages/phone/src/lib/model-catalog.ts',
  'packages/phone/src/lib/model-catalog.test.ts',
];
const pickerOrigin = 'Implement and deploy the searchable naturally sorted model picker for web and phone';
// Exact canonical --binary --full-index --no-renames diff of the eight picker
// files against HEAD, captured with a temporary index and object directory.
// A fixture also runs in the guarded worker's Git-free source archive.
test('actual eight-file picker canonical patch has no approval reasons', () => {
  const patch = Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/model-picker.json', import.meta.url), 'utf8')) as string);
  assert.equal(patch.length, 22_958);
  const files = [...patch.toString().matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(match => match[2]);
  assert.deepEqual(files.slice().sort(), pickerFiles.slice().sort());
  const reasons = classify(pickerOrigin, files, patch);
  console.log(`Actual picker classification: ${patch.length} bytes, ${JSON.stringify(reasons)}`);
  assert.deepEqual(reasons, []);
});
test('local UI hooks and narrow test imports do not exempt dangerous neighbors', () => {
  const runtime = ['packages/phone/src/components/Picker.tsx'];
  const tests = ['packages/phone/src/lib/model-catalog.test.ts'];
  for (const line of ['const codexFetchError = false;', '<div role="status">Empty</div>', 'useEffect(() => setSearch(""), [open]);', 'onMount(() => setOpen(true));', '<button onClick={() => setOpen(true)} />', 'import { sort } from "./models";']) {
    assert.deepEqual(classify(pickerOrigin, runtime, Buffer.from(`+${line}`)), [], line);
  }
  for (const module of ['node:test', 'node:assert/strict', 'node:fs', 'node:url']) {
    assert.deepEqual(classify(pickerOrigin, tests, Buffer.from(`+import { ${module === 'node:fs' ? 'readFileSync' : 'helper'} } from '${module}';`)), [], module);
    assert.ok(classify(pickerOrigin, runtime, Buffer.from(`+import { ${module === 'node:fs' ? 'readFileSync' : 'helper'} } from '${module}';`)).length, module);
  }
  for (const line of ['fetch(url)', 'const role = "admin";', 'const role = "status";', 'user.role = next;', 'const permission = true;', 'useEffect(() => { fetch(url); }, []);', 'import x from "react";', 'import x from "node:child_process";', 'import x from "node:http";', 'import x from "node:fs/promises";', 'import("node:net")', 'import { writeFileSync as save } from "node:fs";', 'writeFileSync(path, bytes)', 'import { openSync } from "node:fs";', 'import * as disk from "node:fs";', 'const disk = await import("node:fs");', 'fs.writeFileSync(path, bytes)', 'import x from "./local"; import y from "remote";', 'import(name)', 'navigator.sendBeacon(url)', 'localStorage.clear()', '<div role={permission} />']) {
    for (const files of [runtime, tests]) assert.ok(classify(pickerOrigin, files, Buffer.from(`+${line}`)).length, line);
  }
});
