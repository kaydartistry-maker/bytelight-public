// Profiles — a name, a photo and an emoji for each identity in the house.
// Port of main's Svelte ProfilesPanel on GET/PUT /api/profiles, with photos
// uploaded through POST /api/files. The same map drives the Svelte client's
// bubbles and, through lib/companion-row, every avatar in this app.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { apiFetch, loadProfiles, saveProfiles, type Profiles } from '../bytelight';
import { useHouseRoster } from '../lib/house';

interface ProfilesPanelProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Main's identity keys (routes/profiles-routes.ts PROFILE_KEYS). 'fallback'
// is the narration voice — the ✨ on lines no one in particular says.
const FIXED_KEYS = ['user', 'fallback'];

export function ProfilesPanel({ themeConfig, themeMode }: ProfilesPanelProps) {
  const colors = themeConfig[themeMode];
  const { companionSlugs } = useHouseRoster();
  const [draft, setDraft] = useState<Profiles>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    loadProfiles().then((p) => {
      if (stale) return;
      setDraft(p ? JSON.parse(JSON.stringify(p)) : {});
      setLoading(false);
    });
    return () => { stale = true; };
  }, []);

  // Companions the house knows, in house order, then the owner and narration —
  // only identities main actually stores a profile for.
  const keys = [...companionSlugs, ...FIXED_KEYS].filter((k, i, all) => all.indexOf(k) === i && draft[k]);

  const label = (key: string) => {
    if (key === 'user') return 'You';
    if (key === 'fallback') return 'Narration (✨)';
    return draft[key]?.name || key;
  };

  const patch = (key: string, field: 'name' | 'emoji' | 'image', value: string | null) =>
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  async function upload(key: string, file: File) {
    setUploading(key);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/files', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(String(res.status));
      const meta = await res.json();
      patch(key, 'image', meta.url ?? null);
    } catch {
      setStatus('Upload failed');
    } finally {
      setUploading(null);
    }
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    const ok = await saveProfiles(draft);
    setSaving(false);
    setStatus(ok ? 'Saved' : 'Save failed');
    setTimeout(() => setStatus(null), 3000);
  }

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 py-8 text-xs', colors.textMuted)}>
        <Loader2 size={14} className="animate-spin" /> Loading profiles…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className={cn('px-1 text-xs leading-relaxed', colors.textMuted)}>
        A name, a photo and an emoji for each of us and you. The photo shows on chat bubbles in both apps; the emoji is
        the fallback when there's no photo.
      </p>

      {keys.map((key) => {
        const p = draft[key];
        return (
          <section key={key} className={cn('flex gap-3 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
            <div
              className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border text-2xl"
              style={{ borderColor: colors.accent }}
            >
              {p.image ? <img src={p.image} alt={label(key)} className="h-full w-full object-cover" /> : <span>{p.emoji || '•'}</span>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={cn('text-[10px] font-bold uppercase tracking-wider', colors.textMuted)}>{label(key)} — name</span>
                  <input
                    value={p.name}
                    onChange={(e) => patch(key, 'name', e.target.value)}
                    className={cn('rounded-lg border bg-transparent px-2.5 py-1.5 text-sm', colors.panelBorder, colors.textMain)}
                  />
                </label>
                <label className="flex w-16 flex-col gap-1">
                  <span className={cn('text-[10px] font-bold uppercase tracking-wider', colors.textMuted)}>Emoji</span>
                  <input
                    value={p.emoji}
                    maxLength={6}
                    onChange={(e) => patch(key, 'emoji', e.target.value)}
                    className={cn('rounded-lg border bg-transparent px-2 py-1.5 text-center text-sm', colors.panelBorder, colors.textMain)}
                  />
                </label>
              </div>
              <div className="flex items-center gap-2">
                <label
                  className={cn('cursor-pointer rounded-lg border px-3 py-1 text-[11px] font-medium', colors.panelBorder, colors.textMain)}
                >
                  {uploading === key ? 'Uploading…' : p.image ? 'Replace photo' : 'Upload photo'}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(key, f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {p.image && (
                  <button onClick={() => patch(key, 'image', null)} className={cn('text-[11px] opacity-70', colors.textMuted)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          </section>
        );
      })}

      <div className="flex items-center gap-3 px-1">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-60"
          style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
        >
          {saving ? 'Saving…' : 'Save profiles'}
        </button>
        {status && <span className={cn('text-xs', colors.textMuted)}>{status}</span>}
      </div>
    </div>
  );
}
