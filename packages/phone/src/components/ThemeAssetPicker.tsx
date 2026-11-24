import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import type { ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { deleteThemeAsset, uploadThemeAsset, type ThemeAsset } from '../bytelight/theme-assets';
import { fitImageToLimits } from '../lib/image-resize';

interface Props {
  kind: 'image' | 'font';
  value?: string;
  onChange: (id: string | undefined) => void;
  assets: ThemeAsset[];
  onAssetsChange: React.Dispatch<React.SetStateAction<ThemeAsset[]>>;
  colors: ThemeColors;
  label?: string;
  protectedIds?: readonly string[];
}

/** One private asset library for overlays, border textures and uploaded fonts.
 * Selection only changes the editor draft; uploading never applies a theme. */
export function ThemeAssetPicker({ kind, value, onChange, assets, onAssetsChange, colors, label, protectedIds = [] }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choices = assets.filter((asset) => asset.kind === kind);
  const choose = async (asset: ThemeAsset) => {
    if (asset.kind === 'font') {
      if (typeof FontFace === 'undefined' || !asset.fontFamily) throw new Error('This browser cannot load the uploaded font. Your current font is unchanged.');
      try {
        const face = await new FontFace(asset.fontFamily, `url(${JSON.stringify(asset.url)})`).load();
        document.fonts.add(face);
      } catch {
        throw new Error('The font is in your library, but this browser could not load it. Try a valid WOFF2, WOFF, TTF or OTF file.');
      }
    }
    // Upload/font loading can outlive a slider edit or a target switch. Use
    // the latest callback, and never apply an old selection after unmount.
    if (mounted.current) latest.current.onChange(asset.id);
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    const file = field.files?.[0];
    field.value = '';
    if (!file || pending) return;
    setPending(true);
    setError('');
    try {
      const prepared = kind === 'image'
        ? (await fitImageToLimits(file, {
            maxBytes: Math.floor(9.5 * 1024 * 1024),
            maxPixels: 15_000_000,
            maxDimension: 3840,
            allowedMimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
            preferredMime: 'image/webp',
          })).file
        : file;
      const asset = await uploadThemeAsset(prepared, kind);
      onAssetsChange((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      await choose(asset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed. Your current selection is unchanged.');
    } finally {
      setPending(false);
    }
  };

  const remove = async (asset: ThemeAsset) => {
    if (protectedIds.includes(asset.id)) {
      setError('Clear this asset from your draft layers before deleting it.');
      return;
    }
    if (pending || !window.confirm(`Delete “${asset.name}” from your theme library? Saved themes using it are protected.`)) return;
    setPending(true);
    setError('');
    try {
      await deleteThemeAsset(asset.id);
      onAssetsChange((current) => current.filter((item) => item.id !== asset.id));
      if (mounted.current && latest.current.value === asset.id) latest.current.onChange(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This asset could not be deleted.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn('text-xs font-medium', colors.textMain)}>{label || (kind === 'font' ? 'Uploaded font' : 'Image layer')}</span>
        <div className="flex gap-2">
          <button type="button" onClick={() => onChange(undefined)} disabled={!value || pending}
            className={cn('rounded-lg border px-2 py-1 text-[11px] disabled:opacity-40', colors.panelBorder, colors.textMuted)}>
            Clear
          </button>
          <button type="button" onClick={() => input.current?.click()} disabled={pending}
            className={cn('flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] disabled:opacity-50', colors.panelBorder, colors.textMain)}>
            {pending ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            Upload {kind === 'font' ? 'font' : 'image'}
          </button>
        </div>
      </div>
      <input ref={input} type="file" className="hidden" aria-label={`Upload theme ${kind}`}
        accept={kind === 'font' ? '.woff2,.woff,.ttf,.otf' : 'image/*'}
        onChange={upload} />
      {choices.length > 0 ? (
        <div className="grid max-h-52 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {choices.map((asset) => (
            <div key={asset.id} className={cn('relative min-w-0 rounded-xl border p-1', colors.panelBorder)}
              style={value === asset.id ? { outline: '2px solid var(--bytelight-accent)', outlineOffset: '-1px' } : undefined}>
              <button type="button" onClick={async () => {
                setPending(true); setError('');
                try { await choose(asset); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not select this asset.'); }
                finally { setPending(false); }
              }} disabled={pending}
                aria-label={`Use ${asset.name}`} aria-pressed={value === asset.id}
                className="block w-full overflow-hidden rounded-lg text-left disabled:opacity-50">
                {kind === 'image' ? (
                  <div className="flex h-16 items-center justify-center overflow-hidden"
                    style={{ backgroundImage: 'conic-gradient(#8883 25%,transparent 0 50%,#8883 0 75%,transparent 0)', backgroundSize: '12px 12px' }}>
                    <img src={asset.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                  </div>
                ) : <div className={cn('flex h-16 items-center justify-center text-2xl', colors.textMain)} style={{ fontFamily: asset.fontFamily || 'inherit' }}>Aa</div>}
                <span className={cn('block truncate px-1 py-1 text-[10px]', colors.textMain)} title={asset.name}>{asset.name}</span>
              </button>
              <button type="button" onClick={() => remove(asset)} disabled={pending || protectedIds.includes(asset.id)}
                aria-label={`Delete ${asset.name}`} title={protectedIds.includes(asset.id) ? 'Used by your draft — clear its references first' : 'Delete unused asset'}
                className={cn('absolute right-1 top-1 rounded-md border bg-black/70 p-1 text-white disabled:opacity-40', colors.panelBorder)}>
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className={cn('text-[11px]', colors.textMuted)}>No {kind === 'font' ? 'fonts' : 'images'} uploaded yet. Assets stay in your private library for reuse.</p>}
      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}
