import React, { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { CcStats } from './cc/CcStats';
import { CcFinances } from './cc/CcFinances';
import { CcLists } from './cc/CcLists';
import { CcPets } from './cc/CcPets';
import { CcCalendar } from './cc/CcCalendar';
import { CcCare } from './cc/CcCare';
import { CcCycle } from './cc/CcCycle';
import { CcPlanner } from './cc/CcPlanner';
import { CcOverview } from './cc/CcOverview';

interface CommandCenterAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Tab = 'overview' | 'planner' | 'calendar' | 'lists' | 'care'
  | 'cycle' | 'pets' | 'finances' | 'stats';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'planner', label: 'Planner' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'lists', label: 'Lists' },
  { id: 'care', label: 'Care' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'pets', label: 'Pets' },
  { id: 'finances', label: 'Finances' },
  { id: 'stats', label: 'Stats' },
];

// Command Center — household management, ported from the Svelte cc/* routes.
// Sub-pages live in components/cc/; more are added as they are ported.
export function CommandCenterApp({ onClose, themeConfig, themeMode }: CommandCenterAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <AppShell title="Command Center" icon={LayoutDashboard} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      <div className={cn("p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center", colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border', colors.panelBorder, tab !== t.id && colors.panelBg)}
              style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && <CcOverview themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'planner' && <CcPlanner themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'calendar' && <CcCalendar themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'lists' && <CcLists themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'care' && <CcCare themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'cycle' && <CcCycle themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'pets' && <CcPets themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'finances' && <CcFinances themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'stats' && <CcStats themeConfig={themeConfig} themeMode={themeMode} />}
    </AppShell>
  );
}
