import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from './AppShell';
import { BossBattles } from './games/BossBattles';
import type { ThemeConfig } from '../lib/theme';
import { LifeQuesting } from './questing/LifeQuesting';
import { cn } from '../lib/utils';
import { DoublesDice } from './questing/DoublesDice';

export function QuestingApp({ onClose, themeConfig, themeMode }: { onClose: () => void; themeConfig: ThemeConfig; themeMode: 'dark' | 'light' }) {
  const [room,setRoom]=useState<'life'|'boss'|'doubles'>('life'); const colors=themeConfig[themeMode];
  return <AppShell title="Questing" icon={Sparkles} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} bodyClassName="p-0">
    <div className={cn('flex gap-1 overflow-x-auto border-b px-4 py-2',colors.panelBorder)}><button onClick={()=>setRoom('life')} className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold" style={room==='life'?{background:colors.accent,color:'var(--bytelight-on-accent)'}:undefined}>Life Wheel</button><button onClick={()=>setRoom('doubles')} className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold" style={room==='doubles'?{background:colors.accent,color:'var(--bytelight-on-accent)'}:undefined}>Doubles & Dice</button><button onClick={()=>setRoom('boss')} className="shrink-0 rounded-xl px-3 py-2 text-xs font-semibold" style={room==='boss'?{background:colors.accent,color:'var(--bytelight-on-accent)'}:undefined}>Boss Battles</button></div>
    {room==='life'?<LifeQuesting colors={colors}/>:room==='doubles'?<DoublesDice colors={colors}/>:<BossBattles colors={colors}/>}
  </AppShell>;
}
