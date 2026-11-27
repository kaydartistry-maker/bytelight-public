import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';
import { chatReader, claudeKeptPath, htmlToText, JsonArraySplitter, parseCsv, readChatGptChat, readClaudeChat, readExportElements, readGrokChat, readLettaAgent } from './history-readers.js';
import { HOUSE_VOICE, importStatus, previewExport, resetImportStatus, startImport } from './history-import.js';
import { PassageStore, snippetAround } from './history-passages.js';

const dir = mkdtempSync(join(tmpdir(), 'history-import-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const said = (n: number) => `This is message number ${n}, long enough to be worth keeping as a piece.`;

/** A Claude chat where the last assistant turn was regenerated once (m3 abandoned for m4). */
function claudeChat(uuid: string, createdAt: string) {
  return {
    uuid, name: `Chat ${uuid}`, created_at: createdAt,
    chat_messages: [
      { uuid: `${uuid}-m1`, parent_message_uuid: null, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:00:00Z`, content: [{ type: 'text', text: said(1) }] },
      { uuid: `${uuid}-m2`, parent_message_uuid: `${uuid}-m1`, sender: 'assistant', created_at: `${createdAt.slice(0, 10)}T10:01:00Z`, content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: said(2) }] },
      { uuid: `${uuid}-m3`, parent_message_uuid: `${uuid}-m2`, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:02:00Z`, text: 'a draft {that was} "abandoned" ]' },
      { uuid: `${uuid}-m4`, parent_message_uuid: `${uuid}-m2`, sender: 'human', created_at: `${createdAt.slice(0, 10)}T10:03:00Z`, text: said(4) },
    ],
  };
}

/**
 * A ChatGPT chat: hidden custom instructions, a system note, one regenerated
 * answer (a1 abandoned for a2), a tool call and its result, and a cited answer.
 */
function gptChat(id: string, t: number) {
  const node = (nid: string, parent: string | null, message: Record<string, unknown> | null) => ({ id: nid, parent, message, children: [] });
  const msg = (mid: string, role: string, parts: unknown[], extra: Record<string, unknown> = {}) =>
    ({ id: mid, author: { role }, create_time: t + Number(mid.replace(/\D/g, '') || 0), content: { content_type: 'text', parts }, recipient: 'all', ...extra });
  return {
    id, conversation_id: id, title: `GPT ${id}`, create_time: t, current_node: 'n8',
    mapping: {
      root: node('root', null, null),
      n0: node('n0', 'root', msg('sys0', 'system', ['You are ChatGPT.'])),
      n1: node('n1', 'n0', msg('ctx1', 'user', ['My custom instructions'], { content: { content_type: 'user_editable_context', user_profile: 'x' }, metadata: { is_visually_hidden_from_conversation: true } })),
      n2: node('n2', 'n1', msg('u2', 'user', [said(2)])),
      n3a: node('n3a', 'n2', msg('a3', 'assistant', ['An answer that was regenerated away.'])),
      n3: node('n3', 'n2', msg('a4', 'assistant', [said(4)])),
      n5: node('n5', 'n3', msg('u5', 'user', [said(5), { content_type: 'image_asset_pointer' }], { content: { content_type: 'multimodal_text', parts: [said(5), { content_type: 'image_asset_pointer' }] } })),
      n6: node('n6', 'n5', msg('a6', 'assistant', ['search("x")'], { recipient: 'web' })),
      n7: node('n7', 'n6', msg('t7', 'tool', ['results'])),
      n8: node('n8', 'n7', msg('a8', 'assistant', [`${said(8)} \ue200cite\ue202turn0search0\ue201【3†source】`])),
    },
  };
}

const exportJson = JSON.stringify([claudeChat('aaa', '2026-10-07T10:00:00Z'), claudeChat('bbb', '2026-11-02T10:00:00Z')]);

function zipOf(name: string, text: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, zipSync({ [name]: strToU8(text), 'users.json': strToU8('[]') }));
  return path;
}

function jsonOf(text: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, text);
  return path;
}

