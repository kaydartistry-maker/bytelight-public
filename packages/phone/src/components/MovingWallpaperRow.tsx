// Slice 5: the Moving wallpaper control inside the Atmosphere card. On = her
// video / GIF / animated WebP plays behind the house; her still picture and
// slideshow stay saved underneath for when she switches it off.
import React, { useRef, useState } from "react";
import type { AppTheme } from "../types";
import type { ThemeColors } from "../lib/theme";
import { removeMovingWallpaper, saveMovingWallpaper, useMovingWallpaper } from "../lib/moving-wallpaper";
import { Toggle } from "./Toggle";
import { cn } from "../lib/utils";


interface Props {
  theme: AppTheme;
  onThemeChange: (patch: Partial<AppTheme>) => void;
  colors: ThemeColors;
  accent: string;
}

export function MovingWallpaperRow({ theme, onThemeChange, colors, accent }: Props) {
  const moving = useMovingWallpaper();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = !!theme.movingWallpaper;
  const pill = cn("rounded-full border px-3 py-1 text-[11px] font-semibold", colors.panelBorder, colors.textMain);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    const res = await saveMovingWallpaper(file);
    setBusy(false);
    if (res.ok) onThemeChange({ movingWallpaper: true, movingPoster: res.poster });
    else setError("reason" in res ? res.reason : "That file couldn't be used.");
  };

  const remove = async () => {
    await removeMovingWallpaper();
    onThemeChange({ movingWallpaper: false, movingPoster: undefined });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className={cn("block text-[12px] font-semibold", colors.textMain)}>Moving wallpaper</span>
          <span className={cn("block text-[11px]", colors.textMuted)}>A video, GIF or animated WebP behind everything.</span>
        </div>
        <Toggle
          on={on}
          onClick={() => {
            if (!on && !moving) fileRef.current?.click();
            else onThemeChange({ movingWallpaper: !on });
          }}
          colors={colors}
          ariaLabel="Toggle moving wallpaper"
        />
      </div>
      <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,.mp4,.m4v,.webm,.mov,.gif,.webp" className="hidden" onChange={onFile} />

      {moving ? (
        <div className="flex items-center gap-3">
          <span
            className={cn("block h-16 w-12 shrink-0 rounded-xl border bg-cover bg-center", colors.panelBorder)}
            style={{ backgroundImage: theme.movingPoster ? `url("${theme.movingPoster}")` : undefined }}
            aria-label="Your moving wallpaper"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className={pill} disabled={busy}>{busy ? "Checking…" : "Replace"}</button>
            <button type="button" onClick={remove} className={pill}>Remove</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="bytelight-on-accent w-full rounded-xl px-4 py-2.5 text-[12px] font-bold"
          style={{ background: accent }}
        >
          {busy ? "Checking it plays…" : "Upload a moving wallpaper"}
        </button>
      )}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <p className={cn("text-[11px]", colors.textMuted)}>
        MP4 plays everywhere. Up to 20 MB; a gentle 10–20 second loop is usually 3–8 MB. It pauses when the app is in the background, and the lock screen shows its still frame.
      </p>
    </div>
  );
}
