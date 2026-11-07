import React, { useState } from 'react';
import { Brain } from 'lucide-react';
import { AppShell } from './AppShell';
import { CortexApp } from './CortexApp';
import { MindApp } from './MindApp';
import { MemoryBlocksApp } from './MemoryBlocksApp';
import { SelfKnowledgeApp } from './SelfKnowledgeApp';
import { ReceiptsApp } from './ReceiptsApp';
import { CompactionsApp } from './CompactionsApp';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface MemoryAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Tab = 'mind' | 'cortex' | 'blocks' | 'selfknowledge' | 'receipts' | 'compactions';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mind', label: 'Mind' },
  { id: 'cortex', label: 'Cortex' },
  { id: 'blocks', label: 'Blocks' },
  { id: 'selfknowledge', label: 'Self-Knowledge' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'compactions', label: 'Compactions' },
];

// One roof over everything the house remembers: Cortex (the searchable
// archive, its own tabs intact), the live core-memory Blocks, and the
// Self-Knowledge drawers. Each keeps its full flow — this shell only holds
// the doors. Journal deliberately stays its own app.
export function MemoryApp({ onClose, themeConfig, themeMode }: MemoryAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('mind');

  return (
    <AppShell title="Memory" icon={Brain} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
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

            {tab === 'mind' && <MindApp themeConfig={themeConfig} themeMode={themeMode} />}
{tab === 'cortex' && <CortexApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'blocks' && <MemoryBlocksApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'receipts' && <ReceiptsApp themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'selfknowledge' && <SelfKnowledgeApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'compactions' && <CompactionsApp themeConfig={themeConfig} themeMode={themeMode} />}
    </AppShell>
  );
}