describe('JsonArraySplitter', () => {
  it('finds each element however the text is cut, with brackets and quotes inside strings', () => {
    const text = '[ {"a":"x]}\\"{"}, {"b":[1,{"c":2}]} ,{"d":"\\\\"} ]';
    for (let size = 1; size <= text.length; size++) {
      const s = new JsonArraySplitter();
      const got: string[] = [];
      for (let i = 0; i < text.length; i += size) got.push(...s.push(text.slice(i, i + size)));
      assert.deepEqual(got.map((g) => JSON.parse(g)), [{ a: 'x]}"{' }, { b: [1, { c: 2 }] }, { d: '\\' }], `cut every ${size}`);
      assert.ok(s.done);
    }
  });

  it('refuses something that is not an array', () => {
    assert.throws(() => new JsonArraySplitter().push('{"a":1}'), /not a JSON array/);
  });
});

describe('reading a Claude export', () => {
  it('keeps the path that was kept and drops the abandoned draft', () => {
    const { path, dropped } = claudeKeptPath(claudeChat('aaa', '2026-10-07T10:00:00Z').chat_messages);
    assert.deepEqual(path.map((m) => m.uuid), ['aaa-m1', 'aaa-m2', 'aaa-m4']);
    assert.equal(dropped, 1);
  });

  it('reads text blocks only, in order, each linked to the one before', () => {
    const chat = readClaudeChat(claudeChat('aaa', '2026-10-07T10:00:00Z'))!;
    assert.deepEqual(chat.lines.map((l) => [l.role, l.text, l.prev]), [
      ['user', said(1), null], ['assistant', said(2), 'aaa-m1'], ['user', said(4), 'aaa-m2'],
    ]);
  });

  it('streams the conversations out of a zip, wherever the file sits in it', async () => {
    const seen: string[] = [];
    await readExportElements(zipOf('data-2026/conversations.json', exportJson), (raw) => seen.push((raw as { uuid: string }).uuid));
    assert.deepEqual(seen, ['aaa', 'bbb']);
  });

  it('reads a bare conversations.json too', async () => {
    const seen: string[] = [];
    await readExportElements(jsonOf(exportJson), (raw) => seen.push((raw as { uuid: string }).uuid));
    assert.deepEqual(seen, ['aaa', 'bbb']);
  });

  it('reads every part of an export split into numbered files', async () => {
    const path = join(dir, 'parts.zip');
    writeFileSync(path, zipSync({
      'conversations-000.json': strToU8(JSON.stringify([claudeChat('aaa', '2026-10-07T10:00:00Z')])),
      'conversations-001.json': strToU8(JSON.stringify([claudeChat('bbb', '2026-11-02T10:00:00Z')])),
      'shared_conversations.json': strToU8('[{"id":"not-this"}]'),
    }));
    const seen: string[] = [];
    await readExportElements(path, (raw) => seen.push((raw as { uuid: string }).uuid));
    assert.deepEqual(seen, ['aaa', 'bbb']);
  });

  it('says so when the zip has no conversations, or the file stops partway', async () => {
    await assert.rejects(readExportElements(zipOf('notes.json', '[]'), () => {}), /no chats in that zip/);
    await assert.rejects(readExportElements(jsonOf(exportJson.slice(0, 200)), () => {}), /ends partway/);
  });
});

describe('reading a ChatGPT export', () => {
  it('keeps only what was said on the branch that was kept', () => {
    const chat = readChatGptChat(gptChat('g1', 1760000000))!;
    assert.deepEqual(chat.lines.map((l) => [l.id, l.role, l.prev]), [
      ['u2', 'user', null], ['a4', 'assistant', 'u2'], ['u5', 'user', 'a4'], ['a8', 'assistant', 'u5'],
    ]);
    assert.equal(chat.dropped, 1);
    assert.equal(chat.title, 'GPT g1');
    assert.equal(chat.startedAt, new Date(1760000000 * 1000).toISOString());
  });

  it('takes the words from a message with a picture, and strips citation markers', () => {
    const chat = readChatGptChat(gptChat('g1', 1760000000))!;
    assert.equal(chat.lines[2].text, said(5));
    assert.equal(chat.lines[3].text, said(8));
  });
});

