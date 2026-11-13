import React, { useState } from 'react';
import { Bot } from 'lucide-react';
import { AppShell } from './AppShell';
import { SkillsApp } from './SkillsApp';
import { OrchestratorApp } from './OrchestratorApp';
import { PreferencesApp } from './PreferencesApp';
import { RuntimeHealthCard } from './RuntimeHealthCard';
import { CodexEngineCard } from './CodexEngineCard';
import { IdentityApp } from './IdentityApp';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';

interface AgentAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  /** Jump to Integrations (Providers tab), where Codex signs in. */
  onOpenIntegrations?: () => void;
}

type Tab = 'skills' | 'wakes' | 'models' | 'runtime' | 'identity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'skills', label: 'Skills' },
  { id: 'wakes', label: 'Wakes' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'identity', label: 'Identity' },
];

// The agent's one home: which models drive each lane (Preferences), which
// skills it has, what wakes fire and with which effective prompts
// (Orchestrator), what actually runs where (Runtime), and the identity and
// memory files behind the warm lane (Identity — formerly X-Ray).
export function AgentApp({ onClose, themeConfig, themeMode, onOpenIntegrations }: AgentAppProps) {
  const colors = themeConfig[themeMode];
  const [tab, setTab] = useState<Tab>('models');

  return (
    <AppShell title="Agent" icon={Bot} onClose={onClose} themeConfig={themeConfig} themeMode={themeMode}>
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

      {tab === 'models' && <PreferencesApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'skills' && <SkillsApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {tab === 'wakes' && <OrchestratorApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
      {/* Both engines: Claude (CLI lane / SDK) and Codex (which login it stands on).
          The per-lane report (RuntimeApp, on /orchestrator/runtime, which main
          lacks) returns with its own port slice. */}
      {tab === 'runtime' && (
        <>
          <RuntimeHealthCard themeConfig={themeConfig} themeMode={themeMode} />
          <CodexEngineCard themeConfig={themeConfig} themeMode={themeMode} onOpenProviders={onOpenIntegrations} />
        </>
      )}
      {tab === 'identity' && <IdentityApp embedded onClose={onClose} themeConfig={themeConfig} themeMode={themeMode} />}
    </AppShell>
  );
}
