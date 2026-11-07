import React, { useEffect, useState } from 'react';
import { RefreshCw, Loader2, ChevronRight } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

// The Mind (Neuralis Mind Bridge) — translated from BL main's MindPanel:
// Overview (mind_health), Entities (expandable), Recent
// observations, all through the /api/mind proxy (BYOK mind_api_url/key).
// Fetches run in parallel and tolerate partial failure, BL behaviour.

interface MindAppProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

type Section = 'overview' | 'entities' | 'recent';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'entities', label: 'Entities' },
  { id: 'recent', label: 'Recent' },
];

async function fetchMind(path: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await apiFetch(`/api/mind/${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function MindApp({ themeConfig, themeMode }: MindAppProps) {
  const colors = themeConfig[themeMode];
  const [section, setSection] = useState<Section>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [healthRaw, setHealthRaw] = useState('');
  const [entities, setEntities] = useState<any[]>([]);
  const [recentObs, setRecentObs] = useState<any[]>([]);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [entityDetails, setEntityDetails] = useState<Record<string, any>>({});

  async function loadAll() {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      fetchMind('health'),
      fetchMind('entities'),
      fetchMind('recent'),
    ]);
    const [healthRes, entitiesRes, recentRes] = results;
    if (healthRes.status === 'fulfilled') setHealthRaw(healthRes.value.output || JSON.stringify(healthRes.value));
    if (entitiesRes.status === 'fulfilled') setEntities(entitiesRes.value.entities || entitiesRes.value || []);
    if (recentRes.status === 'fulfilled') setRecentObs(recentRes.value.observations || recentRes.value || []);
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length === results.length) {
      setError((failures[0] as PromiseRejectedResult).reason?.message || 'All Mind Bridge requests failed');
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleEntity(id: string) {
    if (expandedEntity === id) {
      setExpandedEntity(null);
      return;
    }
    setExpandedEntity(id);
    if (!entityDetails[id]) {
      try {
        const d = await fetchMind(`entities/${encodeURIComponent(id)}`);
        setEntityDetails((prev) => ({ ...prev, [id]: d }));
      } catch { /* card shows nothing extra */ }
    }
  }

  const card = cn('rounded-2xl border p-4', colors.panelBg, colors.panelBorder);
  const label = cn('text-[10px] font-bold uppercase tracking-[0.12em]', colors.textMuted);
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

  if (loading) {
    return <div className={cn('flex items-center justify-center py-16', colors.textMuted)}><Loader2 size={22} className="animate-spin" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all',
              colors.panelBorder,
              section === s.id ? colors.textMain : cn(colors.textMuted, 'opacity-70'),
            )}
            style={section === s.id ? { background: colors.accent + '33', borderColor: colors.accent } : undefined}
          >
            {s.label}
          </button>
        ))}
        <button onClick={loadAll} className={cn('ml-auto shrink-0 rounded-full p-2', colors.textMuted)} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {error && (
        <div className={cn(card, 'text-xs')} style={{ color: '#e05252' }}>
          {error} — check mind_api_url / mind_api_key in Secrets.
        </div>
      )}

      {section === 'overview' && (
        <div className={card}>
          <span className={label}>Mind health</span>
          <pre className={cn('mt-2 max-h-[28rem] overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed', colors.textMain)}>
            {healthRaw || 'No health report.'}
          </pre>
        </div>
      )}

      {section === 'entities' && (
        entities.length === 0 ? (
          <div className={cn('py-8 text-center text-xs', colors.textMuted)}>No entities.</div>
        ) : (
          entities.map((e: any, i: number) => {
            const id = String(e.id ?? e.name ?? i);
            const open = expandedEntity === id;
            const detail = entityDetails[id];
            return (
              <div key={id} className={card}>
                <button onClick={() => toggleEntity(id)} className="flex w-full items-center justify-between text-left">
                  <div>
                    <div className={cn('text-sm font-semibold', colors.textMain)}>{e.name || e.label || id}</div>
                    <div className={cn('text-[11px]', colors.textMuted)}>
                      {[e.kind || e.type, e.relationship, e.observation_count ? `${e.observation_count} observations` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <ChevronRight size={14} className={cn('transition-transform', colors.textMuted, open && 'rotate-90')} />
                </button>
                {open && (
                  <pre className={cn('mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px]', colors.textMuted)}>
                    {detail ? (detail.output || JSON.stringify(detail, null, 2)) : 'Loading…'}
                  </pre>
                )}
              </div>
            );
          })
        )
      )}

      {section === 'recent' && (
        recentObs.length === 0 ? (
          <div className={cn('py-8 text-center text-xs', colors.textMuted)}>No recent observations.</div>
        ) : (
          recentObs.map((o: any, i: number) => (
            <div key={o.id ?? i} className={card}>
              <div className="flex flex-wrap items-center gap-2">
                {o.emotion && <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', colors.panelBorder, colors.textMuted)}>{o.emotion}</span>}
                {o.weight && <span className={cn('text-[10px] uppercase', colors.textMuted)}>{o.weight}</span>}
                {o.entity_name && <span className={cn('text-[10px]', colors.textMuted)}>· {o.entity_name}</span>}
                <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{when(o.created_at)}</span>
              </div>
              <p className={cn('mt-2 whitespace-pre-wrap text-sm leading-relaxed', colors.textMain)}>{o.content}</p>
            </div>
          ))
        )
      )}
    </div>
  );
}