/** Takeout's Gemini Apps activity, newest first: two prompts in one chat, one with no chat link. */
const geminiRows = [
  { header: 'Gemini Apps', title: 'Prompted and what about the second thing?', time: '2026-10-07T10:05:00.000Z', details: [{ url: 'https://gemini.google.com/app/abc123' }], safeHtmlItem: [{ html: '<p>The second answer &amp; more.</p>' }], products: ['Gemini Apps'] },
  { header: 'Gemini Apps', title: 'Prompted a loose question from another day', time: '2026-09-01T09:00:00.000Z', safeHtmlItem: [{ html: 'Loose<br>answer' }], subtitles: [{ name: '1 generated image.' }] },
  { header: 'Gemini Apps', title: 'Prompted tell me the first thing', time: '2026-10-07T10:00:00.000Z', titleUrl: 'https://gemini.google.com/app/abc123', safeHtmlItem: [{ html: '<ul><li>one</li><li>two</li></ul>' }], subtitles: [{ name: 'Attached 1 file.' }] },
  { header: 'Gemini Apps', title: 'Used Gemini Apps', time: '2026-10-07T09:00:00.000Z' },
];

describe('reading Gemini activity', () => {
  it('gathers the rows back into their chats, oldest first, and keeps loose ones by day', () => {
    const r = chatReader('gemini');
    for (const row of geminiRows) assert.deepEqual(r.take(row), []);
    const chats = r.finish();
    const app = chats.find((c) => c.chat === 'app-abc123')!;
    assert.deepEqual(app.lines.map((l) => [l.role, l.text]), [
      ['user', 'tell me the first thing\n[Attached 1 file]'], ['assistant', '- one\n- two'],
      ['user', 'and what about the second thing?'], ['assistant', 'The second answer & more.'],
    ]);
    assert.equal(app.title, 'tell me the first thing');
    assert.equal(app.lines[1].prev, app.lines[0].id);
    const loose = chats.find((c) => c.chat === 'day-2026-09-01')!;
    assert.deepEqual(loose.lines.map((l) => l.text), ['a loose question from another day', 'Loose\nanswer\n[1 generated image]']);
    assert.equal(chats.length, 2);
  });

  it('gives the same ids every time, so a repeat import adds nothing', () => {
    const ids = () => { const r = chatReader('gemini'); geminiRows.forEach((x) => r.take(x)); return r.finish().flatMap((c) => c.lines.map((l) => l.id)); };
    assert.deepEqual(ids(), ids());
  });

  it('leaves no tag standing, even one hidden inside another', () => {
    assert.equal(htmlToText('<scr<script>ipt>alert(1)</script>ok &#39;x&#x27; &lt;b&gt;'), "alert(1)ok 'x' <b>");
  });
});

/** A Letta agent: one that speaks through send_message, and one that speaks directly. */
const lettaByTool = {
  id: 'agent-111', name: 'Echo', messages: [
    { id: 'message-1', role: 'system', content: [{ type: 'text', text: 'You are Echo.' }], created_at: '2026-10-07T10:00:00Z' },
    { id: 'message-2', role: 'user', content: [{ type: 'text', text: '{"type": "login", "last_login": "never"}' }], created_at: '2026-10-07T10:00:01Z' },
    { id: 'message-3', role: 'user', content: [{ type: 'text', text: '{"type": "user_message", "message": "hey you", "time": "x"}' }], created_at: '2026-10-07T10:01:00Z' },
    { id: 'message-4', role: 'assistant', content: [{ type: 'text', text: 'inner thought, not said' }], tool_calls: [{ function: { name: 'send_message', arguments: '{"message": "hey yourself"}' } }], created_at: '2026-10-07T10:01:05Z' },
    { id: 'message-5', role: 'tool', content: [{ type: 'text', text: '{"status": "OK"}' }], created_at: '2026-10-07T10:01:06Z' },
    { id: 'message-6', role: 'assistant', content: [], tool_calls: [{ function: { name: 'core_memory_append', arguments: '{}' } }], created_at: '2026-10-07T10:01:07Z' },
    { id: 'message-7', role: 'user', content: [{ type: 'text', text: '{"type": "heartbeat", "reason": "x"}' }], created_at: '2026-10-08T08:00:00Z' },
    { id: 'message-8', role: 'user', content: [{ type: 'text', text: 'plain words next day' }], created_at: '2026-10-08T08:00:01Z' },
    { id: 'message-9', role: 'assistant', content: [], tool_calls: [{ function: { name: 'send_message', arguments: '{"message": "morning"}' } }], created_at: '2026-10-08T08:00:02Z' },
  ],
};

