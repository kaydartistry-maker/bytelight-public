import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Redo2, Undo2 } from 'lucide-react';
import { collectThemeAssetIds, normalizeThemeAppearance, type AppearanceSurface, type ThemeAppearance, type AppearanceControlState } from '@bytelight/shared';
import type { AppSettings, AppTheme, AppThemePreset, AppearanceSaveResult } from '../types';
import type { ThemeColors } from '../lib/theme';
import type { VoiceCompanion } from '../lib/voices';
import { APPEARANCE_SECTIONS } from '../lib/apps';
import { cn } from '../lib/utils';
import { listThemeAssets, type ThemeAsset } from '../bytelight/theme-assets';
import { AppearanceFields, SurfaceAppearanceEditor, TextAppearanceEditor, appearanceBoolean as bool, appearanceChoice as choice, appearanceColor as color, appearanceNumber as num } from './AppearanceFields';
import { ThemeAssetPicker } from './ThemeAssetPicker';
import { ThemePresetPanel } from './ThemePresetPanel';

interface Props {
  theme: AppTheme;
  appSettings: Omit<AppSettings, 'theme' | 'contacts'>;
  companions: VoiceCompanion[];
  colors: ThemeColors;
  onApplyTheme: (theme: AppTheme) => Promise<AppearanceSaveResult>;
  onPresetsSave: (presets: AppThemePreset[]) => Promise<void>;
  validatePresets: (presets: AppThemePreset[]) => void;
  syncError?: string;
  settingsSaving: boolean;
  onRetrySync: () => Promise<void>;
  onPreviewChange: (theme: AppTheme | undefined) => void;
  onPreviewSectionChange: (section: string) => void;
}
type History = { past: AppTheme[]; present: AppTheme; future: AppTheme[] };

function targetSurface(appearance: ThemeAppearance, target: string): AppearanceSurface {
  if (target === 'cards') return appearance.cards || {};
  if (target === 'buttons' || target === 'tabs') return appearance.controls?.[target] || {};
  const state = /^(buttonState|tabState):(hover|pressed|selected|disabled)$/.exec(target);
  if (state) return appearance.controls?.[state[1] === 'buttonState' ? 'buttonStates' : 'tabStates']?.[state[2] as AppearanceControlState] || {};
  if (target.startsWith('section:')) return appearance.sectionOverrides?.[target.slice(8)] || {};
  if (target === 'chat:defaults' || target === 'chat:user') return appearance.chat?.[target.slice(5) as 'defaults' | 'user'] || {};
  if (target.startsWith('companion:')) return appearance.chat?.companions?.[target.slice(10)] || {};
  return {};
}
function replaceSurface(appearance: ThemeAppearance, target: string, value: AppearanceSurface | undefined): ThemeAppearance {
  if (target === 'cards') return { ...appearance, cards: value };
  if (target === 'buttons' || target === 'tabs') return { ...appearance, controls: { ...appearance.controls, [target]: value } };
  const state = /^(buttonState|tabState):(hover|pressed|selected|disabled)$/.exec(target);
  if (state) {
    const key = state[1] === 'buttonState' ? 'buttonStates' : 'tabStates';
    return { ...appearance, controls: { ...appearance.controls, [key]: { ...appearance.controls?.[key], [state[2]]: value } } };
  }
  if (target.startsWith('section:')) return { ...appearance, sectionOverrides: { ...appearance.sectionOverrides, [target.slice(8)]: value } };
  if (target === 'chat:defaults' || target === 'chat:user') return { ...appearance, chat: { ...appearance.chat, [target.slice(5)]: value } };
  if (target.startsWith('companion:')) return { ...appearance, chat: { ...appearance.chat, companions: { ...appearance.chat?.companions, [target.slice(10)]: value } } };
  return appearance;
}

