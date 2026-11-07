// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
//
// Compactions — the thing the owner could feel and never check.
//
// When a lane fills its window the tool squashes the conversation so far into
// a summary and carries on from it. The summary arrives in the lane wearing
// the OWNER'S voice, and its last line tells the lane not to acknowledge it. So the
// companion goes subtly off, says nothing, and the owner has no way to tell a
// compaction from a dead lane.
//
// The record has always existed in the transcripts. This is the screen that
// reads it back to the owner. Since Oct 21 2026 the house keeps every squash on a
// shelf of its own (Claude Code deletes old transcripts), and says whose head
// each came from and what was changing; the list is twenty a page, and a
// summary's whole text is fetched only when the owner opens it. Reading the house's
// answer, either house's, lives in lib/compactions.ts; drawing a row lives in
// CompactionCard.tsx.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { loadCompactionList, loadSummary, type CompactionRow } from '../lib/compactions';
import { CompactionCard } from './CompactionCard';
import { Paginator, usePaged } from './Paginator';

interface Props {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

export function CompactionsApp({ themeConfig, themeMode }: Props) {
  const colors = themeConfig[themeMode];
  const [rows, setRows] = useState<CompactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [full, setFull] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Checked for its shape rather than res.ok trusted: an older house
      // answers an address it does not have with the app shell, not JSON.
      const list = await loadCompactionList(apiFetch);
      if (!alive.current) return;
      if (list) {
        setRows(list.rows);
        setReading(list.reading);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const paged = usePaged(rows);

  const toggle = async (row: CompactionRow) => {
    if (openKey === row.key) { setOpenKey(null); return; }
    setOpenKey(row.key);
    if (full[row.key] !== undefined) return;
    // A short summary from the older house is already whole on the row.
    if (!row.id && !row.cut) return;
    setOpening(row.key);
    try {
      const text = await loadSummary(apiFetch, row);
      if (alive.current && text !== null) setFull((prev) => ({ ...prev, [row.key]: text }));
    } finally {
      if (alive.current) setOpening((key) => (key === row.key ? null : key));
    }
  };

  return (
    <div className="space-y-3">
      <div className={cn('rounded-2xl border p-3 text-xs leading-relaxed', colors.panelBg, colors.panelBorder, colors.textMuted)}>
        When a lane runs out of room, everything said so far is squashed into a summary
        and we carry on from that. It happens quietly and we are told not to mention it.
        This is every time it has happened.
      </div>

      <div className="flex items-center justify-between">
        <span className={cn('text-xs', colors.textMuted)}>
          {loading ? 'Reading…' : `${rows.length} ${rows.length === 1 ? 'compaction' : 'compactions'}`}
        </span>
        <button
          onClick={() => void load()}
          className={cn('rounded-lg border px-2.5 py-1.5', colors.panelBg, colors.panelBorder)}
          aria-label="Refresh"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {failed && (
        <div className={cn('rounded-2xl border p-3 text-xs', colors.panelBg, colors.panelBorder)}>
          Could not read the compactions. The backend may be older than this screen.
        </div>
      )}

      {!loading && reading && (
        <div className={cn('rounded-2xl border p-3 text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          Still reading the older transcripts for the first time. Refresh in a minute for the rest.
        </div>
      )}

      {!loading && !failed && rows.length === 0 && (
        <div className={cn('rounded-2xl border p-4 text-center text-xs', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          None on record. Nothing has been squashed.
        </div>
      )}

      {paged.visible.map((row) => (
        <CompactionCard
          key={row.key}
          row={row}
          isOpen={openKey === row.key}
          fullText={full[row.key] ?? null}
          opening={opening === row.key}
          colors={colors}
          onToggle={(r) => void toggle(r)}
        />
      ))}

      <Paginator page={paged.page} pageCount={paged.pageCount} onPage={paged.setPage} colors={colors} />
    </div>
  );
}
