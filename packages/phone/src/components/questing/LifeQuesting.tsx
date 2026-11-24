import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Castle, Check, Gem, Gift, HeartHandshake, HeartPulse, MoonStar, Paintbrush, PartyPopper, Plus, Sparkles, Trash2, WandSparkles } from 'lucide-react';
import { apiFetch } from '../../bytelight';
import type { ThemeColors } from '../../lib/theme';
import { cn } from '../../lib/utils';

export const LIFE_META = {
  artistry: { name: 'Artistry', plain: 'Creative', color: '#e99bc1', Icon: Paintbrush },
  vitality: { name: 'Vitality', plain: 'Health', color: '#91b889', Icon: HeartPulse },
  dominion: { name: 'Dominion', plain: 'Adulting', color: '#d9ae62', Icon: Castle },
  lore: { name: 'Lore', plain: 'Knowledge', color: '#9499dc', Icon: BookOpen },
  revelry: { name: 'Revelry', plain: 'Joy', color: '#efa57f', Icon: PartyPopper },
  veil: { name: 'The Veil', plain: 'Spiritual', color: '#a982c5', Icon: MoonStar },
  bonds: { name: 'Bonds', plain: 'Connection', color: '#c96f7e', Icon: HeartHandshake },
} as const;
export type LifeCategory = keyof typeof LIFE_META;
export type LifeQuest = { id:string; title:string; task:string; category:LifeCategory; xp:number; bucket:'main'|'side'; carried:boolean; scheduledDate:string };
type PendingReward={id:string;category:LifeCategory;level:number;choices:Array<{id:string;mark:string}>};
type EarnedReward={id:string;vaultId:string;category:LifeCategory;level:number;kind:'digital'|'real';title:string;description:string;chosenAt:number};
export type LifeState = { quests:LifeQuest[]; categories:Array<{id:LifeCategory;points:number;level:number;current:number;needed:number}>; totalXp:number; pendingRewards:PendingReward[]; collection:EarnedReward[] };
export const emptyLifeState: LifeState = { quests: [], categories: Object.keys(LIFE_META).map(id => ({ id:id as LifeCategory, points:0, level:0, current:0, needed:50 })), totalXp:0, pendingRewards:[], collection:[] };

export async function lifeRequest(path = '', init?: RequestInit): Promise<LifeState> {
  const response = await apiFetch(`/api/questing/life${path}`, init);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'Questing could not open.');
  return json;
}

function LifeWheel({ state, compact=false }: { state:LifeState; compact?:boolean }) {
  const total = Math.max(1, state.totalXp);
  let cursor = 0;
  const stops:string[] = [];
  for (const c of state.categories) {
    const share = state.totalXp ? (c.points / total) * 100 : 100 / 7;
    const end = cursor + share;
    const color = LIFE_META[c.id].color;
    stops.push(`${color} ${cursor}% ${end}%`); cursor = end;
  }
  const level = state.categories.reduce((n,c) => n + c.level, 0);
  return <div className={cn('relative mx-auto rounded-full p-[3px]', compact ? 'h-24 w-24' : 'h-64 w-64')} style={{ background:`conic-gradient(${stops.join(',')})`, boxShadow:'0 0 30px color-mix(in srgb, var(--bytelight-accent) 24%, transparent)' }}>
    <div className="absolute inset-[13%] flex flex-col items-center justify-center rounded-full border text-center" style={{background:'var(--bytelight-surface-strong)',borderColor:'var(--bytelight-hairline)'}}>
      <Sparkles size={compact ? 13 : 22} style={{color:'var(--bytelight-accent)'}} />
      <strong className={compact ? 'text-sm' : 'text-2xl'}>{level}</strong>
      <span className={compact ? 'text-[8px]' : 'text-[10px] uppercase tracking-widest'}>Life level</span>
      {!compact && <span className="mt-1 text-xs opacity-70">{state.totalXp} XP</span>}
    </div>
    {!compact && state.categories.map((c,i) => c.level > 1 && <span key={c.id} aria-hidden className="absolute animate-pulse text-white" style={{left:`${48 + 39*Math.cos((i/7)*Math.PI*2-Math.PI/2)}%`,top:`${48 + 39*Math.sin((i/7)*Math.PI*2-Math.PI/2)}%`,textShadow:'0 0 8px white'}}>✦</span>)}
  </div>;
}

