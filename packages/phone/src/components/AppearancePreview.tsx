import React, { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppTheme } from '../types';
import type { VoiceCompanion } from '../lib/voices';
import { THEMES, withAccentOverride } from '../lib/theme';
import { cn } from '../lib/utils';
import { buildAppearanceCss } from '../lib/appearance-css';
import { BubblePaintLayers } from './AppearanceRuntime';

/** The existing Settings preview, now using the same role markers and paint
 * planes as real messages. No second theme resolver or saved preview state. */
export function AppearancePreview({ theme, companions, section, userAvatar, userRing }: {
  theme: AppTheme; companions: VoiceCompanion[]; section: string; userAvatar?: string; userRing?: string;
}) {
  const palette = withAccentOverride(THEMES[theme.id] || THEMES.monochrome, theme.accentOverride, theme.accentPalette);
  const colors = palette[theme.mode];
  const css = useMemo(() => buildAppearanceCss(theme.appearance, { scope: '[data-appearance-preview]', section }), [theme.appearance, section]);
  const roles = companions.length ? companions : [{ slug: 'fallback', display_name: 'Companion', emoji: '✦', avatar_url: null, color: null }];
  const bubble = (speaker: string, name: string, text: string, avatar?: string | null, emoji?: string | null, ring?: string | null) => {
    const user = speaker === 'user';
    return <div key={speaker} data-appearance-message="" data-speaker={speaker}
      className={cn('flex items-start gap-2', user && 'flex-row-reverse')}>
      {avatar ? <img data-appearance-avatar="" src={avatar} alt="" className="h-9 w-9 shrink-0 rounded-full border-2 object-cover" style={{ borderColor: ring || 'transparent' }} />
        : <span data-appearance-avatar="" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 bg-white/10 text-sm" style={{ borderColor: ring || 'transparent' }}>{emoji || (user ? 'You' : '✦')}</span>}
      <div data-appearance-column="" className={cn('flex max-w-[85%] flex-col', user ? 'items-end' : 'items-start')}>
        <span data-appearance-name="" className={cn('mb-1 hidden text-[10px] font-semibold', colors.textMuted)}>{name}</span>
        <div data-appearance-bubble="" data-user={String(user)} data-speaker={speaker}
          className={cn('bytelight-message-bubble relative overflow-hidden rounded-[var(--shape-bubble)] border px-3.5 py-2 text-[13px]', colors.panelBorder,
            user ? cn(colors.userBubbleBg, colors.userBubbleText, 'rounded-tr-none') : cn(colors.compBubbleBg, colors.compBubbleText, 'rounded-tl-none'))}>
          <BubblePaintLayers /><span className="relative z-[1]">{text}</span>
        </div>
        <span data-appearance-timestamp="" className={cn('mt-1 text-[9px] opacity-60', colors.textMuted)}>12:34</span>
      </div>
    </div>;
  };
  return <section data-appearance-preview="" className={cn('space-y-3 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
    {css && <style>{css}</style>}
    <div className="flex items-center justify-between gap-2"><h3 className={cn('micro-label', colors.accentText)}>Live Preview</h3><span className={cn('ml-auto text-[10px]', colors.textMuted)}>{section === 'settings' ? 'Settings' : section}</span><button type="button" className={cn('rounded-lg border px-2 py-1 text-[10px]', colors.panelBorder, colors.textMain)} onClick={() => document.querySelector('[data-theme-editor]')?.scrollIntoView({ block: 'start' })}>Controls ↓</button></div>
    <div data-appearance-card="" className={cn('rounded-2xl border p-3', colors.panelBg, colors.panelBorder)}>
      <h4 className={cn('text-sm font-semibold', colors.textMain)}>Your card layers</h4>
      <p className={cn('mt-1 text-xs', colors.textMuted)}>Texture, border and glow stay behind readable text.</p>
    </div>
    <div className="space-y-2">
      {roles.map((role, index) => bubble(role.slug, role.display_name, index ? 'My bubbles get their own look.' : 'How’s the vibe looking?', role.avatar_url, role.emoji, role.color))}
      {bubble('user', 'You', 'Entirely mine. ✨', userAvatar, null, userRing)}
    </div>
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" className="bytelight-on-accent rounded-full px-4 py-1.5 text-xs font-bold" style={{ background: 'var(--bytelight-accent)' }}>Primary</button>
      <button type="button" className={cn('rounded-full border px-4 py-1.5 text-xs font-bold', colors.panelBorder, colors.textMain)}>Ghost</button>
      <button type="button" role="tab" aria-selected="true" data-appearance-tab="" className={cn('rounded-full border px-3 py-1.5 text-xs', colors.panelBorder, colors.textMain)} style={{ background: 'var(--bytelight-accent)', color: 'var(--bytelight-on-accent)' }}>Selected</button>
      <button type="button" disabled className={cn('rounded-full border px-3 py-1.5 text-xs opacity-40', colors.panelBorder, colors.textMain)}>Disabled</button>
      <span data-unread="true" className="appearance-unread rounded-full bg-rose-500 px-2 py-0.5 text-[10px] text-white">2</span>
      <Loader2 size={15} className="animate-spin" aria-label="Loading preview" />
    </div>
  </section>;
}
