import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const MOVE_XP = 10;
const bosses = [
  { kind: 'wyrm', match: /laundry|clothes|hamper|folding|duvet|bed sheets/i, name: 'The Duvet Wyrm', lore: 'A fitted sheet learned to hiss. Now it guards the bedroom.', look: 'a moth-winged serpent wearing a fitted sheet as a hood, with one gold eye', moves: [['Put five things in the hamper.', 'Put one thing in the hamper.'], ['Clear one corner of the bed.', 'Move one thing off the bed.'], ['Pick out enough laundry for one load.', 'Choose one item for the next load.']] },
  { kind: 'slime', match: /dish|sink|kitchen|plate|cupboard/i, name: 'The Sink Siren', lore: 'It sings through a tower of mugs, loudest just before a dish gets washed.', look: 'a tiny sea monster made of soap bubbles and chipped ceramic, cradling a flying teacup', moves: [['Wash or load three dishes.', 'Wash or load one dish.'], ['Clear one patch next to the sink.', 'Move one thing to its place.'], ['Put a clean item away.', 'Choose the easiest clean item.']] },
  { kind: 'moth', match: /email|inbox|message|reply|phone call|text back/i, name: 'The Unsent Moth', lore: 'It chews holes in half-written sentences. It hates short ones.', look: 'an enormous rose-colored moth with folded paper wings and an empty envelope for a crown', moves: [['Pick one person or message to deal with.', 'Open the message list.'], ['Write one sentence you might send.', 'Type three words in a draft.'], ['Decide whether to send it now or leave it ready.', 'Save the draft.']] },
  { kind: 'fox', match: /write|writing|essay|homework|project|drawing|paint|work|study/i, name: 'The Blank Page Fox', lore: 'It insists every first draft must be a masterpiece. Its own handwriting is atrocious.', look: 'a many-tailed fox whose tails are tipped in watercolor ink, sleeping on a blank page', moves: [['Open the file or put the materials within reach.', 'Put one tool in front of you.'], ['Make one rough mark or write one rough line.', 'Write or draw anything for thirty seconds.'], ['Leave yourself one note about where to start next.', 'Put a mark where you stopped.']] },
  { kind: 'toad', match: /clean|tidy|clutter|vacuum|sweep|trash|mess|floor|room/i, name: 'The Clutter Toad', lore: 'Every time it blinks, a new object appears on the floor. Start before it blinks again.', look: 'a fat sage-green toad with luminous button eyes and a crooked crown of household odds and ends', moves: [['Pick a patch no bigger than a book.', 'Point at one object.'], ['Put three things from that patch away.', 'Move one thing where it belongs.'], ['Stop and look at the patch you changed.', 'Notice one visible difference.']] },
  { kind: 'moon', match: /./s, name: 'The Fog Familiar', lore: 'It hides the first step behind all the other steps. Catch it by making the first step smaller.', look: 'a small three-eyed cloud creature with curled horns and a crescent floating above its head', moves: [['Write one tiny action you could take about this.', 'Write one verb that feels possible.'], ['Put one thing you’ll need within reach.', 'Name one thing that would make starting easier.'], ['Try that action for a minute, or decide what to leave for later.', 'Try just the first movement.']] },
] as const;

export type BattleStatus = 'active' | 'paused' | 'won';
export interface BattleMove { id: string; text: string; smaller: string; done: boolean; }
export interface BossDraft { name: string; lore: string; appearance: string; kind: string; model: string; companion: string; moves: Array<{ text: string; smaller: string }>; }
interface BattleRow { id: string; issue: string; kind: string; status: BattleStatus; moves: string; createdAt: number; portraitJobId: string | null; portraitFilename: string | null; draft?: string | null; }
export class BattleError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

