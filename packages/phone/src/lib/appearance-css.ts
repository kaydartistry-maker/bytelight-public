import { collectThemeAssetIds, normalizeThemeAppearance, resolveBubbleAppearance, resolveCardAppearance, resolveControlAppearance,
  type AppearanceOverlay, type AppearanceSurface, type AppearanceText, type ThemeAppearance } from '@bytelight/shared';
import { contrastTextColor } from './theme';

export const themeAssetUrl = (id: string): string => `/api/theme-assets/${encodeURIComponent(id)}/file`;
export const themeFontFamily = (id: string): string => `ThemeFont_${id.replaceAll('-', '_')}`;
const mix = (color: string, opacity = 100) => `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
const px = (n: number) => `${n}px`;
const fontFamily = (text: AppearanceText) => text.assetId ? `"${themeFontFamily(text.assetId)}"`
  : text.font ? `"${text.font}",system-ui,sans-serif` : undefined;
const entries = (values: Record<string, string | number | undefined>): string => Object.entries(values)
  .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}:${value}!important`).join(';');
const rule = (selector: string, values: Record<string, string | number | undefined>): string => {
  const declarations = entries(values);
  const guard = ':not(:where([data-theme-editor],[data-theme-editor] *))';
  const guarded = /::[\w-]+$/.test(selector) ? selector.replace(/(::[\w-]+)$/, `${guard}$1`) : selector + guard;
  return declarations ? `${guarded}{${declarations}}` : '';
};
function textDeclarations(text?: AppearanceText, ink = 'var(--bytelight-text)'): Record<string, string | number | undefined> {
  return text ? {
    'font-family': fontFamily(text), 'font-size': text.size === undefined ? undefined : px(text.size),
    'font-weight': text.weight, 'line-height': text.lineHeight,
    'letter-spacing': text.tracking === undefined ? undefined : `${text.tracking}em`,
    color: text.color || text.opacity !== undefined ? mix(text.color ?? ink, text.opacity) : undefined,
  } : {};
}
function imagePaint(selector: string, image: AppearanceOverlay | undefined, ring = false, width = 1): string {
  if (!image?.assetId) return '';
  return rule(selector, {
    content: "''", position: 'absolute', inset: '0', 'pointer-events': 'none', 'border-radius': 'inherit',
    'z-index': '0', 'background-image': `url("${themeAssetUrl(image.assetId)}")`,
    'background-size': image.scale === undefined ? 'cover' : `${image.scale}%`,
    'background-position': 'center', 'background-repeat': image.repeat === 'none' || !image.repeat ? 'no-repeat' : image.repeat,
    opacity: (image.opacity ?? 100) / 100, 'mix-blend-mode': image.blend ?? 'normal',
    ...(ring ? { padding: px(width), '-webkit-mask': 'linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0)',
      mask: 'linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0)',
      '-webkit-mask-composite': 'xor', 'mask-composite': 'exclude' } : {}),
  });
}
function surfaceCss(selector: string, surface: AppearanceSurface, options: { bubble?: boolean; control?: boolean; fill?: string; ink?: string; defaultTail?: 'left' | 'right' } = {}): string {
  const { fill, border, shadow, gradient, text, layout } = surface;
  const radius = border?.radius === undefined ? undefined : px(border.radius);
  let css = rule(selector, {
    'background-color': fill ? mix(fill.color ?? options.fill ?? 'var(--bytelight-panel-base)', fill.opacity) : undefined,
    'background-image': gradient ? `linear-gradient(${gradient.angle ?? 135}deg,${mix(gradient.from ?? 'var(--bytelight-accent)', gradient.opacity)},${mix(gradient.to ?? 'transparent', gradient.opacity)})` : fill ? 'none' : undefined,
    'border-color': border && (border.color || border.opacity !== undefined)
      ? mix(border.color ?? 'var(--bytelight-border)', border.opacity) : undefined,
    'border-width': border?.width === undefined ? undefined : px(border.width),
    'border-style': border?.style ?? (border?.width !== undefined ? 'solid' : undefined), 'border-radius': radius,
    'box-shadow': shadow ? `${shadow.inset ? 'inset ' : ''}${shadow.x ?? 0}px ${shadow.y ?? 4}px ${shadow.blur ?? 12}px ${mix(shadow.color ?? '#000000', shadow.opacity ?? 25)}` : undefined,
    ...textDeclarations(text, options.ink), padding: layout?.padding === undefined ? undefined : px(layout.padding),
    gap: layout?.gap === undefined ? undefined : px(layout.gap),
    'max-width': !options.bubble && layout?.maxWidth !== undefined ? `${layout.maxWidth}%` : undefined,
    ...(!options.bubble && surface.blur !== undefined ? { 'backdrop-filter': `blur(${surface.blur}px)`, '-webkit-backdrop-filter': `blur(${surface.blur}px)` } : {}),
  });
  const tail = layout?.tail ?? (radius !== undefined ? options.defaultTail : undefined);
  if (options.bubble && tail !== undefined) {
    const corner = radius ?? 'var(--shape-bubble)';
    css += rule(selector, { 'border-top-left-radius': tail === 'left' ? '0' : corner,
      'border-top-right-radius': tail === 'right' ? '0' : corner });
  }
  // A border image is necessarily a continuous ring. Let native dashed,
  // dotted and double borders remain visible instead of painting a solid
  // textured ring over the selected style.
  const borderOverlay = !border?.style || border.style === 'solid' ? border?.overlay : undefined;
  if (surface.overlay?.assetId || borderOverlay?.assetId) {
    css += rule(selector, { position: 'relative', isolation: 'isolate' });
    css += imagePaint(options.bubble ? `${selector}>.appearance-paint` : `${selector}::after`, surface.overlay);
    const ring = borderOverlay ? { ...borderOverlay, opacity: (borderOverlay.opacity ?? 100) * (border?.opacity ?? 100) / 100 } : undefined;
    css += imagePaint(options.bubble ? `${selector}>.appearance-border` : `${selector}::before`, ring, true, border?.width ?? 1);
    // The paint belongs above the inherited skin/fill and below actual card
    // contents. Without this layer boundary opaque themes darken the chosen
    // image before the opacity control has done anything.
    css += rule(`${selector}>:not(.appearance-paint,.appearance-border)`, { position: 'relative', 'z-index': '1' });
  }
  if (text && Object.keys(text).length) {
    // Explicit surface typography must beat descendant utility classes. Only
    // reset configured properties; changing opacity must not reset prose size.
    const descendants = options.bubble ? ':is(.prose,.prose p,.prose span)'
      : ':is(div,span,p,label,small,h1,h2,h3,h4,h5,h6,.prose)';
    const exclude = !options.bubble && !options.control
      ? ':not(:where(button:not([data-appearance-card]),button:not([data-appearance-card]) *,[role="tab"],[role="tab"] *,input,textarea,select))' : '';
    css += rule(`${selector} ${descendants}${exclude}`, {
      'font-family': fontFamily(text) ? 'inherit' : undefined,
      'font-size': text.size === undefined ? undefined : 'inherit',
      'font-weight': text.weight === undefined ? undefined : 'inherit',
      'line-height': text.lineHeight === undefined ? undefined : 'inherit',
      'letter-spacing': text.tracking === undefined ? undefined : 'inherit',
      color: text.color || text.opacity !== undefined ? 'inherit' : undefined,
    });
  }
  return css;
}
function bubbleCss(scope: string, speaker: string | undefined, settings: ThemeAppearance): string {
  const surface = speaker ? resolveBubbleAppearance(settings, speaker) : settings.chat?.defaults ?? {};
  const suffix = speaker ? `[data-speaker="${speaker}"]` : '';
  const selector = `${scope} [data-appearance-bubble]${suffix}`;
  const row = `${scope} [data-appearance-message]${suffix}`;
  let css = surfaceCss(selector, surface, { bubble: true,
    fill: speaker === 'user' ? 'var(--bytelight-user-bubble)' : 'var(--bytelight-comp-bubble)',
    ink: speaker === 'user' ? 'var(--bytelight-user-bubble-text)' : 'var(--bytelight-comp-bubble-text)',
    defaultTail: speaker === 'user' ? 'right' : 'left' });
  if (surface.layout?.maxWidth !== undefined) css += rule(`${row}>[data-appearance-column]`, { 'max-width': `${surface.layout.maxWidth}%` });
  if (surface.layout?.alignment) {
    const align = { left: 'flex-start', center: 'center', right: 'flex-end' }[surface.layout.alignment];
    css += rule(row, { 'justify-content': align });
    css += rule(`${row}>[data-appearance-column]`, { 'align-items': align, 'margin-left': '0', 'margin-right': '0' });
  }
  if (surface.layout?.gap !== undefined) css += rule(row, { 'margin-bottom': px(surface.layout.gap) });
  const avatar = surface.avatar;
  if (avatar) {
    css += rule(`${row} [data-appearance-avatar]`, {
      width: avatar.size === undefined ? undefined : px(avatar.size), height: avatar.size === undefined ? undefined : px(avatar.size),
      'border-radius': avatar.shape === undefined ? undefined : avatar.shape === 'circle' ? '50%' : avatar.shape === 'rounded' ? '25%' : '0',
      'border-color': avatar.ringColor, 'border-width': avatar.ringWidth === undefined ? undefined : px(avatar.ringWidth),
    });
    if (avatar.showName !== undefined) css += rule(`${row} [data-appearance-name]`, { display: avatar.showName ? 'block' : 'none' });
    if (avatar.showTimestamp !== undefined) css += rule(`${row} [data-appearance-timestamp]`, { display: avatar.showTimestamp ? 'inline' : 'none' });
  }
  return css;
}