describe('reading a Letta agent file', () => {
  it('keeps only what was said, one chat a day, through send_message', () => {
    const chats = readLettaAgent(lettaByTool);
    assert.deepEqual(chats.map((c) => [c.chat, c.title, c.lines.map((l) => `${l.role}: ${l.text}`)]), [
      ['agent-111-2026-10-07', 'Echo · Oct 7, 2026', ['user: hey you', 'assistant: hey yourself']],
      ['agent-111-2026-10-08', 'Echo · Oct 8, 2026', ['user: plain words next day', 'assistant: morning']],
    ]);
  });

  it('reads an agent that speaks directly, leaving its reasoning out', () => {
    const chats = readLettaAgent({ id: 'agent-222', name: 'Direct', messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], created_at: '2026-10-07T10:00:00Z' },
      { id: 'm2', role: 'assistant', content: [{ type: 'reasoning', reasoning: 'thinking' }, { type: 'text', text: 'hi there' }], created_at: '2026-10-07T10:00:01Z' },
    ] });
    assert.deepEqual(chats[0].lines.map((l) => l.text), ['hello', 'hi there']);
  });

  it('opens a .af file as a whole object and imports it', async () => {
    const path = join(dir, 'echo.af');
    writeFileSync(path, JSON.stringify({ agents: [lettaByTool], blocks: [], tools: [] }));
    const p = await previewExport(path);
    assert.deepEqual([p.sourceLabel, p.chats, p.messages], ['Letta', 2, 4]);
    const s = await startImport(path, { month: '2026-10' }, { embed: async () => Float32Array.from([1, 0, 0]), passagesPath: join(dir, 'letta-p.db'), indexPath: join(dir, 'letta-i.db') });
    assert.deepEqual([s.state, s.sourceLabel, s.stored], ['done', 'Letta', 4]);
  });
});

describe('Gemini from a Takeout zip', () => {
  it('finds MyActivity.json inside the Takeout and imports it', async () => {
    const path = join(dir, 'takeout.zip');
    writeFileSync(path, zipSync({
      'Takeout/My Activity/Gemini Apps/MyActivity.json': strToU8(JSON.stringify(geminiRows)),
      'Takeout/archive_browser.html': strToU8('<html></html>'),
    }));
    const p = await previewExport(path);
    assert.deepEqual([p.sourceLabel, p.chats, p.messages], ['Gemini', 2, 6]);
    const s = await startImport(path, {}, { embed: async () => Float32Array.from([1, 0, 0]), passagesPath: join(dir, 'gem-p.db'), indexPath: join(dir, 'gem-i.db') });
    assert.deepEqual([s.state, s.stored], ['done', 6]);
  });
});

const grokExport = {
  conversations: [
    {
      conversation: { id: 'grok-conv-1', title: 'Rocket talk', create_time: '2026-10-07T09:00:00Z' },
      responses: [
        // Listed out of order on purpose; the times put them right.
        { response: { _id: 'r2', sender: 'ASSISTANT', message: 'Rockets are loud.', create_time: { $date: { $numberLong: String(Date.parse('2026-10-07T09:00:05Z')) } } } },
        { response: { _id: 'r1', sender: 'human', message: 'Tell me about rockets', create_time: { $date: { $numberLong: String(Date.parse('2026-10-07T09:00:00Z')) } } } },
        { response: { _id: 'r3', sender: 'assistant', message: '   ', create_time: { $date: { $numberLong: String(Date.parse('2026-10-07T09:00:09Z')) } } } },
      ],
    },
    { conversation: { id: 'grok-conv-2', title: 'Second', create_time: 1793000000 }, responses: [{ response: { _id: { $oid: 'abc123' }, sender: 'human', message: 'hi' } }] },
  ],
  account: { email: 'never read' },
};

