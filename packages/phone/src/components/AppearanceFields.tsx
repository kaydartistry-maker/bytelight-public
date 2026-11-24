import React from 'react';
import type { AppearanceSurface, AppearanceText } from '@bytelight/shared';
import type { ThemeColors } from '../lib/theme';
import { cn } from '../lib/utils';
import { appearanceField, editAppearanceField } from '../lib/appearance-edit';
import { ThemeAssetPicker } from './ThemeAssetPicker';
import type { ThemeAsset } from '../bytelight/theme-assets';

export type AppearanceFieldSpec = {
  path: string; label: string; type: 'number' | 'color' | 'choice' | 'boolean';
  min?: number; max?: number; step?: number; fallback?: number; unit?: string; choices?: string[];
};
const number = (path: string, label: string, min: number, max: number, fallback = min, step = 1, unit = ''): AppearanceFieldSpec => ({ path, label, type: 'number', min, max, fallback, step, unit });
const color = (path: string, label: string): AppearanceFieldSpec => ({ path, label, type: 'color' });
const choice = (path: string, label: string, choices: string[]): AppearanceFieldSpec => ({ path, label, type: 'choice', choices });
const boolean = (path: string, label: string): AppearanceFieldSpec => ({ path, label, type: 'boolean' });
export { number as appearanceNumber, color as appearanceColor, choice as appearanceChoice, boolean as appearanceBoolean };