/** Scope is a developer-owned simple selector, never an imported CSS string. */
export function buildAppearanceCss(input: unknown, options: { scope?: string; section?: string } = {}): string {
  const scope = options.scope ?? 'body';
  if (!/^(?:body|[.#][a-z][\w-]*|\[data-[a-z-]+(?:="[\w-]+")?\])$/i.test(scope)) throw new Error('Unsafe appearance CSS scope');
  const settings = normalizeThemeAppearance(input);
  let css = '';
  const card = `${scope} :is(section.backdrop-blur-md,div.backdrop-blur-md,[data-appearance-card]):not(.fixed.inset-0):not(:where(.bytelight-message-bubble,.bytelight-message-bubble *,[data-appearance-bubble],[data-appearance-bubble] *)):not(:has(.bytelight-message-bubble,[data-appearance-bubble]))`;
  css += surfaceCss(card, resolveCardAppearance(settings, options.section));
  if (settings.chat) {
    css += bubbleCss(scope, undefined, settings);
    for (const speaker of ['user', ...Object.keys(settings.chat.companions ?? {})]) css += bubbleCss(scope, speaker, settings);
    const timestampOverride = [settings.chat.defaults, ...Object.values(settings.chat.companions ?? {})]
      .some(value => value?.avatar?.showTimestamp !== undefined);
    if (timestampOverride) {
      css = rule(`${scope} .appearance-split-time`, { display: 'block' }) + css;
      css += rule(`${scope} [data-appearance-shared-time]`, { display: 'none' });
    }
  }
  const typography = settings.typography;
  if (typography?.body) {
    css += rule(scope, { ...textDeclarations(typography.body), '--font-body': fontFamily(typography.body), '--font-sans': fontFamily(typography.body) });
    css += rule(`${scope} .bytelight-root`, textDeclarations(typography.body));
    css += rule(`${scope} :where(.bytelight-message-bubble,.prose)`, textDeclarations(typography.body));
  }
  if (typography?.heading) {
    css += rule(scope, { '--font-heading': fontFamily(typography.heading) });
    css += rule(`${scope} :is(h1,h2,h3,h4,h5,h6,.font-heading)`, textDeclarations(typography.heading));
  }
  if (typography?.mono) {
    css += rule(scope, { '--font-mono-choice': fontFamily(typography.mono) });
    css += rule(`${scope} :is(pre,code,.font-mono)`, textDeclarations(typography.mono));
  }
  const stateSelectors = {
    hover: ':hover', selected: ':is([aria-selected="true"],[aria-pressed="true"])',
    pressed: ':active', disabled: ':is(:disabled,[aria-disabled="true"])',
  } as const;
  for (const kind of ['buttons', 'tabs'] as const) {
    const selector = kind === 'buttons' ? `${scope} button:not(:where([role="tab"],[data-appearance-tab],[data-appearance-card],.bytelight-message-bubble *))`
      : `${scope} :is([role="tab"],[data-appearance-tab])`;
    css += surfaceCss(selector, resolveControlAppearance(settings, kind), { control: true });
    const states = kind === 'buttons' ? settings.controls?.buttonStates : settings.controls?.tabStates;
    // Equal-specificity state order is intentional: disabled > pressed >
    // selected > hover. Only explicitly configured states introduce rules.
    for (const state of ['hover', 'selected', 'pressed', 'disabled'] as const) {
      if (states?.[state]) css += surfaceCss(selector + stateSelectors[state], resolveControlAppearance(settings, kind, state), { control: true });
    }
  }
  if (settings.controls?.icons) {
    const { size, color, opacity, strokeWidth } = settings.controls.icons;
    css += rule(`${scope} svg.lucide`, { width: size === undefined ? undefined : px(size), height: size === undefined ? undefined : px(size),
      color: color || opacity !== undefined ? mix(color ?? 'var(--bytelight-icon)', opacity) : undefined, 'stroke-width': strokeWidth });
  }
  const details = settings.details;
  if (details) {
    css += rule(scope, { '--scrollbar-thumb': details.scrollbarColor });
    css += rule(`${scope} ::-webkit-scrollbar`, {
      width: details.scrollbarWidth === undefined ? undefined : px(details.scrollbarWidth),
      height: details.scrollbarWidth === undefined ? undefined : px(details.scrollbarWidth),
      display: details.scrollbarWidth === undefined ? undefined : details.scrollbarWidth === 0 ? 'none' : 'block',
    });
    css += rule(`${scope} ::-webkit-scrollbar-thumb`, { 'background-color': details.scrollbarColor });
    if (details.scrollbarColor || details.scrollbarWidth !== undefined) css += rule(`${scope} *`, {
      'scrollbar-color': details.scrollbarColor ? `${details.scrollbarColor} transparent` : undefined,
      'scrollbar-width': details.scrollbarWidth === undefined ? undefined : details.scrollbarWidth === 0 ? 'none' : 'thin',
    });
    css += rule(`${scope} :is(hr,[data-appearance-divider])`, { 'border-color': details.dividerColor,
      'border-width': details.dividerWidth === undefined ? undefined : px(details.dividerWidth) });
    css += rule(`${scope} :focus-visible`, { 'outline-color': details.focusColor,
      'outline-width': details.focusWidth === undefined ? undefined : px(details.focusWidth), 'outline-style': details.focusWidth !== undefined || details.focusColor ? 'solid' : undefined });
    css += rule(`${scope} :is([data-unread="true"],.appearance-unread)`, {
      'background-color': details.unreadColor,
      color: details.unreadColor?.startsWith('#') ? contrastTextColor(details.unreadColor) : undefined,
    });
    css += rule(`${scope} :is(.animate-spin,[data-appearance-loading])`, { color: details.loadingColor });
    css += rule(`${scope} ::selection`, { 'background-color': details.selectionColor });
  }
  const motion = settings.motion;
  if (motion) {
    const off = motion.enabled === false || motion.reduceMotion === true || motion.scale === 0 || motion.duration === 0;
    const scale = (motion.scale ?? 100) / 100;
    if (off || motion.duration !== undefined || motion.scale !== undefined) {
      const duration = off ? '0ms' : motion.duration !== undefined ? `${motion.duration}ms` : `calc(var(--tw-duration,150ms) * ${scale})`;
      css += rule(scope, { '--fx-motion': scale, '--appearance-motion-duration': duration });
      css += rule(`${scope} :is([class*="transition"],button,[role="tab"])`, { 'transition-duration': duration });
      if (off || motion.duration !== undefined) css += rule(`${scope} [class*="animate-"]`, {
        'animation-duration': off ? '0.01ms' : `${motion.duration}ms`, 'animation-iteration-count': off ? '1' : undefined,
      });
      else css += rule(scope, {
        '--animate-spin': `spin calc(1s * ${scale}) linear infinite`,
        '--animate-pulse': `pulse calc(2s * ${scale}) cubic-bezier(0.4,0,0.6,1) infinite`,
        '--animate-ping': `ping calc(1s * ${scale}) cubic-bezier(0,0,0.2,1) infinite`,
        '--animate-bounce': `bounce calc(1s * ${scale}) infinite`,
      });
    }
    if (motion.hover === false) css += rule(`${scope} :is(button,[role="tab"]):hover`, { transform: 'none' });
    if (motion.press === false) css += rule(`${scope} :is(button,[role="tab"]):active`, { transform: 'none' });
    if (motion.entrance === false) css += rule(`${scope} [data-appearance-message]`, { animation: 'none' });
    css += `@media(prefers-reduced-motion:reduce){${['*', '*::before', '*::after'].map(child => rule(`${scope} ${child}`, { 'animation-duration': '0.01ms', 'animation-iteration-count': '1', 'transition-duration': '0.01ms', 'scroll-behavior': 'auto' })).join('')}}`;
  }
  if (typography?.body || typography?.heading || typography?.mono) {
    // Root font variables inherit; the editor intentionally keeps a readable
    // neutral face even while a dramatic draft is previewed elsewhere.
    css += `${scope} [data-theme-editor]{font-family:system-ui!important;font-size:14px!important;font-weight:400!important;line-height:1.5!important;letter-spacing:normal!important;color:var(--bytelight-text)!important;--font-body:system-ui;--font-sans:system-ui;--font-heading:system-ui;--font-mono-choice:ui-monospace}`;
  }
  return buildAppearanceFontFaces(settings) + css;
}

/** Only font slots generate faces; image asset IDs must never become font loads. */
export function buildAppearanceFontFaces(input: unknown): string {
  const settings = normalizeThemeAppearance(input);
  const fontIds = new Set<string>();
  function surface(value?: AppearanceSurface) { if (value?.text?.assetId) fontIds.add(value.text.assetId); }
  surface(settings.cards); Object.values(settings.sectionOverrides ?? {}).forEach(surface);
  surface(settings.chat?.defaults); surface(settings.chat?.user); Object.values(settings.chat?.companions ?? {}).forEach(surface);
  surface(settings.controls?.buttons); surface(settings.controls?.tabs);
  Object.values(settings.controls?.buttonStates ?? {}).forEach(surface);
  Object.values(settings.controls?.tabStates ?? {}).forEach(surface);
  Object.values(settings.typography ?? {}).forEach(value => { if (value.assetId) fontIds.add(value.assetId); });
  // The normalizer is also the identifier/security boundary.
  const valid = new Set(collectThemeAssetIds(settings));
  return [...fontIds].filter(id => valid.has(id)).sort().map(id =>
    `@font-face{font-family:"${themeFontFamily(id)}";src:url("${themeAssetUrl(id)}");font-display:swap}`).join('');
}