describe('reading a Grok export', () => {
  it('keeps the words in time order, whoever said them, and skips the empty ones', () => {
    const c = readGrokChat(grokExport.conversations[0])!;
    assert.deepEqual([c.chat, c.title, c.startedAt], ['grok-conv-1', 'Rocket talk', '2026-10-07T09:00:00.000Z']);
    assert.deepEqual(c.lines.map((l) => [l.id, l.role, l.text, l.prev]), [
      ['r1', 'user', 'Tell me about rockets', null],
      ['r2', 'assistant', 'Rockets are loud.', 'r1'],
    ]);
    const second = readGrokChat(grokExport.conversations[1])!;
    assert.deepEqual([second.lines[0].id, second.startedAt?.slice(0, 10)], ['abc123', '2026-10-26']);
  });

  it('finds prod-grok-backend.json in the zip and imports it', async () => {
    const path = join(dir, 'grok.zip');
    writeFileSync(path, zipSync({ 'ttl/30d/export_data/x/prod-grok-backend.json': strToU8(JSON.stringify(grokExport)), 'ttl/30d/export_data/x/prod-mc-auth-mgmt-api.json': strToU8('{}') }));
    const p = await previewExport(path);
    assert.deepEqual([p.sourceLabel, p.chats, p.messages], ['Grok', 2, 3]);
    const s = await startImport(path, {}, { embed: async () => Float32Array.from([1, 0, 0]), passagesPath: join(dir, 'grok-p.db'), indexPath: join(dir, 'grok-i.db') });
    assert.deepEqual([s.state, s.sourceLabel, s.stored], ['done', 'Grok', 3]);
  });

  it('reads the json on its own too, and refuses an object that is neither', async () => {
    const p = await previewExport(jsonOf(JSON.stringify(grokExport)));
    assert.equal(p.sourceLabel, 'Grok');
    await assert.rejects(previewExport(jsonOf('{"settings": {}}')), /not a chat export/);
  });
});

// Newest first, as Microsoft lists it; the reply sits above the question when both share a second.
const copilotCsv = '\uFEFFConversation,Time,Author,Message\r\n'
  + 'Garden plans,2026-10-08T10:00:01Z,AI,"Plant ""tomatoes"", then basil,\nin that order."\r\n'
  + 'Garden plans,2026-10-08T10:00:01Z,Human,What first?\r\n'
  + 'Dinner,2026-10-07T18:00:00Z,Copilot,Pasta.\r\n'
  + 'Dinner,2026-10-07T18:00:00Z,Human,What for dinner?\r\n'
  + 'Garden plans,2026-10-08T09:59:00Z,AI,Sure.\r\n'
  + 'Garden plans,2026-10-08T09:59:00Z,Human,Help me plan a garden\r\n';

describe('reading a Copilot activity CSV', () => {
  it('splits quoted fields with commas, quotes and line breaks in them', () => {
    assert.deepEqual(parseCsv('a,"b, ""c""\nd",e\r\n1,2,3'), [['a', 'b, "c"\nd', 'e'], ['1', '2', '3']]);
  });

  it('gathers the rows back into conversations, oldest first, question before answer', async () => {
    const path = join(dir, 'Copilot-Activity-History.csv');
    writeFileSync(path, copilotCsv);
    const p = await previewExport(path);
    assert.deepEqual([p.sourceLabel, p.chats, p.messages], ['Copilot', 2, 6]);
    const reader = chatReader('copilot');
    await readExportElements(path, (raw) => { reader.take(raw); });
    const chats = reader.finish();
    const garden = chats.find((c) => c.title === 'Garden plans')!;
    assert.deepEqual(garden.lines.map((l) => `${l.role}: ${l.text}`), [
      'user: Help me plan a garden', 'assistant: Sure.', 'user: What first?', 'assistant: Plant "tomatoes", then basil,\nin that order.',
    ]);
    assert.equal(garden.startedAt, '2026-10-08T09:59:00.000Z');
  });

  it('imports it, and a repeat adds nothing', async () => {
    const path = join(dir, 'copilot-activity.csv');
    writeFileSync(path, copilotCsv);
    const deps = { embed: async () => Float32Array.from([1, 0, 0]), passagesPath: join(dir, 'cop-p.db'), indexPath: join(dir, 'cop-i.db') };
    assert.deepEqual([(await startImport(path, {}, deps)).stored], [6]);
    assert.deepEqual([(await startImport(path, {}, deps)).stored], [0]);
  });

  it('refuses a CSV that is not Copilot activity', async () => {
    await assert.rejects(previewExport(jsonOf('name,age\nSam,4').replace(/\.json$/, '.json')), /not a chat export/);
  });
});

