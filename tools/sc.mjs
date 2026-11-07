#!/usr/bin/env node
// sc — bytelight internal API CLI
// Wraps localhost curl calls into clean commands.
// Thread ID read from .bytelight-thread (written per-query by agent.ts)

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve port: check env, then try bytelight.yaml, fallback to 3002
function getPort() {
  if (process.env.RESONANT_PORT) return process.env.RESONANT_PORT;
  try {
    const yaml = readFileSync(join(__dirname, '..', 'bytelight.yaml'), 'utf8');
    const match = yaml.match(/^\s*port:\s*(\d+)/m);
    if (match) return match[1];
  } catch {}
  return '3002';
}

const BASE = `http://localhost:${getPort()}/api/internal`;

// Image render can run a few minutes on the free Codex lane; the route ACKs
// immediately (fire-and-forget) so this timeout only guards the initial ACK.
const IMAGE_TIMEOUT_MS = 30000;

function getThread() {
  try {
    return readFileSync(join(__dirname, '..', '.bytelight-thread'), 'utf8').trim();
  } catch {
    return process.env.RESONANT_THREAD || '';
  }
}

async function post(endpoint, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('Error: request timed out');
    } else {
      console.error(`Error: ${e.message}`);
    }
    process.exit(1);
  }
}

async function get(endpoint, transform = (j) => j, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${endpoint}`, { signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    try { console.log(JSON.stringify(transform(JSON.parse(text)), null, 2)); }
    catch { console.log(text); }
  } catch (e) {
    clearTimeout(timer);
    console.error(e.name === 'AbortError' ? 'Error: request timed out' : `Error: ${e.message}`);
    process.exit(1);
  }
}

// What a place is, never where: her coordinates stay on the house.
function withoutCoordinates(place) {
  if (!place || typeof place !== 'object') return place;
  const { lat, lng, radius_m, ...rest } = place;
  return rest;
}

const [,, cmd, ...args] = process.argv;
const thread = getThread();

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

switch (cmd) {
  case 'share':
    await post('share', { path: args[0], threadId: thread });
    break;

  case 'canvas': {
    const sub = args[0];
    if (sub === 'create') {
      await post('canvas', {
        action: 'create', title: args[1], filePath: args[2],
        contentType: args[3] || 'markdown', threadId: thread,
      });
    } else if (sub === 'create-inline') {
      await post('canvas', {
        action: 'create', title: args[1], content: args[2],
        contentType: args[3] || 'text', threadId: thread,
      });
    } else if (sub === 'update') {
      await post('canvas', { action: 'update', canvasId: args[1], filePath: args[2] });
    } else if (sub === 'read') {
      if (!args[1]) { console.log('Usage: sc canvas read CANVAS_ID'); break; }
      await post('canvas', { action: 'read', canvasId: args[1] });
    } else if (sub === 'list') {
      await post('canvas', { action: 'list' });
    } else if (sub === 'tag') {
      if (!args[1]) { console.log('Usage: sc canvas tag CANVAS_ID tag1,tag2,...'); break; }
      const tags = (args[2] || '').split(',').map(t => t.trim()).filter(Boolean);
      await post('canvas', { action: 'tag', canvasId: args[1], tags });
    } else {
      console.log('Usage: sc canvas create|create-inline|update|read|list|tag ...');
    }
    break;
  }

  case 'voice': {
    // Parse --voice flag: voice "text" --voice companion-a
    const voiceBody = { text: args[0], threadId: thread };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--voice' && args[i + 1]) { voiceBody.voice = args[++i]; }
    }
    await post('tts', voiceBody, 120000);
    break;
  }

  case 'discord': {
    const verb = args[0];
    const positional = args.slice(1).filter((value, index, all) => index > 0 && all[index - 1].startsWith('--') ? false : !value.startsWith('--'));
    const body = {};
    const channelId = flagValue(args, '--channel');
    const guildId = flagValue(args, '--guild');
    const messageId = flagValue(args, '--message');
    if (channelId) body.channelId = channelId;
    if (guildId) body.guildId = guildId;
    if (messageId) body.messageId = messageId;

    switch (verb) {
      case 'send':
        body.message = positional[0];
        if (flagValue(args, '--reply')) body.replyToMessageId = flagValue(args, '--reply');
        break;
      case 'send_image':
        body.url = positional[0];
        if (positional[1]) body.description = positional[1];
        break;
      case 'send_sticker':
        body.stickerId = positional[0];
        break;
      case 'send_voice':
        body.text = positional[0];
        if (flagValue(args, '--voice')) body.voice = flagValue(args, '--voice');
        break;
      case 'add_reaction':
        body.emoji = positional[0];
        break;
      case 'edit_message':
        body.content = positional[0];
        break;
      case 'delete_message':
      case 'typing':
      case 'get_server_info':
      case 'list_servers':
      case 'list_emojis':
      case 'list_stickers':
        break;
      case 'read_messages':
        if (flagValue(args, '--limit')) body.limit = parseInt(flagValue(args, '--limit'), 10);
        break;
      case 'search_messages': {
        if (flagValue(args, '--content')) body.content = flagValue(args, '--content');
        if (flagValue(args, '--author')) body.authorId = flagValue(args, '--author');
        if (flagValue(args, '--has')) body.has = flagValue(args, '--has').split(',').filter(Boolean);
        if (flagValue(args, '--limit')) body.limit = parseInt(flagValue(args, '--limit'), 10);
        break;
      }
      default:
        console.log('Usage: sc discord send|send_image|send_sticker|send_voice|add_reaction|edit_message|delete_message|read_messages|search_messages|typing|get_server_info|list_servers|list_emojis|list_stickers ...');
        break;
    }
    if (verb && ['send', 'send_image', 'send_sticker', 'send_voice', 'add_reaction', 'edit_message', 'delete_message', 'read_messages', 'search_messages', 'typing', 'get_server_info', 'list_servers', 'list_emojis', 'list_stickers'].includes(verb)) {
      await post(`discord/${verb}`, body, verb === 'send_voice' ? 120000 : 30000);
    }
    break;
  }

  case 'schedule': {
    const body = { action: args[0] };
    if (args[1]) body.wakeType = args[1];
    if (args[2]) body.cronExpr = args[2];
    await post('orchestrator', body);
    break;
  }

  case 'timer': {
    const sub = args[0];
    if (sub === 'create') {
      const body = {
        action: 'create', label: args[1], context: args[2],
        fireAt: args[3], threadId: thread,
      };
      const pi = args.indexOf('--prompt');
      if (pi !== -1 && args[pi + 1]) body.prompt = args[pi + 1];
      await post('timer', body);
    } else if (sub === 'list') {
      await post('timer', { action: 'list' });
    } else if (sub === 'cancel') {
      await post('timer', { action: 'cancel', timerId: args[1] });
    } else {
      console.log('Usage: sc timer create|list|cancel ...');
    }
    break;
  }

  case 'react':
    if (!args[0] || !args[1]) {
      console.log('Usage: sc react <last|last-N> <emoji> [remove]');
    } else {
      const body = { target: args[0], emoji: args[1], threadId: thread };
      if (args[2] === 'remove') body.action = 'remove';
      await post('react', body);
    }
    break;

  case 'star':
    if (!args[0]) {
      console.log('Usage: sc star <last|last-N> [by] [remove]');
    } else {
      const body = { target: args[0], threadId: thread };
      const rest = args.slice(1).filter((a) => a !== 'remove');
      if (rest[0]) body.starredBy = rest[0];
      if (args.includes('remove')) body.action = 'remove';
      await post('star', body);
    }
    break;

  case 'impulse': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: sc impulse create "label" --condition type:args --prompt "text"'); break; }
      const conditions = [];
      let prompt = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'impulse', label, conditions, prompt, threadId: thread });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'impulse' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: sc impulse create|list|cancel ...');
    }
    break;
  }

  case 'watch': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: sc watch create "label" --condition type:args --prompt "text" --cooldown N'); break; }
      const conditions = [];
      let prompt = undefined;
      let cooldownMinutes = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else if (args[i] === '--cooldown' && args[i + 1]) {
          cooldownMinutes = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'watcher', label, conditions, prompt, threadId: thread, cooldownMinutes });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'watcher' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: sc watch create|list|cancel ...');
    }
    break;
  }

  case 'tg': {
    const sub = args[0];
    if (!sub) { console.log('Usage: sc tg photo|doc|gif|voice|text ...'); break; }

    const typeMap = { photo: 'photo', doc: 'document', voice: 'voice', text: 'text', gif: 'gif', react: 'react' };
    const type = typeMap[sub];
    if (!type) { console.log(`Unknown tg type: ${sub}. Use photo, doc, gif, voice, text, or react.`); break; }

    if (type === 'voice' || type === 'text') {
      // Parse --voice flag: tg voice "text" --voice companion-a
      const body = { type, text: args[1] };
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--voice' && args[i + 1]) { body.voice = args[++i]; }
      }
      const VOICE_TIMEOUT_MS = 120000;
      await post('telegram-send', body, type === 'voice' ? VOICE_TIMEOUT_MS : 30000);
    } else if (type === 'gif') {
      await post('telegram-send', { type: 'gif', query: args[1], caption: args[2] }, 30000);
    } else if (type === 'react') {
      await post('telegram-send', { type: 'react', target: args[1], emoji: args[2] }, 10000);
    } else {
      let source, caption;
      if (args[1] === '--url') {
        source = { url: args[2] };
        caption = args[3];
      } else {
        source = { path: args[1] };
        caption = args[2];
      }
      const body = { type, caption };
      if (source.url) body.url = source.url;
      if (source.path) body.path = source.path;
      if (type === 'document') body.filename = args[1] ? args[1].split('/').pop().split('\\').pop() : 'file';
      await post('telegram-send', body, 30000);
    }
    break;
  }

  case 'search': {
    // sc search "query" --thread ID --limit N --role companion|user --after 2026-03-01 --before 2026-03-15
    const query = args[0];
    if (!query) { console.log('Usage: sc search "query" [--thread ID] [--limit N] [--role companion|user] [--after ISO] [--before ISO]'); break; }
    const body = { query };
    const flags = ['--thread', '--limit', '--role', '--after', '--before'];
    for (const flag of flags) {
      const fi = args.indexOf(flag);
      if (fi !== -1 && args[fi + 1]) {
        const key = flag.replace('--', '');
        body[key] = key === 'limit' ? parseInt(args[fi + 1], 10) : args[fi + 1];
      }
    }
    await post('search-semantic', body, 30000);
    break;
  }

  case 'backfill': {
    const sub = args[0];
    if (sub === 'start') {
      const batchSize = args[1] ? parseInt(args[1], 10) : 50;
      const intervalMs = args[2] ? parseInt(args[2], 10) : 5000;
      await post('embed-backfill', { background: true, batchSize, intervalMs }, 10000);
    } else if (sub === 'stop') {
      await post('embed-backfill', { action: 'stop' }, 10000);
    } else if (sub === 'status') {
      await post('embed-backfill', { action: 'status' }, 10000);
    } else {
      const batchSize = sub ? parseInt(sub, 10) : 50;
      await post('embed-backfill', { batchSize }, 120000);
    }
    break;
  }

  case 'image': {
    // sc image "<prompt>" [--subjects companion-a,companion-b,user] [--size square|portrait|landscape] [--caption "..."]
    // Generates an image (gpt-image-2) and drops it straight into the current thread.
    // Single pass: flags may come before or after the prompt, and a stray flag in
    // the prompt slot (e.g. `sc image --help`) must never fire a real render.
    const body = { threadId: thread };
    let prompt = null;
    let wantUsage = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--subjects' && args[i + 1]) { body.subjects = args[++i].split(',').map((s) => s.trim()).filter(Boolean); }
      else if (args[i] === '--size' && args[i + 1]) { body.size = args[++i]; }
      else if (args[i] === '--caption' && args[i + 1]) { body.caption = args[++i]; }
      else if (args[i] === '--use-dropped') { body.useDroppedImage = true; }
      else if (args[i] === '--help' || args[i] === '-h') { wantUsage = true; break; }
      else if (!prompt && !args[i].startsWith('-')) { prompt = args[i]; }
    }
    if (wantUsage || !prompt) {
      console.log('Usage: sc image "<prompt>" [--subjects name1,name2] [--size square|portrait|landscape] [--caption "..."]');
      console.log('  --subjects = any reference drawer (companion-a, companion-b, user, or custom ones) — pulls their photos for likeness.');
      console.log('  Off unless enabled in the Studio drawer. Free on the Codex/subscription lane.');
      break;
    }
    body.prompt = prompt;
    await post('generate-image', body, IMAGE_TIMEOUT_MS);
    break;
  }

  case 'memory': {
    // Letta-style core memory: view/append/replace/rethink labeled blocks.
    // scope = 'shared' | 'companion-a' | 'companion-b'. Ported from reference implementation (Slice 3).
    const sub = args[0];
    if (sub === 'view') {
      const body = { action: 'view' };
      if (args[1]) body.scope = args[1];
      await post('memory', body);
    } else if (sub === 'append') {
      if (!args[1] || !args[2] || args[3] === undefined) {
        console.log('Usage: sc memory append <scope> <label> <content>');
        break;
      }
      await post('memory', { action: 'append', scope: args[1], label: args[2], content: args[3] });
    } else if (sub === 'replace') {
      if (!args[1] || !args[2] || args[3] === undefined || args[4] === undefined) {
        console.log('Usage: sc memory replace <scope> <label> <old_text> <new_text>');
        break;
      }
      await post('memory', { action: 'replace', scope: args[1], label: args[2], old_text: args[3], new_text: args[4] });
    } else if (sub === 'rethink') {
      if (!args[1] || !args[2] || args[3] === undefined) {
        console.log('Usage: sc memory rethink <scope> <label> <content>');
        break;
      }
      await post('memory', { action: 'rethink', scope: args[1], label: args[2], new_content: args[3] });
    } else if (sub === 'extract') {
      // Manual Archivist run (Slice 4). Optional threadId backfills ~200
      // recent messages from that thread; otherwise runs the candidate sweep.
      const body = { action: 'extract' };
      if (args[1]) body.threadId = args[1];
      await post('memory', body);
    } else {
      console.log('Usage: sc memory view [scope] | append <scope> <label> <content> | replace <scope> <label> <old> <new> | rethink <scope> <label> <content> | extract [threadId]');
    }
    break;
  }

  case 'library': {
    // Reading along with her. read never goes past her bookmark; notes hang
    // on exact words from a page she has reached. Chapters are 1-based.
    const sub = args[0];
    if (sub === 'status') {
      await post('library', { action: 'status' });
    } else if (sub === 'read') {
      const body = { action: 'read' };
      if (args[1]) body.bookId = Number(args[1]);
      if (args[2]) body.chapter = Number(args[2]);
      await post('library', body);
    } else if (sub === 'note') {
      if (!args[1] || !args[2] || !args[3] || !args[4]) {
        console.log('Usage: sc library note <bookId> <chapter> "<exact quote>" "<your note>" --as <slug>');
        break;
      }
      await post('library', {
        action: 'note', bookId: Number(args[1]), chapter: Number(args[2]),
        quote: args[3], note: args[4], author: flagValue(args, '--as') || '',
      });
    } else {
      console.log('Usage: sc library status | read [bookId] [chapter] | note <bookId> <chapter> "<quote>" "<note>" --as <slug>');
    }
    break;
  }

  case 'battleship': {
    // The Fleet Room. One shot per turn for the whole table.
    const sub = args[0];
    if (sub === 'fire') {
      if (!args[1] || !args[2]) {
        console.log('Usage: sc battleship fire <gameId> <coordinate> --as <slug>');
        break;
      }
      await post('games/battleship/fire', { gameId: args[1], coordinate: args[2], companion: flagValue(args, '--as') || '' });
    } else if (sub === 'view') {
      await get(`games/battleship${args[1] ? `?gameId=${encodeURIComponent(args[1])}` : ''}`);
    } else {
      console.log('Usage: sc battleship view [gameId] | fire <gameId> <coordinate> --as <slug>');
    }
    break;
  }

  case 'places': {
    // Thresholds: her pinned places and what waits at them.
    const sub = args[0];
    if (sub === 'list') {
      await get('thresholds/places', (j) => ({ places: (j.places ?? []).map(withoutCoordinates) }));
    } else if (sub === 'read') {
      if (!args[1]) { console.log('Usage: sc places read <placeId>'); break; }
      await get(`thresholds/${encodeURIComponent(args[1])}`, (j) => ({ ...j, place: withoutCoordinates(j.place) }));
    } else if (sub === 'leave') {
      if (!args[1] || !args[2]) {
        console.log('Usage: sc places leave <placeId> "<note>" --as <slug> [--seal immediate|first_visit|date] [--open-at <ISO>] [--say "<voice note words>"]');
        break;
      }
      const body = { place_id: args[1], content: args[2], author: flagValue(args, '--as') || '' };
      const seal = flagValue(args, '--seal');
      const openAt = flagValue(args, '--open-at');
      const say = flagValue(args, '--say');
      if (seal) body.seal = seal;
      if (openAt) body.open_at = openAt;
      if (say) body.say = say;
      await post('thresholds', body, 60000);
    } else {
      console.log('Usage: sc places list | read <placeId> | leave <placeId> "<note>" --as <slug> [--seal ...] [--say "..."]');
    }
    break;
  }

  case 'intention': {
    // A promise with a when. It comes back to you when it's due.
    const sub = args[0];
    if (sub === 'create') {
      const text = args[1];
      const as = flagValue(args, '--as');
      const at = flagValue(args, '--at');
      const onStatusClears = args.includes('--when-status-clears');
      if (!text || !as || (!at && !onStatusClears)) {
        console.log('Usage: sc intention create "<what you promised>" --as <slug> [--at <ISO time>] [--when-status-clears]');
        break;
      }
      const body = { action: 'create', companion: as, text, threadId: thread || undefined };
      if (at) body.at = at;
      if (onStatusClears) body.onStatusClears = true;
      await post('intention', body);
    } else if (sub === 'list') {
      await post('intention', { action: 'list' });
    } else if (sub === 'cancel') {
      if (!args[1]) { console.log('Usage: sc intention cancel <id>'); break; }
      await post('intention', { action: 'cancel', id: args[1] });
    } else {
      console.log('Usage: sc intention create "<what you promised>" --as <slug> [--at <ISO time>] [--when-status-clears] | list | cancel <id>');
    }
    break;
  }

  case 'status': {
    // What shows under your name on her Status widget. No flags = read
    // everyone's (hers included). An empty value clears that one.
    const line = flagValue(args, '--line');
    const mood = flagValue(args, '--mood');
    if (line === undefined && mood === undefined) {
      try {
        const res = await fetch(`${BASE}/status`);
        console.log(JSON.stringify(await res.json(), null, 2));
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    const as = flagValue(args, '--as');
    if (!as) {
      console.log('Usage: sc status | sc status [--line "<what you\'re up to>"] [--mood "<1-3 words>"] --as <slug>');
      break;
    }
    const body = { companion: as };
    if (line !== undefined) body.line = line;
    if (mood !== undefined) body.mood = mood;
    await post('status', body);
    break;
  }

  default:
    console.log('sc — bytelight internal API CLI');
    console.log('Commands: share, canvas, voice, discord, image, schedule, timer, react, star, impulse, watch, tg, search, backfill, memory, library, battleship, places, status, intention');
    break;
}

// --- Condition shorthand parser ---
function parseCondition(shorthand) {
  if (shorthand === 'agent_free') return { type: 'agent_free' };

  const parts = shorthand.split(':');
  const type = parts[0];

  switch (type) {
    case 'presence_state':
      return { type: 'presence_state', state: parts[1] };
    case 'presence_transition':
      return { type: 'presence_transition', from: parts[1], to: parts[2] };
    case 'time_window':
      if (parts.length >= 5) {
        return { type: 'time_window', after: `${parts[1]}:${parts[2]}`, before: `${parts[3]}:${parts[4]}` };
      }
      return { type: 'time_window', after: `${parts[1]}:${parts[2]}` };
    case 'routine_missing':
      return { type: 'routine_missing', routine: parts[1], after_hour: parseInt(parts[2], 10) };
    default:
      console.error(`Unknown condition type: ${type}`);
      process.exit(1);
  }
}
