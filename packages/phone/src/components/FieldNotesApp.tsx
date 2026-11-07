// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Field Notes: what the morning look found, in plain words, one day at a time.
//
// Asked for Oct 22 2026: a plain page of what the companions find each
// day, not technical. The
// companions write a sentence or two through the loopback door; this page only
// reads, newest day first, and groups each day's notes under its date.
import React, { useEffect, useState } from 'react';
import { Telescope, RefreshCw, Loader2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { themeInk } from '../lib/theme-ink';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';

interface FieldNotesAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface FieldNote {
  id: string;
  day: string;
  companion: string;
  text: string;
  createdAt: string;
}

// byte-light's /api/companions rows: id (the slug), display_name, and avatar
// (an image URL). There is no per-companion colour, so the theme accent stands
// in and themeInk still fits it to the page.
interface Companion {
  id: string;
  display_name: string;
  avatar: string | null;
}

/** "Thursday, Oct 22" for a YYYY-MM-DD day; the day is already on their calendar. */
function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Notes grouped by day, keeping the order the house sent them in. */
function byDay(notes: FieldNote[]): Array<[string, FieldNote[]]> {
  const days: Array<[string, FieldNote[]]> = [];
  for (const note of notes) {
    const last = days[days.length - 1];
    if (last && last[0] === note.day) last[1].push(note);
    else days.push([note.day, [note]]);
  }
  return days;
}

export function FieldNotesApp({ onClose, themeConfig, themeMode, embedded }: FieldNotesAppProps) {
  const colors = themeConfig[themeMode];
  const [notes, setNotes] = useState<FieldNote[]>([]);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [notesRes, companionsRes] = await Promise.all([
        apiFetch('/api/field-notes').then((r) => (r.ok ? r.json() : { notes: [] })),
        apiFetch('/api/companions').then((r) => (r.ok ? r.json() : { companions: [] })),
      ]);
      // An old backend answers this address with the app's own page, not notes.
      setNotes(Array.isArray(notesRes?.notes) ? notesRes.notes : []);
      setCompanions(companionsRes.companions || []);
    } catch (err) {
      console.error('Failed to load field notes:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const companionOf = (slug: string) => companions.find((c) => c.id === slug);

  function noteRow(note: FieldNote) {
    const companion = companionOf(note.companion);
    const accent = colors.accent;
    const ink = companion ? themeInk(companion.id, null, colors, themeMode) : accent;
    return (
      <div key={note.id} className="flex gap-2.5 py-2">
        {companion?.avatar ? (
          <img src={companion.avatar} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded-full object-cover" style={{ boxShadow: `0 0 0 1.5px ${accent}` }} />
        ) : (
          <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full" style={{ background: accent }} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold" style={{ color: ink }}>{companion?.display_name || note.companion}</div>
          <div className={cn('mt-0.5 text-sm leading-relaxed [overflow-wrap:anywhere]', colors.textMain)}>{note.text}</div>
        </div>
      </div>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Field Notes"
      icon={Telescope}
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
      {loading && notes.length === 0 ? (
        <div className={cn('rounded-2xl border py-6 text-center text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : notes.length === 0 ? (
        <div className={cn('rounded-2xl border px-4 py-6 text-center text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          Nothing yet. Notes land here when a companion writes one.
        </div>
      ) : (
        byDay(notes).map(([day, dayNotes]) => (
          <div key={day} className={cn('mb-3 rounded-2xl border px-3 pb-1 pt-2.5', colors.panelBg, colors.panelBorder)}>
            <div className={cn('text-[11px] font-semibold uppercase tracking-wider', colors.textMuted)}>{formatDay(day)}</div>
            {dayNotes.map(noteRow)}
          </div>
        ))
      )}
    </AppShell>
  );
}
