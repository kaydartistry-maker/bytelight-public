import { randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QuestError } from './life-quests.js';

export const DICE_REWARDS: Record<number,string> = {
  2:'Truth', 3:'Dare', 4:'Surprise Picture', 5:'Creature', 6:'Drink',
  7:'World Change', 8:'Bizarre Sex', 9:'Portal', 10:'Relic', 11:'Wish', 12:'Wild Magic',
};
const text=(value:unknown,max:number,label:string)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new QuestError(`Enter ${label}.`);return value.trim();};
export type DoublesArtifact={kind:string;title:string;content:string;createdAt:number};
export interface DoublesState { version:3; session:null|{id:string;partner:string;partnerId:string|null;mode:string;status:string;createdAt:number;rounds:Array<{id:string;round:number;yourTask:string;partnerTask:string;status:string;dieOne:number|null;dieTwo:number|null;total:number|null;reward:string|null;kickoff:string|null;reaction:string|null;delivery:string|null;taskArtifact:DoublesArtifact|null;rewardArtifact:DoublesArtifact|null;startedAt:number;rolledAt:number|null}>}; rewards:typeof DICE_REWARDS; }
export interface DoublesStore {
  state(): DoublesState;
  start(partner:unknown,partnerId?:unknown,mode?:unknown): DoublesState;
  begin(yourTask:unknown,partnerTask:unknown): DoublesState;
  roll(): DoublesState & {result:{dieOne:number;dieTwo:number;total:number;reward:string}};
  reset(): DoublesState;
  setRoundVoice(id:string,fields:{kickoff?:string;reaction?:string;delivery?:string}): DoublesState;
  setRoundArtifacts(id:string,fields:{taskArtifact?:DoublesArtifact;rewardArtifact?:DoublesArtifact}): DoublesState;
}

export function createDoublesDiceStore(db:Database.Database): DoublesStore {
  db.exec(`CREATE TABLE IF NOT EXISTS doubles_sessions(id TEXT PRIMARY KEY,partner TEXT NOT NULL,partnerId TEXT,mode TEXT NOT NULL DEFAULT 'human',status TEXT NOT NULL,createdAt INTEGER NOT NULL,completedAt INTEGER);
  CREATE TABLE IF NOT EXISTS doubles_rounds(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,round INTEGER NOT NULL,yourTask TEXT NOT NULL,partnerTask TEXT NOT NULL,status TEXT NOT NULL,dieOne INTEGER,dieTwo INTEGER,total INTEGER,reward TEXT,kickoff TEXT,reaction TEXT,delivery TEXT,taskArtifact TEXT,rewardArtifact TEXT,startedAt INTEGER NOT NULL,rolledAt INTEGER,UNIQUE(sessionId,round));`);
  const cols=(table:string)=>new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(x=>x.name));
  const sessions=cols('doubles_sessions');if(!sessions.has('partnerId'))db.exec('ALTER TABLE doubles_sessions ADD COLUMN partnerId TEXT');if(!sessions.has('mode'))db.exec("ALTER TABLE doubles_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'human'");
  const rounds=cols('doubles_rounds');for(const c of ['kickoff','reaction','delivery','taskArtifact','rewardArtifact'])if(!rounds.has(c))db.exec(`ALTER TABLE doubles_rounds ADD COLUMN ${c} TEXT`);
  const state=():DoublesState=>{const session=db.prepare("SELECT * FROM doubles_sessions ORDER BY createdAt DESC LIMIT 1").get() as any;if(!session)return{version:3,session:null,rewards:DICE_REWARDS};session.rounds=(db.prepare('SELECT * FROM doubles_rounds WHERE sessionId=? ORDER BY round').all(session.id) as any[]).map(r=>({...r,taskArtifact:r.taskArtifact?JSON.parse(r.taskArtifact):null,rewardArtifact:r.rewardArtifact?JSON.parse(r.rewardArtifact):null}));return{version:3,session,rewards:DICE_REWARDS};};
  return {
    state,
    start:db.transaction((partner:unknown,partnerId?:unknown,mode?:unknown)=>{const active=state().session;if(active?.status==='active')return state();const companionMode=mode==='companion';db.prepare("INSERT INTO doubles_sessions(id,partner,partnerId,mode,status,createdAt) VALUES (?,?,?,?,'active',?)").run(randomUUID(),text(partner,60,'your doubling partner'),companionMode&&typeof partnerId==='string'?partnerId:null,companionMode?'companion':'human',Date.now());return state();}),
    begin:db.transaction((yourTask:unknown,partnerTask:unknown)=>{const s=state().session;if(!s||s.status!=='active')throw new QuestError('Start a Doubles & Dice session first.');const current=s.rounds.find(r=>r.status==='working');if(current)throw new QuestError('Finish the current round before beginning another.');if(s.rounds.length>=3)throw new QuestError('All three rounds are complete.');db.prepare("INSERT INTO doubles_rounds(id,sessionId,round,yourTask,partnerTask,status,startedAt) VALUES (?,?,?,?,?,'working',?)").run(randomUUID(),s.id,s.rounds.length+1,text(yourTask,180,'your task'),text(partnerTask,180,"your partner's task"),Date.now());return state();}),
    roll:db.transaction(()=>{const s=state().session;if(!s||s.status!=='active')throw new QuestError('No Doubles & Dice session is active.');const round=s.rounds.find(r=>r.status==='working');if(!round)throw new QuestError('Begin a round before rolling.');const dieOne=randomInt(1,7),dieTwo=randomInt(1,7),total=dieOne+dieTwo,now=Date.now();db.prepare("UPDATE doubles_rounds SET status='rolled',dieOne=?,dieTwo=?,total=?,reward=?,rolledAt=? WHERE id=?").run(dieOne,dieTwo,total,DICE_REWARDS[total],now,round.id);if(round.round===3)db.prepare("UPDATE doubles_sessions SET status='completed',completedAt=? WHERE id=?").run(now,s.id);return { ...state(), result:{dieOne,dieTwo,total,reward:DICE_REWARDS[total]} };}),
    reset:db.transaction(()=>{const s=state().session;if(s)db.prepare("UPDATE doubles_sessions SET status='abandoned',completedAt=? WHERE id=?").run(Date.now(),s.id);return state();}),
    setRoundVoice:db.transaction((id:string,fields:{kickoff?:string;reaction?:string;delivery?:string})=>{const row=db.prepare('SELECT id FROM doubles_rounds WHERE id=?').get(id);if(!row)throw new QuestError('Doubling round not found.',404);db.prepare('UPDATE doubles_rounds SET kickoff=COALESCE(?,kickoff),reaction=COALESCE(?,reaction),delivery=COALESCE(?,delivery) WHERE id=?').run(fields.kickoff??null,fields.reaction??null,fields.delivery??null,id);return state();}),
    setRoundArtifacts:db.transaction((id:string,fields:{taskArtifact?:DoublesArtifact;rewardArtifact?:DoublesArtifact})=>{const row=db.prepare('SELECT id FROM doubles_rounds WHERE id=?').get(id);if(!row)throw new QuestError('Doubling round not found.',404);db.prepare('UPDATE doubles_rounds SET taskArtifact=COALESCE(?,taskArtifact),rewardArtifact=COALESCE(?,rewardArtifact) WHERE id=?').run(fields.taskArtifact?JSON.stringify(fields.taskArtifact):null,fields.rewardArtifact?JSON.stringify(fields.rewardArtifact):null,id);return state();}),
  };
}