/** Edits are reversible render-only drafts. Only Apply writes the real theme. */
export function AppearanceStudio({ theme, appSettings, companions, colors, onApplyTheme, onPresetsSave, validatePresets, syncError, settingsSaving, onRetrySync, onPreviewChange, onPreviewSectionChange }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(true);
  const [target, setTarget] = useState('cards');
  const [history, setHistory] = useState<History>({ past: [], present: theme, future: [] });
  const baseline = useRef(theme);
  const [stale, setStale] = useState(false);
  const [assets, setAssets] = useState<ThemeAsset[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const applying = useRef(false);
  const draft = history.present;
  const dirty = draft !== baseline.current;
  const appearance = useMemo(() => normalizeThemeAppearance(draft.appearance), [draft.appearance]);
  const protectedIds = useMemo(() => collectThemeAssetIds(appearance), [appearance]);
  const library = { colors, assets, onAssetsChange: setAssets, protectedIds };
  const button = cn('rounded-xl border px-3 py-2 text-xs font-medium disabled:opacity-35', colors.panelBorder, colors.textMain);
  const sections = APPEARANCE_SECTIONS;

  useEffect(() => {
    if (applying.current) return;
    if (theme === baseline.current) return;
    if (history.present === baseline.current) {
      baseline.current = theme;
      setHistory({ past: [], present: theme, future: [] });
      setStale(false);
    } else setStale(true);
  }, [theme]);
  useEffect(() => { onPreviewChange(open && preview && dirty ? draft : undefined); }, [open, preview, draft, dirty, onPreviewChange]);
  useEffect(() => () => onPreviewChange(undefined), [onPreviewChange]);
  useEffect(() => { onPreviewSectionChange(target.startsWith('section:') ? target.slice(8) : 'settings'); }, [target, onPreviewSectionChange]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listThemeAssets().then((items) => { if (!cancelled) { setAssets(items); setError(''); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load your asset library.'); });
    return () => { cancelled = true; };
  }, [open]);

  const edit = (change: (current: AppTheme) => AppTheme) => setHistory((current) => ({
    past: [...current.past, current.present].slice(-40), present: change(current.present), future: [],
  }));
  const editAppearance = (change: (current: ThemeAppearance) => ThemeAppearance) => edit((current) => ({
    ...current, appearance: normalizeThemeAppearance(change(normalizeThemeAppearance(current.appearance))),
  }));
  const discard = () => {
    baseline.current = theme;
    setHistory({ past: [], present: theme, future: [] });
    setStale(false);
    onPreviewChange(undefined);
  };
  const apply = async () => {
    if (applying.current) return;
    if (stale && !window.confirm('Your saved look changed while this draft was open. Apply this draft instead?')) return;
    applying.current = true;
    setIsApplying(true);
    setError(''); setNotice('');
    try {
      const result = await onApplyTheme(draft);
      baseline.current = draft;
      setHistory({ past: [], present: draft, future: [] });
      setStale(false);
      setNotice(result.synced ? 'Applied and synced.' : 'Applied on this device.');
      onPreviewChange(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this look. Your draft is preserved.');
    } finally { applying.current = false; setIsApplying(false); }
  };
  const undo = () => setHistory((current) => current.past.length ? {
    past: current.past.slice(0, -1), present: current.past[current.past.length - 1], future: [current.present, ...current.future],
  } : current);
  const redo = () => setHistory((current) => current.future.length ? {
    past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1),
  } : current);
  const bubble = target.startsWith('chat:') || target.startsWith('companion:');
  const surface = ['cards', 'buttons', 'tabs'].includes(target) || target.startsWith('section:') || bubble || /^(buttonState|tabState):/.test(target);

  return <section data-theme-editor="" className={cn('space-y-4 rounded-2xl border p-4', colors.panelBg, colors.panelBorder)} style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: 14, lineHeight: 1.5, letterSpacing: 0 }}>
    <button type="button" onClick={() => {
      if (open && dirty && !window.confirm('Discard this unapplied appearance draft?')) return;
      if (open) discard();
      setOpen(!open);
    }} disabled={isApplying} className={cn('flex w-full items-center justify-between gap-3 text-left', colors.textMain)} aria-expanded={open}>
      <span><span className="block text-sm font-semibold">Advanced appearance</span><span className={cn('text-[11px]', colors.textMuted)}>Layers, independent bubbles, typography, details & saved looks</span></span>
      <ChevronDown size={18} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
    </button>
    {open && <fieldset disabled={isApplying} className="min-w-0 space-y-4">
      <div className={cn('sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-xl border p-2 shadow-lg', colors.panelBorder)} style={{ background: 'var(--bytelight-panel-base, #18181b)' }}>
        <button type="button" onClick={undo} disabled={!history.past.length} className={button} aria-label="Undo draft"><Undo2 size={14} /></button>
        <button type="button" onClick={redo} disabled={!history.future.length} className={button} aria-label="Redo draft"><Redo2 size={14} /></button>
        <label className={cn('flex items-center gap-2 text-xs', colors.textMain)}><input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} />Live preview</label>
        <button type="button" className={button} onClick={() => document.querySelector('[data-appearance-preview]')?.scrollIntoView({ block: 'start' })}>View preview ↑</button>
        <button type="button" onClick={discard} disabled={!dirty && !stale} className={button}>Discard draft</button>
        <button type="button" onClick={apply} disabled={!dirty || settingsSaving} className={cn(button, 'font-bold')} style={{ background: 'var(--bytelight-accent)', color: 'var(--bytelight-on-accent)' }}>{isApplying ? 'Saving…' : 'Apply look'}</button>
        {(syncError || notice || error) && <div className="w-full space-y-1">
          {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
          {syncError ? <div className="flex flex-wrap items-center gap-2"><p role="alert" className="min-w-0 flex-1 text-xs text-amber-400">{syncError}</p><button type="button" onClick={() => void onRetrySync()} disabled={settingsSaving} className={button}>Retry sync</button></div>
            : notice && <p role="status" className={cn('text-xs', colors.textMuted)}>{notice}</p>}
        </div>}
      </div>
      <p className={cn('text-[11px]', colors.textMuted)}>{dirty ? 'Unsaved draft. Preview changes are temporary until you apply.' : 'Following your saved look. Inherited fields keep existing settings.'}</p>
      {stale && <p role="status" className="text-xs text-amber-400">The saved look changed elsewhere. Your draft is preserved; discard to reload it.</p>}
      <div className="space-y-1"><span className={cn('text-[11px]', colors.textMuted)}>Density shortcuts — still fully adjustable below</span><div className="flex flex-wrap gap-2">
        {([{ name: 'Compact', card: 8, bubble: 7, gap: 4, control: 6 }, { name: 'Balanced', card: 16, bubble: 10, gap: 8, control: 10 }, { name: 'Roomy', card: 24, bubble: 16, gap: 16, control: 14 }]).map((density) => <button key={density.name} type="button" className={button} onClick={() => editAppearance((current) => ({
          ...current, cards: { ...current.cards, layout: { ...current.cards?.layout, padding: density.card, gap: density.gap } },
          chat: { ...current.chat, defaults: { ...current.chat?.defaults, layout: { ...current.chat?.defaults?.layout, padding: density.bubble, gap: density.gap } } },
          controls: { ...current.controls, buttons: { ...current.controls?.buttons, layout: { ...current.controls?.buttons?.layout, padding: density.control } } },
        }))}>{density.name}</button>)}
      </div></div>
      <label className={cn('block space-y-1 text-xs', colors.textMain)}><span>Customize</span>
        <select value={target} onChange={(event) => setTarget(event.target.value)} className={cn('w-full rounded-xl border bg-transparent p-2 text-sm', colors.panelBorder)}>
          <optgroup label="Surfaces"><option value="cards">Cards — global defaults</option>{sections.map((section) => <option key={section.id} value={`section:${section.id}`}>Cards — {section.name}</option>)}</optgroup>
          <optgroup label="Chat bubbles — independent of cards"><option value="chat:defaults">All bubbles — shared defaults</option><option value="chat:user">Your bubbles</option>{companions.map((companion) => <option key={companion.slug} value={`companion:${companion.slug}`}>{companion.emoji || ''} {companion.display_name} bubbles</option>)}</optgroup>
          <optgroup label="Type & controls"><option value="type:heading">Heading typography</option><option value="type:body">Body typography</option><option value="type:mono">Code typography</option><option value="buttons">Buttons</option><option value="tabs">Tabs & selected controls</option><option value="icons">Icons</option></optgroup>
          <optgroup label="Button states">{['hover', 'pressed', 'selected', 'disabled'].map((state) => <option key={state} value={`buttonState:${state}`}>Buttons — {state}</option>)}</optgroup>
          <optgroup label="Tab states">{['hover', 'pressed', 'selected', 'disabled'].map((state) => <option key={state} value={`tabState:${state}`}>Tabs — {state}</option>)}</optgroup>
          <optgroup label="Atmosphere"><option value="wallpaper">Wallpaper adjustments</option><option value="motion">Motion & accessibility</option><option value="details">Dividers, focus & small details</option></optgroup>
        </select>
      </label>
      {surface && <>
        <button type="button" className={button} onClick={() => editAppearance((current) => replaceSurface(current, target, undefined))}>Use inherited settings for this target</button>
        {bubble && <p className={cn('text-[11px]', colors.textMuted)}>Bubble layers never inherit card styling. Glass is painted without live backdrop blur to preserve long-message rendering on iPhone.</p>}
        <SurfaceAppearanceEditor key={target} {...library} value={targetSurface(appearance, target)} bubble={bubble}
          onChange={(next) => editAppearance((current) => replaceSurface(current, target, next))} />
      </>}
      {target.startsWith('type:') && <TextAppearanceEditor key={target} {...library} value={appearance.typography?.[target.slice(5) as 'heading' | 'body' | 'mono'] || {}}
        onChange={(next) => editAppearance((current) => ({ ...current, typography: { ...current.typography, [target.slice(5)]: next } }))} />}
      {target === 'wallpaper' && <div className="space-y-4">
        <ThemeAssetPicker {...library} kind="image" label="Wallpaper from library" value={appearance.wallpaper?.assetId}
          onChange={(assetId) => editAppearance((current) => ({ ...current, wallpaper: { ...current.wallpaper, assetId } }))} />
        <AppearanceFields colors={colors} value={appearance.wallpaper || {}} onChange={(next) => editAppearance((current) => ({ ...current, wallpaper: next }))} fields={[
          num('opacity', 'Opacity', 0, 100, 80, 1, '%'), num('blur', 'Blur', 0, 40, 0, 1, 'px'), num('dim', 'Dim', 0, 100, 0, 1, '%'), num('zoom', 'Zoom', 50, 300, 100, 5, '%'), num('positionX', 'Horizontal position', 0, 100, 50, 1, '%'), num('positionY', 'Vertical position', 0, 100, 50, 1, '%'), choice('fit', 'Image fit', ['cover', 'contain', 'stretch']), choice('repeat', 'Repeat', ['none', 'repeat', 'repeat-x', 'repeat-y']), choice('blend', 'Blend', ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light']), color('colorWash.color', 'Color wash'), num('colorWash.opacity', 'Wash opacity', 0, 100, 0, 1, '%'), num('slideshowInterval', 'Slideshow interval', 2, 120, 10, 1, 'sec'), num('transitionDuration', 'Crossfade duration', 0, 5, 0.5, 0.1, 'sec'),
        ]} />
      </div>}
      {target === 'motion' && <AppearanceFields colors={colors} value={appearance.motion || {}} onChange={(next) => editAppearance((current) => ({ ...current, motion: next }))} fields={[
        bool('enabled', 'Animations enabled'), num('scale', 'Motion scale', 0, 200, 100, 5, '%'), num('duration', 'Transition duration', 0, 2000, 200, 25, 'ms'), bool('reduceMotion', 'Reduce motion'), bool('hover', 'Hover movement'), bool('press', 'Press movement'), bool('entrance', 'Message entrance'), bool('wallpaper', 'Wallpaper animation'),
      ]} />}
      {target === 'icons' && <AppearanceFields colors={colors} value={appearance.controls?.icons || {}} onChange={(next) => editAppearance((current) => ({ ...current, controls: { ...current.controls, icons: next } }))} fields={[
        num('size', 'Icon size', 12, 48, 20, 1, 'px'), color('color', 'Icon color'), num('opacity', 'Icon opacity', 0, 100, 100, 1, '%'), num('strokeWidth', 'Icon stroke width', 0.5, 4, 2, 0.25),
      ]} />}
      {target === 'details' && <AppearanceFields colors={colors} value={appearance.details || {}} onChange={(next) => editAppearance((current) => ({ ...current, details: next }))} fields={[
        color('dividerColor', 'Divider color'), num('dividerWidth', 'Divider width', 0, 8, 1, 1, 'px'), color('scrollbarColor', 'Scrollbar color'), num('scrollbarWidth', 'Scrollbar width', 0, 24, 6, 1, 'px'), color('focusColor', 'Focus ring'), num('focusWidth', 'Focus width', 0, 8, 2, 1, 'px'), color('unreadColor', 'Unread indicators'), color('loadingColor', 'Loading indicators'), color('selectionColor', 'Selected text'),
      ]} />}
      <details className={cn('rounded-xl border p-3', colors.panelBorder)}><summary className={cn('cursor-pointer text-xs font-semibold', colors.textMain)}>Saved looks & theme files</summary>
        <div className="mt-3"><ThemePresetPanel theme={draft} presets={appSettings.themePresets || []} onPresetsChange={onPresetsSave} validatePresets={validatePresets}
          onLoad={(next) => edit(() => next)} colors={colors} assets={assets} onAssetsChange={setAssets} /></div>
      </details>
      <button type="button" className={button} onClick={() => {
        if (window.confirm('Reset all advanced overrides in this draft? Your base palette and saved presets stay intact.')) editAppearance(() => ({ version: 1 }));
      }}>Reset advanced layers</button>
    </fieldset>}
  </section>;
}
