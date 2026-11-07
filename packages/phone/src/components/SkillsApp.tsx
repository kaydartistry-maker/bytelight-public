import React, { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface SkillsAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface Skill {
  name: string;
  description: string;
}

export function SkillsApp({ onClose, themeConfig, themeMode, embedded }: SkillsAppProps) {
  const colors = themeConfig[themeMode];
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/skills');
      if (!res.ok) throw new Error('Failed to fetch skills');
      const data = await res.json();
      setSkills(data.skills || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <AppShell
      embedded={embedded}
      title="Skills"
      icon={Sparkles}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      {loading ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>Loading skills…</div>
      ) : error ? (
        <div className="text-xs py-6 text-center" style={{ color: colors.accent, opacity: 0.8 }}>{error}</div>
      ) : skills.length === 0 ? (
        <div className={cn('text-xs py-6 text-center', colors.textMuted)}>No skills found in the agent workspace.</div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className={cn('rounded-2xl border border-l-[3px] p-3', colors.panelBg, colors.panelBorder)}
              style={{ borderLeftColor: colors.accent }}
            >
              <div className={cn('text-sm font-semibold tracking-wide mb-1', colors.textMain)}>{skill.name}</div>
              {skill.description && (
                <p className={cn('text-xs leading-relaxed', colors.textMuted)}>{skill.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