function Dashboard({ state, colors }: {state:LifeState;colors:ThemeColors}) {
  return <div className="space-y-5">
    <LifeWheel state={state} />
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{state.categories.map(c => { const m=LIFE_META[c.id]; const pct=Math.min(100,(c.current/c.needed)*100); return <article key={c.id} data-appearance-card="" className={cn('rounded-2xl border p-3',colors.panelBg,colors.panelBorder)}>
      <div className="flex items-center gap-3"><m.Icon size={22} strokeWidth={1.8} style={{color:m.color}}/><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><strong>{m.name}</strong><span className="text-xs">Level {c.level}</span></div><p className={cn('text-[10px]',colors.textMuted)}>{m.plain} · {c.points} XP</p></div></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{background:'var(--bytelight-hairline)'}}><div className="h-full rounded-full transition-all" style={{width:`${pct}%`,background:m.color,boxShadow:c.level>2?`0 0 9px ${m.color}`:undefined}} /></div>
      <p className={cn('mt-1 text-right text-[10px]',colors.textMuted)}>{c.needed-c.current} XP to next level</p>
    </article>;})}</div>
  </div>;
}

function RewardVault({state,colors,onChange}:{state:LifeState;colors:ThemeColors;onChange:(s:LifeState)=>void}) {
  const [busy,setBusy]=useState(false); const pending=state.pendingRewards[0];
  const choose=async(choiceId:string)=>{if(!pending)return;setBusy(true);try{onChange(await lifeRequest(`/rewards/${pending.id}/choose`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choiceId})}));}finally{setBusy(false)}};
  return <div className="space-y-4">{pending&&<section data-appearance-card="" className={cn('overflow-hidden rounded-3xl border p-5 text-center',colors.panelBg,colors.panelBorder)} style={{boxShadow:`0 0 32px color-mix(in srgb, ${LIFE_META[pending.category].color} 28%, transparent)`}}><Gift className="mx-auto mb-2" style={{color:LIFE_META[pending.category].color}}/><p className="text-[10px] uppercase tracking-[.24em]">Level {pending.level} · {LIFE_META[pending.category].name}</p><h2 className="mt-1 text-xl font-semibold">Three rewards are sealed.</h2><p className={cn('mt-1 text-sm',colors.textMuted)}>Choose one. The others vanish unopened.</p><div className="mt-5 grid grid-cols-3 gap-2">{pending.choices.map((choice,i)=><button key={choice.id} disabled={busy} onClick={()=>void choose(choice.id)} aria-label={`Choose sealed reward ${i+1}`} className="relative aspect-[3/4] overflow-hidden rounded-2xl border text-3xl transition-transform active:scale-95 disabled:opacity-50" style={{borderColor:LIFE_META[pending.category].color,background:`linear-gradient(145deg, color-mix(in srgb, ${LIFE_META[pending.category].color} 45%, var(--bytelight-surface)), var(--bytelight-surface-strong))`,boxShadow:`inset 0 0 22px ${LIFE_META[pending.category].color}44`}}><span className="absolute inset-2 rounded-xl border opacity-50"/><span className="relative">{choice.mark}</span></button>)}</div></section>}{state.pendingRewards.length>1&&<p className={cn('text-center text-xs',colors.textMuted)}>+ {state.pendingRewards.length-1} more sealed vault{state.pendingRewards.length===2?'':'s'} waiting</p>}<section className="space-y-2"><h2 className="text-xs uppercase tracking-widest" style={{color:colors.accent}}>Your Collection</h2>{!state.collection.length&&<div data-appearance-card="" className={cn('rounded-2xl border p-5 text-center text-sm',colors.panelBg,colors.panelBorder,colors.textMuted)}>Your first relic appears when any category reaches Level 1.</div>}{state.collection.map(r=>{const M=LIFE_META[r.category];return <article key={r.vaultId} data-appearance-card="" className={cn('rounded-2xl border p-4',colors.panelBg,colors.panelBorder)} style={{borderLeft:`3px solid ${M.color}`}}><div className="flex items-start gap-3">{r.kind==='real'?<Gem size={24} style={{color:M.color}}/>:<M.Icon size={24} strokeWidth={1.8} style={{color:M.color}}/>}<div><div className="flex flex-wrap items-center gap-2"><strong>{r.title}</strong>{r.kind==='real'&&<span className="rounded-full border px-2 py-0.5 text-[9px] uppercase">Real-world reward</span>}</div><p className={cn('mt-1 text-sm',colors.textMuted)}>{r.description}</p><p className="mt-2 text-[9px] uppercase tracking-widest" style={{color:M.color}}>{M.name} · Level {r.level}</p></div></div></article>})}</section></div>;
}