function text(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new BattleError(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
export function bossIssue(value: unknown) { return text(value, 800, 'what’s in your way'); }
export function validateBossDraft(draft: BossDraft): BossDraft {
  const invalid = () => new BattleError('Your companion didn’t return three separate, usable moves. No battle or portrait was started.', 502);
  try {
    if (!draft || !bosses.some(b => b.kind === draft.kind) || !Array.isArray(draft.moves) || draft.moves.length !== 3) throw invalid();
    const moves = draft.moves.map(m => ({ text: text(m?.text, 160, 'a move'), smaller: text(m?.smaller, 160, 'a smaller move') }));
    const unique = (items: string[]) => new Set(items.map(s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())).size === items.length;
    if (!unique(moves.map(m => m.text)) || !unique(moves.map(m => m.smaller))) throw invalid();
    return { name: text(draft.name, 80, 'a name'), lore: text(draft.lore, 240, 'lore'), appearance: text(draft.appearance, 480, 'a distinct visual design'), kind: draft.kind, model: text(draft.model, 240, 'a model'), companion: text(draft.companion, 120, 'a companion'), moves };
  } catch { throw invalid(); }
}
function archetype(kind: string) { return bosses.find(b => b.kind === kind) ?? bosses[bosses.length - 1]; }
function present(row: BattleRow) {
  const { draft, ...rest } = row;
  const source = draft ? JSON.parse(draft) as Omit<BossDraft, 'moves' | 'kind'> : null;
  const fallback = archetype(row.kind);
  const { name, lore } = source ?? fallback;
  return { ...rest, name, lore, appearance: source?.appearance ?? fallback.look, model: source?.model, companion: source?.companion, moves: JSON.parse(row.moves) as BattleMove[] };
}

export interface BossBattleStore {
  list(): { battles: ReturnType<typeof present>[]; xp: number };
  create(issue: unknown, draft: BossDraft): string;
  change(id: string, action: unknown, moveId: unknown, replacement: unknown): void;
  portrait(id: string, start: (prompt: string) => string): void;
  finishPortrait(id: string, filename: string): void;
  clearFailedPortrait(id: string, job: string): void;
}

export function createBossBattleStore(db: Database.Database): BossBattleStore {
  db.exec(`CREATE TABLE IF NOT EXISTS life_boss_battles (
    id TEXT PRIMARY KEY, issue TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','paused','won')), moves TEXT NOT NULL,
    createdAt INTEGER NOT NULL, portraitJobId TEXT, portraitFilename TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS life_one_active_boss ON life_boss_battles(status) WHERE status='active';
  CREATE TABLE IF NOT EXISTS life_xp_events (source TEXT PRIMARY KEY, points INTEGER NOT NULL CHECK(points > 0), createdAt INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS life_boss_drafts (id TEXT PRIMARY KEY, draft TEXT NOT NULL);`);
  const select = 'SELECT b.*, d.draft FROM life_boss_battles b LEFT JOIN life_boss_drafts d ON d.id=b.id';
  const get = (id: string) => {
    const row = db.prepare(`${select} WHERE b.id=?`).get(id) as BattleRow | undefined;
    if (!row) throw new BattleError('Battle not found.', 404);
    return row;
  };
  const active = () => !!db.prepare("SELECT 1 FROM life_boss_battles WHERE status='active'").get();
  const requireNoActive = () => { if (active()) throw new BattleError('Pause or finish your current battle first.', 409); };
  return {
    list() {
      const battles = db.prepare(`${select} ORDER BY CASE b.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, b.createdAt DESC, b.rowid DESC`).all() as BattleRow[];
      const { xp } = db.prepare('SELECT COALESCE(SUM(points), 0) AS xp FROM life_xp_events').get() as { xp: number };
      return { battles: battles.map(present), xp };
    },
    create: db.transaction((raw: unknown, draft: BossDraft) => {
      const issue = bossIssue(raw);
      requireNoActive();
      const { kind, moves: suggestions, ...receipt } = validateBossDraft(draft);
      const id = randomUUID();
      const moves = suggestions.map(move => ({ ...move, id: randomUUID(), done: false }));
      db.prepare("INSERT INTO life_boss_battles (id, issue, kind, status, moves, createdAt) VALUES (?,?,?,'active',?,?)").run(id, issue, kind, JSON.stringify(moves), Date.now());
      db.prepare('INSERT INTO life_boss_drafts(id,draft) VALUES (?,?)').run(id, JSON.stringify(receipt));
      return id;
    }),
    change: db.transaction((id: string, action: unknown, moveId: unknown, replacement: unknown) => {
      const row = get(id);
      const battle = present(row);
      if (action === 'remove') { db.prepare('DELETE FROM life_boss_drafts WHERE id=?').run(id); db.prepare('DELETE FROM life_boss_battles WHERE id=?').run(id); return; }
      if (action === 'pause' || action === 'resume' || action === 'win') {
        if ((action === 'pause' && row.status === 'paused') || (action === 'resume' && row.status === 'active') || (action === 'win' && row.status === 'won')) return;
        if (action === 'resume' && row.status === 'paused') requireNoActive();
        else if (row.status !== 'active' || action === 'resume') throw new BattleError('That battle cannot change status.', 409);
        if (action === 'win' && !battle.moves.some(m => m.done)) throw new BattleError('Finish a move before claiming the win.');
        db.prepare('UPDATE life_boss_battles SET status=? WHERE id=?').run(action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'won', id);
        return;
      }
      if (action !== 'complete' && action !== 'shrink' && action !== 'swap') throw new BattleError('Unknown battle action.');
      const move = battle.moves.find(m => m.id === moveId);
      if (!move) throw new BattleError('Move not found.', 404);
      if (move.done && action === 'complete') return;
      if (row.status !== 'active' || move.done) throw new BattleError('This move can no longer be changed.', 409);
      if (action === 'complete') {
        db.prepare('INSERT OR IGNORE INTO life_xp_events(source, points, createdAt) VALUES (?,?,?)').run(`boss:${id}:${move.id}`, MOVE_XP, Date.now());
        move.done = true;
      } else if (action === 'shrink') move.text = move.smaller;
      else { move.text = text(replacement, 160, 'a new move'); move.smaller = 'Take the smallest possible part of that move for thirty seconds.'; }
      db.prepare('UPDATE life_boss_battles SET moves=? WHERE id=?').run(JSON.stringify(battle.moves), id);
    }),
    portrait: db.transaction((id: string, start: (prompt: string) => string) => {
      const row = get(id);
      if (row.portraitJobId || row.portraitFilename) throw new BattleError('This boss already has a portrait request.', 409);
      const battle = present(row);
      // The private note is never part of a portrait request.
      const job = start(`Square fantasy bestiary portrait of ${battle.appearance}. Preserve this creature's stated body plan, silhouette, limb count, face, and materials. Centered single fictional creature. No lettering.`);
      db.prepare('UPDATE life_boss_battles SET portraitJobId=? WHERE id=?').run(job, id);
    }),
    finishPortrait(id: string, filename: string) {
      db.prepare('UPDATE life_boss_battles SET portraitFilename=? WHERE id=?').run(filename, id);
    },
    clearFailedPortrait(id: string, job: string) {
      db.prepare('UPDATE life_boss_battles SET portraitJobId=NULL WHERE id=? AND portraitJobId=? AND portraitFilename IS NULL').run(id, job);
    },
  };
}