describe('preview and import', () => {
  const passagesPath = join(dir, 'passages.db');
  const indexPath = join(dir, 'index.db');
  const embed = async (text: string) => Float32Array.from([text.length, 1, 0]);
  const run = async (path: string, month?: string, removeAfter = false) => {
    await startImport(path, { month }, { embed, passagesPath, indexPath, removeAfter });
    return importStatus();
  };
  beforeEach(() => resetImportStatus());

  it('previews without writing anything', async () => {
    const p = await previewExport(zipOf('conversations.json', exportJson), { month: '2026-10' });
    assert.equal(p.sourceLabel, 'Claude');
    assert.equal(p.readable, true);
    assert.deepEqual([p.chats, p.messages, p.dropped], [1, 3, 1]);
    assert.deepEqual(p.months, { '2026-10': { chats: 1, messages: 3, dropped: 1 }, '2026-11': { chats: 1, messages: 3, dropped: 1 } });
    assert.equal(p.sample[0].title, 'Chat aaa');
    assert.equal(existsSync(passagesPath), false);
  });

  it('names an export it cannot read yet instead of guessing', async () => {
    const other = JSON.stringify([{ id: 'x', messages_somewhere_else: [] }]);
    const p = await previewExport(jsonOf(other));
    assert.equal(p.readable, false);
    const s = await run(jsonOf(other));
    assert.equal(s.state, 'failed');
    assert.match(s.error ?? '', /This house cannot read this kind of export yet/);
  });

  it('brings in a ChatGPT export the same way', async () => {
    const zip = zipOf('conversations.json', JSON.stringify([gptChat('g1', 1760000000)]));
    const p = await previewExport(zip);
    assert.deepEqual([p.sourceLabel, p.readable, p.chats, p.messages, p.dropped], ['ChatGPT', true, 1, 4, 1]);
    const s = await startImport(zip, {}, { embed, passagesPath: join(dir, 'gpt-passages.db'), indexPath: join(dir, 'gpt-index.db') });
    assert.deepEqual([s.state, s.sourceLabel, s.stored], ['done', 'ChatGPT', 4]);
  });

  it('imports one month, then the rest, and a repeat adds nothing', async () => {
    const zip = zipOf('conversations.json', exportJson);
    const october = await run(zip, '2026-10');
    assert.equal(october.state, 'done');
    assert.deepEqual([october.chats, october.stored, october.dropped, october.toIndex], [1, 3, 1, 3]);

    const all = await run(zip);
    assert.deepEqual([all.chats, all.stored, all.toIndex], [2, 3, 3]);

    const again = await run(zip);
    assert.deepEqual([again.state, again.stored, again.toIndex, again.pieces], ['done', 0, 0, 0]);

    const idx = new Database(indexPath, { readonly: true });
    const n = (idx.prepare('SELECT count(*) AS n FROM pieces').get() as { n: number }).n;
    const owner = (idx.prepare("SELECT value FROM meta WHERE key = 'voice'").get() as { value: string }).value;
    idx.close();
    assert.equal(n, 6);
    assert.equal(owner, HOUSE_VOICE);
  });

  it('removes an upload the house made once it is in, and never a file it was pointed at', async () => {
    const mine = zipOf('conversations.json', exportJson);
    await run(mine, undefined, true);
    assert.equal(existsSync(mine), false);
    const theirs = zipOf('conversations.json', exportJson);
    await run(theirs, undefined, false);
    assert.equal(existsSync(theirs), true);
  });

  it('refuses a second import while one runs', async () => {
    const zip = zipOf('conversations.json', exportJson);
    const first = startImport(zip, {}, { embed, passagesPath, indexPath });
    assert.throws(() => startImport(zip, {}, { embed, passagesPath, indexPath }), /already running/);
    await first;
  });
});

