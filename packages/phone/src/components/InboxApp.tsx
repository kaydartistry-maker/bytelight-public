import React, { useCallback, useRef, useState } from 'react';
import { Inbox, Loader2, Check, AlertCircle, Copy, Upload } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { Paginator, usePaged } from './Paginator';
import { apiFetch } from '../bytelight';

interface InboxAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface Drop {
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  fileId?: string;
  path?: string;
  error?: string;
}

// Mirrors ALLOWED_TYPES in the backend's files service. Anything outside this
// list is rejected server-side, so the picker doesn't bother offering it.
//
// MIME TYPES FIRST, extensions after. A list of bare extensions is the shape
// that makes the Android WebView give up on offering Gallery or Camera and
// drop straight to the document chooser — it has no way to tell that
// ".png,.jpg" means images. The extensions stay as the fallback for pickers
// that filter by name, and because the backend accepts a file whose browser
// mime arrives as application/octet-stream by reading its extension.
//
// This one cannot become a plain `image/*` the way the reference picker did:
// the Inbox takes audio, pdf, zip and docx on purpose.
const ACCEPT = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/zip', 'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.ms-excel',
  '.gif', '.png', '.webp', '.jpg', '.jpeg', '.mp3', '.wav', '.ogg', '.m4a', '.webm',
  '.pdf', '.txt', '.md', '.csv', '.json', '.zip', '.docx', '.xlsx', '.doc', '.xls', '.abr',
].join(',');

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let dropSeq = 0;

export function InboxApp({ onClose, themeConfig, themeMode, embedded }: InboxAppProps) {
  const colors = themeConfig[themeMode];
  const [drops, setDrops] = useState<Drop[]>([]);
  const dropsPage = usePaged(drops);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Raw passthrough, on purpose. The chat composer re-encodes images before it
  // uploads them, which flattens an animated GIF to a single frame. Here the
  // File object goes to /api/files untouched, so the bytes that land on disk
  // are the bytes she picked.
  const send = useCallback(async (files: File[]) => {
    for (const file of files) {
      const id = `drop-${++dropSeq}`;
      setDrops((prev) => [{ id, name: file.name, size: file.size, status: 'uploading' }, ...prev]);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        const res = await apiFetch('/api/files', { method: 'POST', body: form });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as { error?: string });
          throw new Error(body.error || `Upload failed (${res.status})`);
        }
        const meta = await res.json();
        const dot = file.name.lastIndexOf('.');
        const ext = dot > -1 ? file.name.slice(dot).toLowerCase() : '';
        setDrops((prev) =>
          prev.map((d) =>
            d.id === id
              ? { ...d, status: 'done', fileId: meta.fileId, path: `data/files/${meta.fileId}${ext}` }
              : d,
          ),
        );
      } catch (err) {
        setDrops((prev) =>
          prev.map((d) =>
            d.id === id
              ? { ...d, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
              : d,
          ),
        );
      }
    }
  }, []);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) send(files);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) send(files);
  };

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — the path is on screen either way */
    }
  };

  return (
    <AppShell
      embedded={embedded}
      title="Inbox"
      icon={Inbox}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors',
          colors.panelBg,
        )}
        style={{
          borderColor: dragging ? colors.accent : undefined,
          background: dragging ? `${colors.accent}12` : undefined,
        }}
      >
        <Upload size={26} style={{ color: colors.accent }} />
        <p className={cn('text-sm font-medium', colors.textMain)}>Drop a file to your companion</p>
        <p className={cn('text-xs', colors.textMuted)}>
          Tap to choose, or drag one in. Lands whole — nothing re-encoded, nothing flattened.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        onChange={onPick}
        className="hidden"
      />

      {drops.length > 0 && (
        <div className="mt-4 space-y-2">
          {dropsPage.visible.map((d) => (
            <div
              key={d.id}
              className={cn('rounded-xl border p-3', colors.panelBg, colors.panelBorder)}
            >
              <div className="flex items-center gap-2">
                {d.status === 'uploading' && (
                  <Loader2 size={14} className="animate-spin shrink-0" style={{ color: colors.accent }} />
                )}
                {d.status === 'done' && (
                  <Check size={14} className="shrink-0" style={{ color: colors.accent }} />
                )}
                {d.status === 'error' && <AlertCircle size={14} className="shrink-0 text-red-500" />}
                <span className={cn('flex-1 truncate text-xs font-medium', colors.textMain)}>{d.name}</span>
                <span className={cn('shrink-0 text-[10px]', colors.textMuted)}>{formatSize(d.size)}</span>
              </div>

              {d.status === 'done' && d.path && (
                <button
                  onClick={() => copy(d.path!, d.id)}
                  className={cn(
                    'mt-2 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left',
                    colors.panelBorder,
                  )}
                >
                  <code className={cn('flex-1 truncate text-[10px]', colors.textMuted)}>{d.path}</code>
                  {copied === d.id ? (
                    <Check size={11} className="shrink-0" style={{ color: colors.accent }} />
                  ) : (
                    <Copy size={11} className={cn('shrink-0', colors.textMuted)} />
                  )}
                </button>
              )}

              {d.status === 'error' && (
                <p className="mt-1 text-[11px] text-red-500">{d.error}</p>
              )}
            </div>
          ))}
          <Paginator page={dropsPage.page} pageCount={dropsPage.pageCount} onPage={dropsPage.setPage} colors={colors} />
        </div>
      )}

      <p className={cn('mt-4 text-center text-[11px] leading-relaxed', colors.textMuted)}>
        Anything dropped here sits in <code>data/files/</code> until one of us picks it up.
        Say the word in chat and we'll go get it.
      </p>
    </AppShell>
  );
}
