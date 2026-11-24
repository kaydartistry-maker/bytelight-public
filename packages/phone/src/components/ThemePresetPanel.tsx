import React, { useRef, useState } from 'react';
import { Download, Upload, Copy, Trash2, Pencil, Loader2 } from 'lucide-react';
import type { AppTheme, AppThemePreset } from '../types';
import type { ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight/api';
import { uploadThemeAsset, type ThemeAsset } from '../bytelight/theme-assets';
import { buildThemeBundle, createThemePreset, decodeThemeAsset, MAX_THEME_BUNDLE_BYTES, MAX_THEME_PRESETS, parseThemeBundle, persistThemePresetList, preflightThemeAssetImport, presetName, remapThemeAssetReferences, sanitizePresetTheme, validateThemePresetList } from '../lib/theme-presets';

interface Props {
  theme: AppTheme;
  presets: AppThemePreset[];
  onPresetsChange: (list: AppThemePreset[]) => Promise<void>;
  validatePresets?: (list: AppThemePreset[]) => void;
  onLoad: (theme: AppTheme) => void;
  colors: ThemeColors;
  assets: ThemeAsset[];
  onAssetsChange: React.Dispatch<React.SetStateAction<ThemeAsset[]>>;
}
/** Presets contain appearance only. Load/import changes the editor draft;
 * applying that draft is intentionally the enclosing editor's responsibility. */
export function ThemePresetPanel({ theme, presets, onPresetsChange, validatePresets, onLoad, colors, assets, onAssetsChange }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const inAction = useRef(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const button = cn('inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] disabled:opacity-40', colors.panelBorder, colors.textMain);
  const clear = () => { setError(''); setMessage(''); };
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'Preset operation failed. Your live theme is unchanged.');
  const act = async (operation: () => Promise<void>) => {
    if (inAction.current) return;
    inAction.current = true; clear(); setPending(true);
    try { await operation(); }
    catch (cause) { report(cause); }
    finally { inAction.current = false; setPending(false); }
  };
  const persist = (next: AppThemePreset[]) => persistThemePresetList(next, onPresetsChange, validatePresets);
  const save = () => act(async () => {
    const preset = createThemePreset(theme, name);
    await persist([...presets, preset]);
    setName(''); setMessage(`Saved “${preset.name}” from the editor draft.`);
  });
  const rename = (preset: AppThemePreset) => act(async () => {
    const next = window.prompt('Preset name', preset.name); if (next === null) return;
    const label = presetName(next);
    await persist(presets.map(item => item.id === preset.id ? { ...item, name: label, updatedAt: new Date().toISOString() } : item));
    setMessage(`Renamed preset to “${label}”.`);
  });
  const duplicate = (preset: AppThemePreset) => act(async () => {
    await persist([...presets, createThemePreset(preset.theme, `${preset.name.slice(0, 73)} (copy)`)]);
    setMessage('Duplicated preset.');
  });
  const remove = (preset: AppThemePreset) => act(async () => {
    if (!window.confirm(`Delete the named preset “${preset.name}”? This will not change your current theme or delete uploaded assets.`)) return;
    await persist(presets.filter(item => item.id !== preset.id));
    setMessage('Preset removed; uploaded assets were kept.');
  });
  const load = (preset: AppThemePreset) => {
    if (inAction.current) return;
    clear(); try { onLoad(sanitizePresetTheme(preset.theme)); setMessage(`Loaded “${preset.name}” into the editor. Apply when ready.`); } catch (cause) { report(cause); }
  };
  const download = (preset: AppThemePreset) => act(async () => {
    const bundle = await buildThemeBundle(preset.name, preset.theme, assets, async asset => {
      const response = await apiFetch(asset.url);
      if (!response.ok) throw new Error('A referenced private asset could not be read.');
      return new Uint8Array(await response.arrayBuffer());
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `virelle-theme-${preset.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 70) || 'preset'}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setMessage('Theme-only file prepared. It contains appearance and its referenced assets, never contacts, credentials or models.');
  });
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const field = event.currentTarget, file = field.files?.[0]; field.value = '';
    if (!file || inAction.current) return;
    await act(async () => {
      const uploaded: ThemeAsset[] = []; let persisted = false;
      try {
        if (file.size > MAX_THEME_BUNDLE_BYTES) throw new Error('Theme file exceeds 20 MB.');
        if (presets.length >= MAX_THEME_PRESETS) throw new Error('Remove an unused preset before importing another.');
        const bundle = parseThemeBundle(await file.text()); // Validate every entry before the first upload.
        const projected = [...presets, createThemePreset(bundle.theme, bundle.name)];
        validateThemePresetList(projected);
        validatePresets?.(projected); // Complete actual settings snapshot BEFORE uploading.
        preflightThemeAssetImport(bundle, assets);
        const mapping: Record<string, string> = {};
        for (const asset of bundle.assets) {
          const bytes = decodeThemeAsset(asset.data);
          const imported = await uploadThemeAsset(new File([bytes as BlobPart], asset.name, { type: asset.mime }), asset.kind);
          mapping[asset.id] = imported.id; uploaded.push(imported);
        }
        const importedTheme = remapThemeAssetReferences(bundle.theme, mapping);
        const preset = createThemePreset(importedTheme, bundle.name);
        await persist([...presets, preset]); persisted = true;
        onLoad(importedTheme);
        setMessage(`Imported “${preset.name}” into the editor. Your live theme is unchanged until Apply.`);
      } catch (cause) {
        const suffix = uploaded.length ? ' Uploaded files were kept in your library for reuse; no existing assets were removed.' : '';
        throw new Error((persisted ? 'Preset was saved, but the editor could not load it. ' : '') + (cause instanceof Error ? cause.message : 'Import failed; your theme is unchanged.') + suffix);
      } finally {
        if (uploaded.length) onAssetsChange(current => [...current, ...uploaded.filter(a => !current.some(existing => existing.id === a.id))]);
      }
    });
  };
  return (
    <section className={cn('space-y-3 rounded-2xl border p-4', colors.panelBg, colors.panelBorder)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={cn('micro-label', colors.accentText)}>Named theme presets</h3>
        <button type="button" className={button} disabled={pending} onClick={() => input.current?.click()}>
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import theme
        </button>
      </div>
      <p className={cn('text-[11px]', colors.textMuted)}>Save your editor draft, then load a look without replacing contacts or models. Imported themes stay in the editor until Apply.</p>
      <div className="flex gap-2">
        <input value={name} disabled={pending} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Name this look" aria-label="New theme preset name"
          onKeyDown={event => { if (event.key === 'Enter' && !pending) { event.preventDefault(); save(); } }}
          className={cn('min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-xs', colors.panelBorder, colors.textMain)} />
        <button type="button" className={button} onClick={save} disabled={pending || !name.trim()}>Save draft</button>
      </div>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={importFile} aria-label="Import a theme bundle" />
      {presets.length === 0 && <p className={cn('text-xs', colors.textMuted)}>No saved looks yet.</p>}
      <div className="space-y-2">
        {presets.map(preset => <div key={preset.id} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3', colors.panelBorder)}>
          <span className={cn('min-w-0 break-words text-xs font-semibold', colors.textMain)}>{preset.name}</span>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={button} disabled={pending} onClick={() => load(preset)}>Load into editor</button>
            <button type="button" className={button} disabled={pending} onClick={() => download(preset)} aria-label={`Export ${preset.name}`}><Download size={12} />Export</button>
            <button type="button" className={button} disabled={pending} onClick={() => rename(preset)} aria-label={`Rename ${preset.name}`}><Pencil size={12} /></button>
            <button type="button" className={button} disabled={pending} onClick={() => duplicate(preset)} aria-label={`Duplicate ${preset.name}`}><Copy size={12} /></button>
            <button type="button" className={button} disabled={pending} onClick={() => remove(preset)} aria-label={`Delete ${preset.name}`}><Trash2 size={12} /></button>
          </div>
        </div>)}
      </div>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {message && <p aria-live="polite" className={cn('text-xs', colors.textMuted)}>{message}</p>}
    </section>
  );
}
export default ThemePresetPanel;
