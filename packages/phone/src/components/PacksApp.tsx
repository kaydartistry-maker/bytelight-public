import React, { useEffect, useRef, useState } from 'react';
import { Sticker as StickerIcon, RefreshCw, Loader2, Plus, Upload, Trash2, X, Check } from 'lucide-react';
import { AppShell } from './AppShell';
import { Paginator, usePaged } from './Paginator';
import { ThemeConfig, ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import type { Sticker, StickerPack } from '@bytelight/shared';
import { checkStickerBytes, stickerExtension } from '../lib/sticker-upload';

interface PacksAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  // Called after an emoji change so App.tsx can re-sync the composer's
  // emoji picker without waiting for a reconnect. (Ported from full-sweep.)
  onEmojisChanged?: () => void;
}

type Pack = StickerPack;
// Emojis share the fields this screen reads (id, name, url, pack_id).
type Item = Sticker;

// Stickers and emojis are two tabs over two backends (ported from
// full-sweep). Stickers answer in envelopes ({ packs }, { stickers },
// { pack }, { sticker }); the emoji routes answer bare.
type Kind = 'stickers' | 'emojis';
const ROUTES: Record<Kind, { packs: string; items: string }> = {
  stickers: { packs: '/api/sticker-packs', items: '/api/stickers' },
  emojis: { packs: '/api/emojis/packs', items: '/api/emojis' },
};
const EMOJI_MAX_PX = 192;

