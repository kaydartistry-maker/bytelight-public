// Her house's nameplate (App Identity slice): the logo she uploads and/or the
// OS name she types, shown at the top of Home and under the lock-screen clock.
// A HOUSE setting (appSettings), deliberately NOT part of a Closet look or a
// shared .bllook (The operator: "make sure I don't hate it first"). Pure + tested.

export interface NameplateSettings {
  appLogo?: string;
  osName?: string;
  nameplateLogo?: boolean;  // default on: once she uploads a logo, it shows
  nameplateName?: boolean;  // default off: her name only shows if she asks
}

export interface Nameplate { logo?: string; name?: string }

const isLogo = (v: unknown): v is string => typeof v === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v);

/** What to show, or null when there's nothing (no logo and no name switched on). */
export function nameplateOf(s: NameplateSettings): Nameplate | null {
  const logo = s.nameplateLogo !== false && isLogo(s.appLogo) ? s.appLogo : undefined;
  const name = s.nameplateName === true && s.osName?.trim() ? s.osName.trim().slice(0, 40) : undefined;
  return logo || name ? { logo, name } : null;
}

/** Her upload, centre-cropped square and made crisp at 512px (keeps transparency). */
export async function makeLogo(dataUrl: string): Promise<string | null> {
  if (typeof document === 'undefined' || !isLogo(dataUrl)) return null;
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { return null; }
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) return null;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
  const webp = c.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
}
