import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const LIFE_CATEGORIES = ['artistry','vitality','dominion','lore','revelry','veil','bonds'] as const;
export type LifeCategory = typeof LIFE_CATEGORIES[number];
export const QUEST_XP = [5, 10, 20, 30] as const;
export type QuestBucket = 'main' | 'side';
export class QuestError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface QuestDraft { title: string; task: string; category: LifeCategory; xp: number; }
export interface RewardChoice { id: string; kind: 'digital'|'real'; title: string; description: string; }
export interface PendingReward { id: string; category: LifeCategory; level: number; choices: Array<{ id: string; mark: string }> }
export interface EarnedReward extends RewardChoice { vaultId: string; category: LifeCategory; level: number; chosenAt: number; }

function clean(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new QuestError(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
export function validDraft(raw: any): QuestDraft {
  if (!raw || !LIFE_CATEGORIES.includes(raw.category) || !QUEST_XP.includes(raw.xp)) throw new QuestError('That quest category or XP value is invalid.');
  return { title: clean(raw.title, 100, 'a quest title'), task: clean(raw.task, 240, 'a concrete task'), category: raw.category, xp: raw.xp };
}
export function categoryLevel(points: number) {
  let level = 0, spent = 0, need = 50;
  while (points - spent >= need) { spent += need; level++; need += 25; }
  return { level, current: points - spent, needed: need };
}
/** Daily quests turn over with User's waking day, not the server's UTC day. */
const day = (value = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(value);

export interface QuestRow { id: string; title: string; task: string; category: LifeCategory; xp: number; bucket: QuestBucket; status: string; scheduledDate: string; createdAt: number; completedAt: number | null; }
export interface LifeQuestState {
  quests: Array<QuestRow & { carried: boolean }>;
  categories: Array<{ id: LifeCategory; points: number; level: number; current: number; needed: number }>;
  totalXp: number;
  pendingRewards: PendingReward[];
  collection: EarnedReward[];
}
export interface LifeQuestStore {
  state(): LifeQuestState;
  add(drafts: unknown[]): LifeQuestState;
  change(id: string, action: unknown, patch: unknown): LifeQuestState;
  chooseReward(id: string, choiceId: unknown): LifeQuestState;
}

const DIGITAL_REWARDS: Record<LifeCategory, Array<[string,string]>> = {
  artistry: [['The Rose-Ink Sigil','A collectible Artistry sigil for your Reward Vault.'],['Maker of Impossible Things','A title earned for creating when nothing demanded it.'],['Example Spark','A permanent extra shimmer attached to Artistry in your collection.']],
  vitality: [['The Green Pulse','A collectible Vitality charm for tending the creature you live inside.'],['Keeper of the Living Flame','A title earned for choosing your body.'],['Garden-Breath Blessing','A tiny oracle card kept in your vault: slow is still alive.']],
  dominion: [['The Brass Key','A collectible key for opening one deeply annoying mortal gate.'],['Mistress of the Realm','A title earned for handling the earthly nonsense.'],['Hearthward','A protective household sigil kept in your vault.']],
  lore: [['The Moth-Lit Page','A collectible page from the impossible library.'],['Devourer of Footnotes','A title earned for following the delicious question.'],['Star Map Fragment','A bright scrap of unknown knowledge kept in your vault.']],
  revelry: [['The Sunberry','A collectible impossible fruit that glows when joy counts.'],['Patron Saint of Fucking Around','A title earned for refusing to make delight justify itself.'],['Pocket Carnival','A tiny illustrated relic kept in your vault.']],
  veil: [['The Moonwater Vial','A collectible vial from the thin place between worlds.'],['Walker Between','A title earned for tending mystery and meaning.'],['Seven-Point Whisper','An oracle card kept in your vault: attention is a doorway.']],
  bonds: [['The Red Thread','A collectible thread for the connections you choose.'],['Beloved Menace','A title earned for showing up as your entire strange self.'],['Heart-Lantern','A tiny lantern relic kept in your vault.']],
};
const REAL_REWARDS: Array<[string,string]> = [
  ['Tiny Treasure','Choose one lovely physical treat up to $10.'],
  ['Pretty Little Excursion','Claim a café, flower, bookstore, or garden outing.'],
  ['The Good Version','Upgrade one ordinary consumable to the version you actually want.'],
  ['Unscheduled Delight','Claim an hour protected exclusively for whatever feels delicious.'],
  ['Major Relic','Choose one planned real-world reward from your personal wish list.'],
];
function rewardChoices(category: LifeCategory, level: number): RewardChoice[] {
  const digital = DIGITAL_REWARDS[category];
  const realCount = level >= 20 ? 3 : level >= 10 ? 2 : level >= 5 ? 1 : 0;
  const out: RewardChoice[] = [];
  for (let i=0;i<3-realCount;i++) { const [title,description]=digital[(level+i)%digital.length]; out.push({id:randomUUID(),kind:'digital',title,description}); }
  for (let i=0;i<realCount;i++) { const [title,description]=REAL_REWARDS[(level+i)%REAL_REWARDS.length]; out.push({id:randomUUID(),kind:'real',title,description}); }
  return out.sort((a,b) => a.id.localeCompare(b.id));
}
export function createLifeQuestStore(db: Database.Database): LifeQuestStore {
  db.exec(`CREATE TABLE IF NOT EXISTS life_quests (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, task TEXT NOT NULL,
    category TEXT NOT NULL, xp INTEGER NOT NULL, bucket TEXT NOT NULL,
    status TEXT NOT NULL, scheduledDate TEXT NOT NULL,
    createdAt INTEGER NOT NULL, completedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS life_quests_day ON life_quests(status, scheduledDate);
  CREATE TABLE IF NOT EXISTS life_quest_xp (
    questId TEXT PRIMARY KEY, category TEXT NOT NULL, points INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS life_quest_rewards (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, level INTEGER NOT NULL,
    choices TEXT NOT NULL, chosen TEXT, createdAt INTEGER NOT NULL, chosenAt INTEGER,
    UNIQUE(category, level)
  );`);
  const present = (q: QuestRow) => ({ ...q, carried: q.status === 'active' && q.scheduledDate < day() });
  const state = () => {
    const quests = (db.prepare("SELECT * FROM life_quests WHERE status='active' AND scheduledDate<=? ORDER BY CASE bucket WHEN 'main' THEN 0 ELSE 1 END, createdAt, rowid").all(day()) as QuestRow[]).map(present);
    const rows = db.prepare('SELECT category, COALESCE(SUM(points),0) points FROM life_quest_xp GROUP BY category').all() as { category: LifeCategory; points: number }[];
    const by = new Map(rows.map(r => [r.category, r.points]));
    const categories = LIFE_CATEGORIES.map(id => { const points = by.get(id) ?? 0; return { id, points, ...categoryLevel(points) }; });
    const rewardRows = db.prepare('SELECT * FROM life_quest_rewards ORDER BY createdAt DESC').all() as Array<{id:string;category:LifeCategory;level:number;choices:string;chosen:string|null;chosenAt:number|null}>;
    const pendingRewards: PendingReward[] = rewardRows.filter(r=>!r.chosen).map(r=>({id:r.id,category:r.category,level:r.level,choices:(JSON.parse(r.choices) as RewardChoice[]).map((c,i)=>({id:c.id,mark:['✦','☾','❧'][i]}))}));
    const collection: EarnedReward[] = rewardRows.filter(r=>r.chosen).map(r=>{const choices=JSON.parse(r.choices) as RewardChoice[];const choice=choices.find(c=>c.id===r.chosen)!;return {...choice,vaultId:r.id,category:r.category,level:r.level,chosenAt:r.chosenAt!};});
    return { quests, categories, totalXp: categories.reduce((n, c) => n + c.points, 0), pendingRewards, collection };
  };
  const get = (id: string) => {
    const row = db.prepare('SELECT * FROM life_quests WHERE id=?').get(id) as QuestRow | undefined;
    if (!row) throw new QuestError('Quest not found.', 404);
    return row;
  };
  return {
    state,
    add: db.transaction((drafts: unknown[]) => {
      if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 20) throw new QuestError('Choose between 1 and 20 quests.');
      const insert = db.prepare("INSERT INTO life_quests(id,title,task,category,xp,bucket,status,scheduledDate,createdAt) VALUES (?,?,?,?,?,?,'active',?,?)");
      for (const raw of drafts) { const q = validDraft(raw); const bucket = (raw as { bucket?: unknown } | null)?.bucket; insert.run(randomUUID(), q.title, q.task, q.category, q.xp, bucket === 'main' ? 'main' : 'side', day(), Date.now()); }
      return state();
    }),
    change: db.transaction((id: string, action: unknown, patch: any) => {
      const q = get(id);
      if (action === 'complete') {
        if (q.status !== 'active') return state();
        const before = db.prepare('SELECT COALESCE(SUM(points),0) points FROM life_quest_xp WHERE category=?').get(q.category) as {points:number};
        const now = Date.now();
        db.prepare("UPDATE life_quests SET status='completed', completedAt=? WHERE id=?").run(now, id);
        db.prepare('INSERT OR IGNORE INTO life_quest_xp(questId,category,points,createdAt) VALUES (?,?,?,?)').run(id, q.category, q.xp, now);
        const oldLevel=categoryLevel(before.points).level, newLevel=categoryLevel(before.points+q.xp).level;
        const reward=db.prepare('INSERT OR IGNORE INTO life_quest_rewards(id,category,level,choices,createdAt) VALUES (?,?,?,?,?)');
        for(let level=oldLevel+1;level<=newLevel;level++) reward.run(randomUUID(),q.category,level,JSON.stringify(rewardChoices(q.category,level)),now);
      } else if (action === 'delete') db.prepare('DELETE FROM life_quests WHERE id=?').run(id);
      else if (action === 'bucket') db.prepare('UPDATE life_quests SET bucket=? WHERE id=?').run(patch?.bucket === 'main' ? 'main' : 'side', id);
      else if (action === 'edit') {
        const next = validDraft({ title: patch?.title ?? q.title, task: patch?.task ?? q.task, category: patch?.category ?? q.category, xp: patch?.xp ?? q.xp });
        db.prepare('UPDATE life_quests SET title=?, task=?, category=?, xp=? WHERE id=?').run(next.title, next.task, next.category, next.xp, id);
      } else throw new QuestError('Unknown quest action.');
      return state();
    }),
    chooseReward: db.transaction((id: string, choiceId: unknown) => {
      if(typeof choiceId!=='string') throw new QuestError('Choose one of the three sealed rewards.');
      const row=db.prepare('SELECT choices, chosen FROM life_quest_rewards WHERE id=?').get(id) as {choices:string;chosen:string|null}|undefined;
      if(!row) throw new QuestError('Reward vault not found.',404);
      if(row.chosen) return state();
      const choices=JSON.parse(row.choices) as RewardChoice[];
      if(!choices.some(c=>c.id===choiceId)) throw new QuestError('That reward was not inside this vault.');
      db.prepare('UPDATE life_quest_rewards SET chosen=?, chosenAt=? WHERE id=? AND chosen IS NULL').run(choiceId,Date.now(),id);
      return state();
    }),
  };
}