function QuestCard({ q, colors, onChange }: {q:LifeQuest;colors:ThemeColors;onChange:(s:LifeState)=>void}) {
  const [busy,setBusy]=useState(false); const m=LIFE_META[q.category];
  const act=async(action:string,extra={})=>{setBusy(true);try{onChange(await lifeRequest(`/${q.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})}));window.dispatchEvent(new Event('bytelight:life-quests'));}finally{setBusy(false)}};
  return <article data-appearance-card="" className={cn('rounded-2xl border p-3',colors.panelBg,colors.panelBorder)} style={{borderLeft:`3px solid ${m.color}`}}>
    <div className="flex items-start gap-3"><button disabled={busy} aria-label={`Complete ${q.task}`} onClick={()=>void act('complete')} className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border" style={{borderColor:m.color,color:m.color}}><Check size={18}/></button><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="break-words">{q.title}</strong>{q.carried&&<span className="rounded-full px-2 py-0.5 text-[9px] uppercase" style={{background:'var(--bytelight-surface)'}}>Carried forward</span>}</div><p className="text-sm break-words">{q.task}</p><p className={cn('mt-1 text-[10px]',colors.textMuted)} style={{color:m.color}}>{m.name} · {q.xp} XP</p></div><button aria-label="Delete quest" disabled={busy} onClick={()=>void act('delete')} className="p-2 opacity-55"><Trash2 size={15}/></button></div>
    <button disabled={busy} onClick={()=>void act('bucket',{bucket:q.bucket==='main'?'side':'main'})} className={cn('mt-2 text-[10px] underline',colors.textMuted)}>{q.bucket==='main'?'Move to Side Quests':'Make a Main Quest'}</button>
  </article>;
}

type Draft={title:string;task:string;category:LifeCategory;xp:number;bucket?:'main'|'side'};
function Forge({ colors, onAdded }: {colors:ThemeColors;onAdded:(s:LifeState)=>void}) {
  const [dump,setDump]=useState(''); const [drafts,setDrafts]=useState<Draft[]>([]); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const forge=async()=>{setBusy(true);setError('');try{const r=await apiFetch('/api/questing/life/forge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dump})});const j=await r.json();if(!r.ok)throw new Error(j.error);setDrafts(j.quests.map((q:Draft,i:number)=>({...q,bucket:i<3?'main':'side'})));}catch(e){setError(e instanceof Error?e.message:'The Forge went dark.');}finally{setBusy(false)}};
  const add=async()=>{setBusy(true);try{const s=await lifeRequest('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quests:drafts})});onAdded(s);window.dispatchEvent(new Event('bytelight:life-quests'));setDrafts([]);setDump('');}catch(e){setError(e instanceof Error?e.message:'Could not add quests.');}finally{setBusy(false)}};
  const field=cn('w-full rounded-xl border bg-transparent px-3 py-2 text-sm',colors.panelBorder);
  if(!drafts.length)return <section data-appearance-card="" className={cn('rounded-2xl border p-4 space-y-3',colors.panelBg,colors.panelBorder)}><div><p className="text-xs uppercase tracking-widest" style={{color:colors.accent}}>The Quest Forge</p><h2 className="text-xl font-semibold">What’s rattling around in your head?</h2></div><textarea className={cn(field,'min-h-36 text-base')} value={dump} onChange={e=>setDump(e.target.value)} placeholder="Throw the whole pile in here. No formatting required." maxLength={4000}/>{error&&<p role="alert" className="text-sm text-red-400">{error}</p>}<button disabled={busy||!dump.trim()} onClick={()=>void forge()} className="min-h-11 w-full rounded-xl font-semibold disabled:opacity-50" style={{background:colors.accent,color:'var(--bytelight-on-accent)'}}><WandSparkles size={17} className="mr-2 inline"/>{busy?'Forging…':'Separate into quests'}</button></section>;
  return <div className="space-y-3"><p className={cn('text-sm',colors.textMuted)}>Review everything before it enters Today.</p>{drafts.map((q,i)=><article key={i} data-appearance-card="" className={cn('rounded-2xl border p-3 space-y-2',colors.panelBg,colors.panelBorder)}><input aria-label="Quest title" className={field} value={q.title} onChange={e=>setDrafts(d=>d.map((x,n)=>n===i?{...x,title:e.target.value}:x))}/><input aria-label="Task" className={field} value={q.task} onChange={e=>setDrafts(d=>d.map((x,n)=>n===i?{...x,task:e.target.value}:x))}/><div className="flex gap-2"><select className={field} value={q.category} onChange={e=>setDrafts(d=>d.map((x,n)=>n===i?{...x,category:e.target.value as LifeCategory}:x))}>{Object.entries(LIFE_META).map(([id,m])=><option key={id} value={id}>{m.name}</option>)}</select><select className={cn(field,'w-28')} value={q.xp} onChange={e=>setDrafts(d=>d.map((x,n)=>n===i?{...x,xp:Number(e.target.value)}:x))}>{[5,10,20,30].map(x=><option key={x} value={x}>{x} XP</option>)}</select></div><div className="flex justify-between"><button onClick={()=>setDrafts(d=>d.filter((_,n)=>n!==i))} className="text-xs opacity-65">Remove</button><button onClick={()=>setDrafts(d=>d.map((x,n)=>n===i?{...x,bucket:x.bucket==='main'?'side':'main'}:x))} className="text-xs underline">{q.bucket==='main'?'Main Quest':'Side Quest'}</button></div></article>)}{error&&<p role="alert" className="text-sm text-red-400">{error}</p>}<button disabled={busy||!drafts.length} onClick={()=>void add()} className="min-h-11 w-full rounded-xl font-semibold" style={{background:colors.accent,color:'var(--bytelight-on-accent)'}}>Forge My Day · {drafts.length} quests</button></div>;
}

export function LifeQuesting({ colors }: {colors:ThemeColors}) {
  const [state,setState]=useState<LifeState>(); const [view,setView]=useState<'today'|'wheel'|'forge'|'vault'>('today'); const [error,setError]=useState('');
  useEffect(()=>{void lifeRequest().then(setState).catch(e=>setError(e.message));},[]);
  const groups=useMemo(()=>({main:state?.quests.filter(q=>q.bucket==='main')??[],side:state?.quests.filter(q=>q.bucket==='side')??[]}),[state]);
  const tab=(id:typeof view,label:string)=><button onClick={()=>setView(id)} className="min-h-10 rounded-xl px-3 text-xs font-semibold" style={view===id?{background:colors.accent,color:'var(--bytelight-on-accent)'}:undefined}>{label}</button>;
  if(error)return <div className="mx-auto max-w-xl p-4"><div role="alert" data-appearance-card="" className={cn('rounded-2xl border p-6 text-center',colors.panelBg,colors.panelBorder)}><Sparkles className="mx-auto mb-2" style={{color:colors.accent}}/><h2 className="font-semibold">Questing is waiting for activation.</h2><p className={cn('mt-1 text-sm',colors.textMuted)}>The new screen arrived before its data service. It will open after the next service reload.</p></div></div>;
  return <div className="mx-auto max-w-xl p-4 pb-20 space-y-4"><nav data-appearance-card="" className={cn('sticky top-0 z-10 flex gap-1 rounded-2xl border p-2',colors.panelBg,colors.panelBorder)}>{tab('today','Today')}{tab('wheel','Wheel')}{tab('forge','Brain Dump')}{tab('vault',`Vault${state?.pendingRewards.length?` · ${state.pendingRewards.length}`:''}`)}</nav>{error&&<p role="alert">{error}</p>}{!state?<p className={colors.textMuted}>Opening the Life Wheel…</p>:view==='wheel'?<Dashboard state={state} colors={colors}/>:view==='forge'?<Forge colors={colors} onAdded={s=>{setState(s);setView('today')}}/>:view==='vault'?<RewardVault state={state} colors={colors} onChange={setState}/>:<div className="space-y-4">{state.pendingRewards.length>0&&<button onClick={()=>setView('vault')} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl font-semibold" style={{background:LIFE_META[state.pendingRewards[0].category].color,color:'#21151d'}}><Gift size={18}/>A reward vault is waiting</button>}<button onClick={()=>setView('forge')} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border text-sm font-semibold" style={{borderColor:colors.accent,color:colors.accent}}><Plus size={17}/>Brain dump more</button>{groups.main.length>0&&<section className="space-y-2"><h2 className="text-xs uppercase tracking-widest" style={{color:colors.accent}}>Main Quests</h2>{groups.main.map(q=><QuestCard key={q.id} q={q} colors={colors} onChange={setState}/>)}</section>}{groups.side.length>0&&<section className="space-y-2"><h2 className={cn('text-xs uppercase tracking-widest',colors.textMuted)}>Side Quests</h2>{groups.side.map(q=><QuestCard key={q.id} q={q} colors={colors} onChange={setState}/>)}</section>}{!state.quests.length&&<div data-appearance-card="" className={cn('rounded-2xl border p-6 text-center',colors.panelBg,colors.panelBorder)}><Sparkles className="mx-auto mb-2" style={{color:colors.accent}}/><h2 className="font-semibold">Today is uncharted.</h2><p className={cn('text-sm',colors.textMuted)}>Give the Forge whatever is rattling around.</p></div>}</div>}</div>;
}

export { LifeWheel };