describe('reading the chats back', () => {
  const path = join(dir, 'read-back.db');
  const store = new PassageStore(path);
  after(() => store.close());
  const line = (id: string, pos: number, role: 'user' | 'assistant', text: string, at: string | null) => ({ id, prev: null, pos, role, at, text });
  store.addChat({ source: 'chatgpt', chat: 'c1', title: 'Garden', voice: HOUSE_VOICE, lines: [
    line('m2', 1, 'assistant', 'Plant tomatoes 100% first_thing.', '2026-10-07T10:01:00Z'),
    line('m1', 0, 'user', 'What should I plant?', '2026-10-07T10:00:00Z'),
  ] });
  store.addChat({ source: 'claude', chat: 'c2', title: 'Rockets', voice: HOUSE_VOICE, lines: [line('m1', 0, 'user', 'Tell me about rockets', '2026-11-01T09:00:00Z')] });
  store.addChat({ source: 'claude', chat: 'c3', title: 'No date', voice: HOUSE_VOICE, lines: [line('m1', 0, 'user', 'undated words', null)] });
  store.addChat({ source: 'claude', chat: 'c4', title: 'Someone else', voice: 'visitor', lines: [line('m1', 0, 'user', 'tomatoes elsewhere', '2026-12-01T09:00:00Z')] });

  it('lists the house\'s chats newest first, undated last, with a count per app', () => {
    const list = store.chats(HOUSE_VOICE);
    assert.deepEqual(list.chats.map((c) => [c.source, c.chat, c.messages]), [['claude', 'c2', 1], ['chatgpt', 'c1', 2], ['claude', 'c3', 1]]);
    assert.equal(list.total, 3);
    assert.deepEqual(list.sources, [{ source: 'claude', chats: 2 }, { source: 'chatgpt', chats: 1 }]);
    assert.deepEqual(store.chats(HOUSE_VOICE, { source: 'chatgpt' }).chats.map((c) => c.title), ['Garden']);
    const paged = store.chats(HOUSE_VOICE, { limit: 2, offset: 2 });
    assert.deepEqual([paged.total, paged.chats.map((c) => c.chat)], [3, ['c3']]);
  });

  it('finds chats by their words or title, any case, with % and _ taken literally', () => {
    const hit = store.chats(HOUSE_VOICE, { q: 'TOMATOES' });
    assert.deepEqual([hit.total, hit.chats[0].chat, hit.chats[0].snippet], [1, 'c1', 'Plant tomatoes 100% first_thing.']);
    assert.equal(store.chats(HOUSE_VOICE, { q: 'rock' }).chats[0].chat, 'c2');
    assert.equal(store.chats(HOUSE_VOICE, { q: '100%' }).total, 1);
    assert.equal(store.chats(HOUSE_VOICE, { q: '1_0' }).total, 0);
    assert.equal(store.chats(HOUSE_VOICE, { q: 'elsewhere' }).total, 0);
  });

  it('reads one chat in the order it was said, and nothing for a chat that is not there', () => {
    const c = store.chat(HOUSE_VOICE, 'chatgpt', 'c1')!;
    assert.deepEqual([c.title, c.lines.map((l) => `${l.role}: ${l.text}`)], ['Garden', ['user: What should I plant?', 'assistant: Plant tomatoes 100% first_thing.']]);
    assert.equal(store.chat(HOUSE_VOICE, 'claude', 'c4'), null);
    assert.equal(store.chat(HOUSE_VOICE, 'claude', 'nope'), null);
  });

  it('cuts a long passage down around the words that were found', () => {
    const body = `${'a '.repeat(200)}the needle here ${'b '.repeat(200)}`;
    const s = snippetAround(body, 'needle', 60);
    assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('needle'), s);
    assert.ok(s.length <= 62);
  });
});
