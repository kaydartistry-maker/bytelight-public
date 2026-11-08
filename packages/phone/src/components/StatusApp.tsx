import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import { AppShell } from './AppShell';
import { SystemApp } from './SystemApp';
import { SessionsApp } from './SessionsApp';
import { ErrorBoundary } from './ErrorBoundary';
import { UsageApp } from './UsageApp';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface StatusAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Tab = 'status' | 'sessions' | 'usage';
const TABS: { id: Tab; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
];

// Grouped wrapper for read-only views of the running system: live
// connection/runtime stats, session history, token spend, and the file
// browser. Each tab embeds the existing standalone app.
export function StatusApp({ onClose, themeConfig, themeMode }: StatusAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('status');

  return (
    <AppShell title="Status" icon={Activity} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
      <div className={cn("p-3 rounded-2xl border backdrop-blur-md mb-4 flex justify-center", colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border', colors.panelBorder, tab !== t.id && colors.panelBg)}
              style={tab === t.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'status' && <SystemApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'sessions' && <ErrorBoundary label="Sessions"><SessionsApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} /></ErrorBoundary>}
      {tab === 'usage' && <UsageApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
    </AppShell>
  );
}