function pickerColor(value: unknown): string {
  if (typeof value !== 'string') return '#a78bfa';
  if (/^#[\da-f]{3,4}$/i.test(value)) return '#' + value.slice(1, 4).split('').map((character) => character + character).join('');
  return /^#[\da-f]{6,8}$/i.test(value) ? value.slice(0, 7) : '#a78bfa';
}

export function AppearanceFields<T extends object>({ value, onChange, fields, colors }: {
  value: T; onChange: (next: T) => void; fields: AppearanceFieldSpec[]; colors: ThemeColors;
}) {
  const inputClass = cn('min-w-0 rounded-lg border bg-transparent px-2 py-1.5 text-xs', colors.panelBorder, colors.textMain);
  return <div className="space-y-3">{fields.map((field) => {
    const current = appearanceField(value, field.path);
    const set = (next: unknown) => onChange(editAppearanceField(value, field.path, next));
    return <div key={field.path} className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className={cn('text-xs', colors.textMain)}>{field.label}</span>
        <button type="button" disabled={current === undefined} onClick={() => set(undefined)}
          className={cn('text-[10px] underline underline-offset-2 disabled:opacity-40', colors.textMuted)}>
          {current === undefined ? 'Inherited' : 'Inherit'}
        </button>
      </div>
      {field.type === 'number' ? <div className="flex items-center gap-2">
        <input type="range" aria-label={field.label} min={field.min} max={field.max} step={field.step}
          value={typeof current === 'number' ? current : field.fallback} onChange={(event) => set(Number(event.target.value))}
          className="min-w-0 flex-1" style={{ accentColor: 'var(--bytelight-accent)' }} />
        <input type="number" aria-label={`${field.label} value`} min={field.min} max={field.max} step={field.step}
          value={typeof current === 'number' ? current : ''} placeholder="Auto" className={cn(inputClass, 'w-20')}
          onChange={(event) => set(event.target.value === '' ? undefined : Number(event.target.value))} />
        {field.unit && <span className={cn('text-[10px]', colors.textMuted)}>{field.unit}</span>}
      </div> : field.type === 'color' ? <div className="flex items-center gap-2">
        <input type="color" aria-label={field.label} value={pickerColor(current)} onChange={(event) => set(event.target.value)} className="h-8 w-10 shrink-0 cursor-pointer rounded bg-transparent" />
        <input key={String(current)} type="text" aria-label={`${field.label} hex`} defaultValue={typeof current === 'string' ? current : ''}
          placeholder="Inherit / #RRGGBBAA" className={cn(inputClass, 'w-full')} onInput={(event) => event.currentTarget.setCustomValidity('')}
          onBlur={(event) => {
            const text = event.target.value.trim();
            if (!text || /^(#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|transparent|currentColor)$/i.test(text)) set(text.toLowerCase() === 'currentcolor' ? 'currentColor' : text.toLowerCase() === 'transparent' ? 'transparent' : text || undefined);
            else { event.target.setCustomValidity('Use a hex color, transparent or currentColor.'); event.target.reportValidity(); }
          }} />
      </div> : <select aria-label={field.label} className={cn(inputClass, 'w-full')}
        value={current === undefined ? '' : String(current)} onChange={(event) => set(event.target.value === '' ? undefined : field.type === 'boolean' ? event.target.value === 'true' : event.target.value)}>
        <option value="">Inherit</option>
        {(field.type === 'boolean' ? ['true', 'false'] : field.choices || []).map((item) => <option key={item} value={item}>{item === 'true' ? 'On' : item === 'false' ? 'Off' : item}</option>)}
      </select>}
    </div>;
  })}</div>;
}

interface LibraryProps {
  colors: ThemeColors; assets: ThemeAsset[]; onAssetsChange: React.Dispatch<React.SetStateAction<ThemeAsset[]>>; protectedIds: string[];
}
const textFields: AppearanceFieldSpec[] = [
  choice('font', 'Font family', ['Inter', 'Fraunces', 'Space Grotesk', 'JetBrains Mono', 'system-ui', 'Arial', 'Georgia', 'Verdana', 'Times New Roman', 'Courier New']),
  number('size', 'Text size', 8, 96, 14, 1, 'px'), number('weight', 'Weight', 100, 900, 400, 100),
  number('lineHeight', 'Line spacing', 0.8, 3, 1.5, 0.05), number('tracking', 'Letter spacing', -0.1, 0.5, 0, 0.005, 'em'),
  color('color', 'Text color'), number('opacity', 'Text opacity', 0, 100, 100, 1, '%'),
];

export function TextAppearanceEditor({ value, onChange, ...library }: LibraryProps & { value: AppearanceText; onChange: (next: AppearanceText) => void }) {
  return <div className="space-y-4">
    <AppearanceFields value={value} onChange={onChange} fields={textFields} colors={library.colors} />
    <ThemeAssetPicker {...library} kind="font" label="Custom font" value={value.assetId} onChange={(assetId) => onChange({ ...value, assetId })} />
  </div>;
}

const overlayFields: AppearanceFieldSpec[] = [
  number('opacity', 'Image opacity', 0, 100, 100, 1, '%'), number('scale', 'Image scale', 10, 400, 100, 5, '%'),
  choice('repeat', 'Image repeat', ['none', 'repeat', 'repeat-x', 'repeat-y']),
  choice('blend', 'Blend mode', ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light']),
];

export function SurfaceAppearanceEditor({ value, onChange, bubble = false, ...library }: LibraryProps & {
  value: AppearanceSurface; onChange: (next: AppearanceSurface) => void; bubble?: boolean;
}) {
  const changeGroup = (key: string, next: unknown) => onChange(editAppearanceField(value, key, next));
  const section = (title: string, children: React.ReactNode) => <details key={title} className={cn('rounded-xl border p-3', library.colors.panelBorder)}>
    <summary className={cn('cursor-pointer text-xs font-semibold', library.colors.textMain)}>{title}</summary><div className="mt-3 space-y-4">{children}</div>
  </details>;
  const fields = (specs: AppearanceFieldSpec[]) => <AppearanceFields value={value} onChange={onChange} fields={specs} colors={library.colors} />;
  return <div className="space-y-2">
    {section('Fill & glass', fields([color('fill.color', 'Fill color'), number('fill.opacity', 'Fill opacity', 0, 100, 100, 1, '%'), ...(!bubble ? [number('blur', 'Backdrop blur', 0, 40, 12, 1, 'px')] : [])]))}
    {section('Image overlay', <>
      <ThemeAssetPicker {...library} kind="image" value={value.overlay?.assetId} onChange={(id) => changeGroup('overlay', id
        ? { assetId: id, opacity: 100, scale: 100, repeat: 'none', blend: 'normal' }
        : { ...value.overlay, assetId: undefined })} />
      <AppearanceFields value={value.overlay || {}} onChange={(next) => changeGroup('overlay', next)} fields={overlayFields} colors={library.colors} />
    </>)}
    {section('Border & border image', <>
      {fields([color('border.color', 'Border color'), number('border.width', 'Border width', 0, 16, 1, 1, 'px'), choice('border.style', 'Border style', ['solid', 'dashed', 'dotted', 'double', 'none']), number('border.opacity', 'Border opacity', 0, 100, 100, 1, '%'), number('border.radius', 'Corner radius', 0, 80, 16, 1, 'px')])}
      <ThemeAssetPicker {...library} kind="image" label="Border texture" value={value.border?.overlay?.assetId} onChange={(id) => changeGroup('border', { ...value.border, overlay: { ...value.border?.overlay, assetId: id } })} />
      <AppearanceFields value={value.border?.overlay || {}} onChange={(next) => changeGroup('border', { ...value.border, overlay: next })} fields={overlayFields} colors={library.colors} />
    </>)}
    {section('Shadow & glow', fields([color('shadow.color', 'Shadow color'), number('shadow.opacity', 'Shadow opacity', 0, 100, 30, 1, '%'), number('shadow.blur', 'Shadow softness', 0, 100, 12, 1, 'px'), number('shadow.x', 'Shadow horizontal', -100, 100, 0, 1, 'px'), number('shadow.y', 'Shadow vertical', -100, 100, 4, 1, 'px'), boolean('shadow.inset', 'Inner shadow / highlight')]))}
    {section('Gradient', fields([color('gradient.from', 'Gradient start'), color('gradient.to', 'Gradient end'), number('gradient.angle', 'Gradient angle', 0, 360, 135, 1, '°'), number('gradient.opacity', 'Gradient opacity', 0, 100, 100, 1, '%')]))}
    {section('Typography', <TextAppearanceEditor {...library} value={value.text || {}} onChange={(next) => changeGroup('text', next)} />)}
    {section('Layout & spacing', fields([number('layout.padding', 'Padding', 0, 64, 12, 1, 'px'), number('layout.gap', 'Spacing', 0, 48, 8, 1, 'px'), number('layout.maxWidth', 'Maximum width', 20, 100, 85, 1, '%'), choice('layout.alignment', 'Alignment', ['left', 'center', 'right']), ...(bubble ? [choice('layout.tail', 'Tail corner', ['none', 'left', 'right'])] : [])]))}
    {bubble && section('Avatar, names & timestamps', fields([number('avatar.size', 'Avatar size', 16, 96, 36, 1, 'px'), choice('avatar.shape', 'Avatar shape', ['circle', 'rounded', 'square']), color('avatar.ringColor', 'Avatar ring'), number('avatar.ringWidth', 'Ring width', 0, 12, 2, 1, 'px'), boolean('avatar.showName', 'Show speaker names'), boolean('avatar.showTimestamp', 'Show timestamps')]))}
  </div>;
}
