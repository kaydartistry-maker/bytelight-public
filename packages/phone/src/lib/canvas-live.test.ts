import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFrameToEditor,
  applyFrameToList,
  canAutoSave,
  editDraft,
  emptyEchoes,
  markContentSent,
  markTagsSent,
  normalizeTag,
  openEditor,
  pendingSaveFields,
  takeIncoming,
  type CanvasDoc,
} from './canvas-live.js';

function doc(over: Partial<CanvasDoc> = {}): CanvasDoc {
  return {
    id: 'c1',
    title: 'Plan',
    content: 'v1',
    content_type: 'markdown',
    language: null,
    tags: ['ideas'],
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
    ...over,
  };
}

const upd = (content: string, extra: { title?: string; tags?: string[] } = {}) => ({
  type: 'canvas_updated' as const,
  canvasId: 'c1',
  content,
  updatedAt: '2026-10-24T01:00:00.000Z',
  ...extra,
});

test('list: created prepends once, updated patches, deleted drops, list replaces', () => {
  const a = doc();
  const b = doc({ id: 'c2', title: 'Other' });
  let list = applyFrameToList([a], { type: 'canvas_created', canvas: b });
  assert.deepEqual(list.map((c) => c.id), ['c2', 'c1']);
  assert.equal(applyFrameToList(list, { type: 'canvas_created', canvas: b }), list);
  list = applyFrameToList(list, upd('v2', { tags: ['x'] }));
  assert.equal(list[1].content, 'v2');
  assert.deepEqual(list[1].tags, ['x']);
  assert.equal(list[1].title, 'Plan');
  list = applyFrameToList(list, { type: 'canvas_deleted', canvasId: 'c2' });
  assert.deepEqual(list.map((c) => c.id), ['c1']);
  assert.deepEqual(applyFrameToList(list, { type: 'canvas_list', canvases: [b] }), [b]);
});

test('normalizeTag matches classic cleanup', () => {
  assert.equal(normalizeTag('  Ideas! '), 'ideas');
  assert.equal(normalizeTag('Big Plan-2'), 'bigplan-2');
  assert.equal(normalizeTag('✨'), '');
});

test('editor: no unsaved typing → a companion edit shows', () => {
  const ed = openEditor(doc());
  const r = applyFrameToEditor(ed, emptyEchoes(), upd('companion text'));
  assert.equal(r.editor!.draft, 'companion text');
  assert.equal(r.editor!.base.content, 'companion text');
  assert.equal(r.editor!.incoming, null);
});

test('editor: unsaved typing is never clobbered; newer body is held and autosave pauses', () => {
  const ed = editDraft(openEditor(doc()), 'v1 plus mine');
  assert.equal(canAutoSave(ed), true);
  const r = applyFrameToEditor(ed, emptyEchoes(), upd('companion text'));
  assert.equal(r.editor!.draft, 'v1 plus mine');
  assert.equal(r.editor!.incoming, 'companion text');
  assert.equal(canAutoSave(r.editor!), false);
  // Save offers only her body; "use latest" swaps to theirs.
  const taken = takeIncoming(r.editor!);
  assert.equal(taken.draft, 'companion text');
  assert.equal(taken.dirty, false);
  assert.deepEqual(pendingSaveFields(taken), {});
});

test('editor: a frame that leaves the body unchanged is not a conflict', () => {
  const ed = editDraft(openEditor(doc()), 'typing');
  const r = applyFrameToEditor(ed, emptyEchoes(), upd('v1', { tags: ['a', 'b'] }));
  assert.equal(r.editor!.incoming, null);
  assert.equal(r.editor!.draft, 'typing');
  assert.deepEqual(r.editor!.draftTags, ['a', 'b']);
});

test('editor: own content echo is ignored, even a stale one', () => {
  let ed = editDraft(openEditor(doc()), 'a');
  let sent = markContentSent(ed, emptyEchoes(), 'a');
  ed = editDraft(sent.editor, 'ab');
  sent = markContentSent(ed, sent.echoes, 'ab');
  ed = editDraft(sent.editor, 'abc');
  // Echo of "a" arrives while she has "abc": no flicker, no conflict.
  const r1 = applyFrameToEditor(ed, sent.echoes, upd('a'));
  assert.equal(r1.editor!.draft, 'abc');
  assert.equal(r1.editor!.incoming, null);
  assert.deepEqual(r1.echoes.contents, ['ab']);
  const r2 = applyFrameToEditor(r1.editor!, r1.echoes, upd('ab'));
  assert.equal(r2.editor!.draft, 'abc');
  assert.deepEqual(r2.echoes.contents, []);
});

test('editor: own tag echo is ignored, including its stale body', () => {
  let ed = openEditor(doc());
  const sent = markTagsSent(ed, emptyEchoes(), ['ideas', 'new']);
  ed = editDraft(sent.editor, 'v1 typed');
  const r = applyFrameToEditor(ed, sent.echoes, upd('v0 stale', { tags: ['ideas', 'new'] }));
  assert.equal(r.editor!.draft, 'v1 typed');
  assert.equal(r.editor!.incoming, null);
  assert.deepEqual(r.echoes.tags, []);
});

test('editor: title mid-rename stays hers; untouched title follows the server', () => {
  const ed = openEditor(doc());
  const followed = applyFrameToEditor(ed, emptyEchoes(), upd('v1', { title: 'New name' }));
  assert.equal(followed.editor!.draftTitle, 'New name');
  const renaming = { ...ed, draftTitle: 'Mine' };
  const kept = applyFrameToEditor(renaming, emptyEchoes(), upd('v1', { title: 'New name' }));
  assert.equal(kept.editor!.draftTitle, 'Mine');
});

test('editor: deleted or missing from a re-sent list closes; other canvases ignored', () => {
  const ed = openEditor(doc());
  assert.equal(applyFrameToEditor(ed, emptyEchoes(), { type: 'canvas_deleted', canvasId: 'c1' }).editor, null);
  assert.equal(applyFrameToEditor(ed, emptyEchoes(), { type: 'canvas_deleted', canvasId: 'zz' }).editor, ed);
  assert.equal(applyFrameToEditor(ed, emptyEchoes(), { ...upd('x'), canvasId: 'zz' }).editor, ed);
  assert.equal(applyFrameToEditor(ed, emptyEchoes(), { type: 'canvas_list', canvases: [] }).editor, null);
  const fromList = applyFrameToEditor(ed, emptyEchoes(), { type: 'canvas_list', canvases: [doc({ content: 'fresh' })] });
  assert.equal(fromList.editor!.draft, 'fresh');
});

test('Save sends only what she changed', () => {
  const ed = openEditor(doc());
  assert.deepEqual(pendingSaveFields(ed), {});
  const typed = editDraft(ed, 'v2');
  assert.deepEqual(pendingSaveFields(typed), { content: 'v2' });
  assert.deepEqual(pendingSaveFields({ ...ed, draftTitle: 'T' }), { title: 'T' });
});