export function PacksApp({ onClose, themeConfig, themeMode, onEmojisChanged }: PacksAppProps) {
  const colors = themeConfig[themeMode];
  const [kind, setKind] = useState<Kind>('stickers');
  const [packs, setPacks] = useState<Pack[]>([]);
  // Twenty packs a page.
  const packsPage = usePaged(packs);
  const [items, setItems] = useState<Item[]>([]);
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPackName, setNewPackName] = useState('');
  const [newPackDesc, setNewPackDesc] = useState('');
  // Pack and sticker deletes wait here for a yes, like classic's confirm.
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'pack' | 'item'; id: string; name: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Files the user just picked, held until they confirm the names. Built
  // from the file input's onChange — picking doesn't upload immediately
  // anymore. Each row has its own draftName so the user can edit before
  // sending. Mirrors the desktop pre-upload table.
  const [staged, setStaged] = useState<Array<{ blob: Blob; ext: string; defaultName: string; draftName: string; previewUrl: string }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const base = ROUTES[kind].items;
  const packsBase = ROUTES[kind].packs;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [packsRes, itemsRes] = await Promise.all([apiFetch(packsBase), apiFetch(base)]);
      const packsPayload = packsRes.ok ? await packsRes.json() : null;
      const itemsPayload = itemsRes.ok ? await itemsRes.json() : null;
      const packList = kind === 'emojis' ? packsPayload : packsPayload?.packs;
      const itemList = kind === 'emojis' ? itemsPayload : itemsPayload?.stickers;
      const loadedPacks: Pack[] = Array.isArray(packList) ? packList : [];
      const loadedItems: Item[] = Array.isArray(itemList) ? itemList : [];
      setPacks(loadedPacks);
      setItems(loadedItems);
      // Stay on the current pack if it still exists. Otherwise land on the
      // first real pack, falling back to the Unpacked virtual view (null)
      // when there are no real packs but legacy loose items exist.
      setSelectedPack((prev) => {
        if (prev && loadedPacks.some((p) => p.id === prev)) return prev;
        if (loadedPacks.length > 0) return loadedPacks[0].id;
        if (loadedItems.some((i) => i.pack_id === null)) return null;
        return null;
      });
    } catch {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    clearStaged();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function createPack() {
    const name = newPackName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await apiFetch(packsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: newPackDesc.trim() }),
      });
      if (res.ok) {
        const body = await res.json();
        const pack: Pack = kind === 'emojis' ? body : body.pack;
        setPacks((prev) => [...prev, pack]);
        setSelectedPack(pack.id);
        setNewPackName('');
        setNewPackDesc('');
      } else {
        setError((await res.json().catch(() => ({}))).error || 'Failed to create pack');
      }
    } finally {
      setCreating(false);
    }
  }

  async function deletePack(id: string) {
    const res = await apiFetch(`${packsBase}/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setPacks((prev) => {
        const next = prev.filter((p) => p.id !== id);
        setSelectedPack((cur) => (cur === id ? next[0]?.id ?? null : cur));
        return next;
      });
      setItems((prev) => prev.filter((i) => i.pack_id !== id));
      if (kind === 'emojis') onEmojisChanged?.();
    }
  }

  // Stage picked files into the review table. The default name is just
  // the sanitised filename — the pack prefix gets prepended at upload
  // time (only for emojis, since their namespace is flat; stickers are
  // scoped by pack in the shortcode itself). Matches the desktop pack manager.
  //
  // The bytes are BAKED HERE rather than at upload. A picked File is a handle
  // to something the operating system still owns, and on Android the read
  // grant behind it can lapse while a big batch is still being named — so a
  // read that waits until upload could fail for every file at once, minutes
  // after picking. Copying the bytes on the way in means the page holds the
  // file itself: a failure names itself while the row is still in front of
  // you, and once a row is staged it WILL upload.
  //
  // The copy is the original file, never a re-encode, so animated stickers
  // keep moving (see lib/sticker-upload).
  async function stageFiles(files: FileList) {
    if (!selectedPack) return;
    const picked = Array.from(files);
    if (fileInput.current) fileInput.current.value = '';
    const unreadable: string[] = [];
    const wrongType: string[] = [];
    const tooBig: string[] = [];
    for (const file of picked) {
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      try {
        if (kind === 'emojis') {
          // Emojis (full-sweep): PNG, WebP or GIF; stills are shrunk to
          // 192px on the way in, GIFs pass through so they keep moving.
          if (!['image/png', 'image/webp', 'image/gif'].includes(file.type)) {
            wrongType.push(base || file.name);
            continue;
          }
          const blob = await resizeImage(file, EMOJI_MAX_PX);
          const ext = blob.type === 'image/gif' ? '.gif' : blob.type === 'image/png' ? '.png' : '.webp';
          setStaged((prev) => [...prev, { blob, ext, defaultName: base, draftName: base, previewUrl: URL.createObjectURL(blob) }]);
          continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const verdict = checkStickerBytes(bytes);
        if ('reason' in verdict) {
          (verdict.reason === 'type' ? wrongType : tooBig).push(base || file.name);
          continue;
        }
        const blob = new Blob([bytes], { type: verdict.mime });
        setStaged((prev) => [...prev, {
          blob,
          ext: stickerExtension(verdict.mime),
          defaultName: base,
          draftName: base,
          previewUrl: URL.createObjectURL(blob),
        }]);
      } catch {
        unreadable.push(base || file.name);
      }
    }
    const notes: string[] = [];
    if (wrongType.length) notes.push(summarizeNames(kind === 'emojis' ? 'Only PNG, WebP and GIF files allowed. Skipped' : 'Only PNG and WebP files allowed. Skipped', wrongType));
    if (tooBig.length) notes.push(summarizeNames('Over the 2 MB limit. Skipped', tooBig));
    if (unreadable.length) notes.push(summarizeNames('Could not read', unreadable, 'try picking them again'));
    if (notes.length) setError(notes.join(' · '));
  }

  // One readable line out of a batch failure. Seventy-six names joined with
  // commas is not a message, it is a wall — and it was the only thing on
  // screen the night a whole pack failed to upload.
  function summarizeNames(prefix: string, names: string[], advice?: string): string {
    const shown = names.slice(0, 3).join(', ');
    const rest = names.length - 3;
    const body = rest > 0 ? `${shown} and ${rest} more` : shown;
    return `${prefix} ${names.length === 1 ? '' : `${names.length} `}${names.length === 1 ? 'file' : 'files'}: ${body}${advice ? ` — ${advice}` : ''}`;
  }

  // Emojis only (ported whole from full-sweep).
  // Resize on the client before upload to stay under the backend's per-
  // file caps and so users don't have to think about source resolution.
  // GIFs pass through untouched — canvas re-encoding would freeze them.
  async function resizeImage(file: File, maxSize: number): Promise<Blob> {
    if (file.type === 'image/gif') return file;
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Seventy-six of these in one batch is seventy-six live object URLs if
      // nobody hands them back.
      const src = URL.createObjectURL(file);
      const done = <T,>(fn: (v: T) => void) => (v: T) => { URL.revokeObjectURL(src); fn(v); };
      const settle = { resolve: done(resolve), reject: done(reject) };
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = (height / width) * maxSize;
            width = maxSize;
          } else {
            width = (width / height) * maxSize;
            height = maxSize;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return settle.reject(new Error('Canvas context unavailable'));
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? settle.resolve(blob) : settle.reject(new Error('Resize failed'))),
          'image/webp',
          0.9,
        );
      };
      img.onerror = () => settle.reject(new Error('Image load failed'));
      img.src = src;
    });
  }

  function updateStagedName(idx: number, value: string) {
    setStaged((prev) => prev.map((s, i) => (i === idx ? { ...s, draftName: value } : s)));
  }

  function removeStaged(idx: number) {
    setStaged((prev) => {
      const dropped = prev[idx];
      if (dropped) URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function clearStaged() {
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.previewUrl);
      return [];
    });
  }

  async function uploadStaged() {
    if (!selectedPack || staged.length === 0) return;
    setUploading(true);
    setError(null);
    const uploaded: Item[] = [];
    const errors: string[] = [];
    const packName = packs.find((p) => p.id === selectedPack)?.name || '';
    const packPrefix = packName.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const row of staged) {
      const cleaned = row.draftName.trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
      const localName = cleaned || row.defaultName;
      // Emojis live in a flat global namespace — prepend the pack name so
      // two packs can both have a "hug" without colliding. Stickers are
      // already scoped via ::pack_name:: at lookup time so they stay bare.
      const finalName = kind === 'emojis' && packPrefix ? `${packPrefix}_${localName}` : localName;
      try {
        // Copied on the way in — the bytes are ours, not the OS's.
        const form = new FormData();
        form.append('file', new File([row.blob], `${finalName}${row.ext}`, { type: row.blob.type }));
        form.append('packId', selectedPack);
        form.append('name', finalName);
        const res = await apiFetch(base, { method: 'POST', body: form });
        if (res.ok) {
          const body = await res.json();
          uploaded.push(kind === 'emojis' ? body : body.sticker);
        }
        else errors.push(`${finalName} (${(await res.json().catch(() => ({}))).error || res.status})`);
      } catch (err) {
        errors.push(`${finalName} (${err instanceof Error ? err.message : 'failed'})`);
      }
    }
    setItems((prev) => [...prev, ...uploaded]);
    if (kind === 'emojis' && uploaded.length > 0) onEmojisChanged?.();
    if (errors.length) setError(summarizeNames('Could not upload', errors));
    setUploading(false);
    clearStaged();
  }

  async function deleteItem(id: string) {
    const res = await apiFetch(`${base}/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setItems((prev) => prev.filter((i) => i.id !== id));
      if (kind === 'emojis') onEmojisChanged?.();
    }
  }

  // Inline rename — PATCHes the backend (stickers + emojis both support
  // { name } updates). The user is editing the full stored name here, so
  // underscores are allowed (emojis include the `<pack>_<name>` form).
  async function renameItem(id: string, raw: string) {
    const next = raw.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (!next) return;
    const current = items.find((it) => it.id === id);
    if (!current || current.name === next) return;
    try {
      const res = await apiFetch(`${base}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        const updated = await res.json().catch(() => null);
        const renamed = kind === 'emojis' ? updated?.name : updated?.sticker?.name;
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, name: renamed || next } : it)));
        if (kind === 'emojis') onEmojisChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(`Rename failed: ${data.error || res.status}`);
      }
    } catch {
      setError('Rename failed');
    }
  }

  // selectedPack === null means the virtual "Unpacked" view — items that
  // never had a pack_id set (legacy emojis from before pack support, or
  // anything assigned with packId=null). They show up in the picker tray
  // but were invisible from PacksApp before this view existed.
  const packItems = items.filter((i) => i.pack_id === selectedPack);
  const looseItems = items.filter((i) => i.pack_id === null);
  const hasLoose = looseItems.length > 0;
  const isLooseView = selectedPack === null && hasLoose;
  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);

  return (
    <AppShell
      title="Packs"
      icon={StickerIcon}
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
      {/* Kind toggle (ported from full-sweep) */}
      <div className={cn('rounded-2xl border p-3 backdrop-blur-md mb-3', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5">
          {(['stickers', 'emojis'] as Kind[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn('flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition-colors border', colors.panelBorder)}
              style={kind === k ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : (
        <>
          {/* Pack selector and new pack */}
          <div className={cn('rounded-2xl border p-3 backdrop-blur-md mb-3', colors.panelBg, colors.panelBorder)}>
            {/* Pack selector — real packs plus a virtual "Unpacked" chip
                when there are loose items (typically legacy emojis with
                null pack_id). */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {hasLoose && (
                <button
                  onClick={() => setSelectedPack(null)}
                  className={cn('rounded-lg px-2.5 py-1 text-xs border italic', colors.panelBorder)}
                  style={selectedPack === null ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
                >
                  Unpacked · {looseItems.length}
                </button>
              )}
              {packsPage.visible.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPack(p.id)}
                  className={cn('rounded-lg px-2.5 py-1 text-xs border', colors.panelBorder)}
                  style={selectedPack === p.id ? { background: colors.accent, color: 'var(--bytelight-on-accent)' } : undefined}
                >
                  {p.name}
                </button>
              ))}
              <Paginator page={packsPage.page} pageCount={packsPage.pageCount} onPage={packsPage.setPage} colors={colors} />
            </div>

            {/* New pack */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="New pack name…"
                value={newPackName}
                onChange={(e) => setNewPackName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPack()}
                className={cn('flex-1 rounded-lg border px-3 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
              />
              <button
                onClick={createPack}
                disabled={creating || !newPackName.trim()}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent disabled:opacity-50 flex items-center gap-1"
                style={{ background: colors.accent }}
              >
                <Plus size={14} /> Pack
              </button>
            </div>
            {newPackName.trim() && (
              <input
                type="text"
                placeholder="Description (optional)"
                value={newPackDesc}
                onChange={(e) => setNewPackDesc(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPack()}
                className={cn('mt-2 w-full rounded-lg border px-3 py-1.5 text-xs bg-transparent', colors.panelBorder, colors.textMain)}
              />
            )}
          </div>

          {/* A warning needs something behind it. Loose coloured text over a
              wallpaper is unreadable exactly when it matters most — when a
              whole batch has failed and the message is the only thing left. */}
          {error && (
            <div
              className="mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-snug"
              style={{
                color: colors.accent,
                borderColor: colors.accent,
                background: themeMode === 'dark' ? 'rgba(12,12,14,0.88)' : 'rgba(255,255,255,0.92)',
              }}
            >
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 opacity-70">
                <X size={12} />
              </button>
            </div>
          )}

          {selectedPack || isLooseView ? (
            <div className={card}>
              <div className="flex items-center justify-between mb-2">
                <span className={cn('text-sm font-medium', colors.textMain)}>
                  {isLooseView
                    ? `Unpacked · ${looseItems.length}`
                    : `${packs.find((p) => p.id === selectedPack)?.name} · ${packItems.length}`}
                </span>
                <div className="flex items-center gap-1.5">
                  {!isLooseView && (
                    <button
                      onClick={() => fileInput.current?.click()}
                      disabled={uploading}
                      className={cn('rounded-lg border px-2 py-1 text-[11px] flex items-center gap-1 disabled:opacity-50', colors.panelBorder, colors.textMain)}
                    >
                      {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Upload
                    </button>
                  )}
                  {!isLooseView && selectedPack && (
                    <button
                      onClick={() => {
                        const pack = packs.find((p) => p.id === selectedPack);
                        if (pack) setConfirmDelete({ kind: 'pack', id: pack.id, name: pack.name });
                      }}
                      className={cn('rounded-lg p-1.5', colors.textMuted)}
                      title="Delete pack"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              {(() => {
                const description = !isLooseView ? packs.find((p) => p.id === selectedPack)?.description : '';
                return description ? (
                  <p className={cn('mb-2 text-xs leading-relaxed', colors.textMuted)}>{description}</p>
                ) : null;
              })()}
              <input
                ref={fileInput}
                type="file"
                accept={kind === 'emojis' ? ".png,.webp,.gif,image/png,image/webp,image/gif" : ".png,.webp,image/png,image/webp"}
                multiple
                hidden
                onChange={(e) => e.target.files && stageFiles(e.target.files)}
              />

              {/* Staging table — pick files, edit names, then bulk upload */}
              {staged.length > 0 && (
                <div className={cn('mb-3 rounded-xl border p-2', colors.panelBorder)}>
                  <div className="flex items-center justify-between mb-2">
                    <span className={cn('text-[11px] font-semibold uppercase tracking-wider', colors.textMuted)}>
                      Review {staged.length} file{staged.length === 1 ? '' : 's'}
                    </span>
                    <button
                      onClick={clearStaged}
                      disabled={uploading}
                      className={cn('text-[10px] underline disabled:opacity-50', colors.textMuted)}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    {staged.map((row, idx) => (
                      <div
                        key={`${row.defaultName}-${idx}`}
                        className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5', colors.panelBorder)}
                      >
                        <img
                          src={row.previewUrl}
                          alt={row.draftName || row.defaultName}
                          className="h-8 w-8 rounded object-contain flex-shrink-0"
                        />
                        <input
                          type="text"
                          value={row.draftName}
                          onChange={(e) => updateStagedName(idx, e.target.value)}
                          className={cn(
                            'flex-1 bg-transparent text-xs font-mono focus:outline-none px-1',
                            colors.textMain,
                          )}
                          style={{ caretColor: colors.accent }}
                        />
                        <button
                          onClick={() => removeStaged(idx)}
                          disabled={uploading}
                          className={cn('rounded p-1 hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-50', colors.textMuted)}
                          title="Remove from upload"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={uploadStaged}
                    disabled={uploading || staged.length === 0}
                    className="w-full mt-2 rounded-lg py-1.5 text-xs font-semibold bytelight-on-accent disabled:opacity-50 flex items-center justify-center gap-1"
                    style={{ background: colors.accent }}
                  >
                    {uploading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Upload {staged.length}
                  </button>
                </div>
              )}

              {(() => {
                const visible = isLooseView ? looseItems : packItems;
                if (visible.length === 0) {
                  return (
                    <div className={cn('text-xs py-4 text-center', colors.textMuted)}>
                      No {kind} in this pack yet.
                    </div>
                  );
                }
                return (
                  <div className="grid grid-cols-3 gap-2">
                    {visible.map((item) => (
                      <PackItemCard
                        key={item.id}
                        item={item}
                        colors={colors}
                        onDelete={() => setConfirmDelete({ kind: 'item', id: item.id, name: item.name })}
                        onRename={(value) => renameItem(item.id, value)}
                      />
                    ))}
                  </div>
                );
              })()}
              {isLooseView && (
                <p className={cn('text-[10px] mt-3 italic text-center', colors.textMuted)}>
                  These weren't assigned to a pack. Create a pack above to organize them, then re-upload.
                </p>
              )}
            </div>
          ) : (
            <div className={cn('text-xs py-6 text-center', colors.textMuted)}>
              No packs yet — create one above.
            </div>
          )}
        </>
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6" onClick={() => setConfirmDelete(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="packs-delete-title"
            className={cn('w-full max-w-xs rounded-2xl border p-5 shadow-2xl', colors.panelBg, colors.panelBorder)}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="packs-delete-title" className={cn('mb-2 break-words text-sm font-bold', colors.textMain)}>
              {confirmDelete.kind === 'pack' ? `Delete pack "${confirmDelete.name}"?` : `Delete ${kind === 'emojis' ? 'emoji' : 'sticker'} "${confirmDelete.name}"?`}
            </h4>
            <p className={cn('mb-4 text-xs leading-relaxed', colors.textMuted)}>
              {confirmDelete.kind === 'pack' ? `The pack and all its ${kind} will be deleted.` : "This can't be undone."}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-semibold', colors.panelBorder, colors.textMain)}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { kind: target, id } = confirmDelete;
                  setConfirmDelete(null);
                  void (target === 'pack' ? deletePack(id) : deleteItem(id));
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// Controlled-input card. Tracks draft locally so the user can type
// freely without state churn on every keystroke; commits on blur/Enter.
// Resets the draft when item.name changes from outside (e.g. after the
// PATCH response comes back with the sanitised server value) so the
// visible text stays in sync with what's actually saved.
function PackItemCard({
  item,
  colors,
  onDelete,
  onRename,
}: {
  item: Item;
  colors: ThemeColors;
  onDelete: () => void;
  onRename: (value: string) => void;
}) {
  const [draft, setDraft] = useState(item.name);
  useEffect(() => {
    setDraft(item.name);
  }, [item.name]);

  return (
    <div className={cn('relative rounded-xl border p-1.5 flex flex-col items-stretch gap-1', colors.panelBorder)}>
      <div className="relative aspect-square flex items-center justify-center">
        <img src={item.url} alt={item.name} className="max-h-full max-w-full object-contain" />
        <button
          onClick={onDelete}
          className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bytelight-on-accent opacity-80 hover:opacity-100 transition-opacity"
          style={{ background: colors.accent }}
          title="Delete"
        >
          <Trash2 size={10} />
        </button>
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onRename(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(item.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          'bg-transparent text-[10px] text-center font-mono w-full focus:outline-none focus:ring-1 rounded px-1',
          colors.textMain,
        )}
        style={{ caretColor: colors.accent }}
      />
    </div>
  );
}
