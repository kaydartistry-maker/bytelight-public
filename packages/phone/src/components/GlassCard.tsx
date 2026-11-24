// Her Glass card (Slice 2): the controls for the one glass every surface in
// the house is made of. Each control writes theme.glass; lib/glass.ts turns it
// into the variables index.css paints with. Unset = the Slice 1 look.
import React, { useRef, useState } from "react";
import type { AppTheme } from "../types";
import { GLASS_DEFAULTS, type GlassSettings, type TextureFit } from "../lib/glass";
import { shrinkTexture } from "../lib/texture";
import { cn } from "../lib/utils";

type Colors = { panelBorder: string; textMain: string; textMuted: string; accentText: string };

interface Props {
  theme: AppTheme;
  onThemeChange: (patch: Partial<AppTheme>) => void;
  colors: Colors;
  accent: string;
  roundness: number;
}

const Slider = ({ colors, accent, label, value, shown, min, max, step, onChange }: {
    colors: Colors; accent: string; label: string; value: number; shown: string; min: number; max: number; step: number; onChange: (n: number) => void;
  }) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn("text-[12px] font-semibold", colors.textMain)}>{label}</span>
        <span className={cn("text-[11px]", colors.textMuted)}>{shown}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer"
        style={{ accentColor: accent }}
        aria-label={label}
      />
    </div>
  );

const ColourRow = ({ colors, pill, pillStyle, label, value, onPick, onTheme }: {
    colors: Colors; pill: (on: boolean) => string; pillStyle: (on: boolean) => React.CSSProperties | undefined; label: string; value: string | null | undefined; onPick: (hex: string) => void; onTheme: () => void;
  }) => (
    <div className="flex items-center justify-between gap-3">
      <span className={cn("text-[12px] font-semibold", colors.textMain)}>{label}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTheme} className={pill(!value)} style={pillStyle(!value)}>
          Theme
        </button>
        <label className={cn("relative h-8 w-8 overflow-hidden rounded-full border cursor-pointer", colors.panelBorder)} title={`Pick ${label.toLowerCase()}`}>
          <span className="absolute inset-0" style={{ background: value || "conic-gradient(#e05252, #d4a030, #44b8a0, #5080c0, #9060a0, #e05252)" }} />
          <input
            type="color"
            value={value || "#2a2438"}
            onChange={(e) => onPick(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label={`Pick ${label.toLowerCase()}`}
          />
        </label>
      </div>
    </div>
  );


export function GlassCard({ theme, onThemeChange, colors, accent, roundness }: Props) {
  const g: GlassSettings = theme.glass || {};
  const set = (patch: Partial<GlassSettings>) => onThemeChange({ glass: { ...g, ...patch } });
  // The texture upload finishes after a FileReader + shrink, so it reads the
  // glass as it is THEN, not as it was when she tapped Upload: a slider moved
  // while the image was loading must not be undone when the image lands.
  const latestGlass = useRef(g);
  latestGlass.current = g;
  const setLatest = (patch: Partial<GlassSettings>) => onThemeChange({ glass: { ...latestGlass.current, ...patch } });

  const opacity = g.opacity ?? GLASS_DEFAULTS.opacity;
  const blur = g.blur ?? GLASS_DEFAULTS.blur;
  const borderWidth = g.borderWidth ?? GLASS_DEFAULTS.borderWidth;
  const glow = g.glow ?? GLASS_DEFAULTS.glow;
  const ink = g.ink ?? GLASS_DEFAULTS.ink;
  const frost = g.bubbleFrost ?? GLASS_DEFAULTS.bubbleFrost;
  const hasWallpaper = Boolean(theme.wallpaper || (theme.slideshowEnabled && theme.wallpapers?.length));
  const mode = g.mode ?? GLASS_DEFAULTS.mode;
  const textured = mode === "texture";
  const strength = g.textureStrength ?? GLASS_DEFAULTS.textureStrength;
  const fit = g.textureFit ?? GLASS_DEFAULTS.textureFit;
  const fileRef = useRef<HTMLInputElement>(null);
  const [texBusy, setTexBusy] = useState(false);
  const [texError, setTexError] = useState<string | null>(null);

  const onTextureFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setTexError("That isn't an image. Try a PNG, JPG or WebP.");
      return;
    }
    setTexError(null);
    setTexBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      void shrinkTexture(raw).then((small) => {
        setTexBusy(false);
        if (small) setLatest({ texture: small, mode: "texture" });
        else setTexError("Couldn't read that image. Try another one.");
      });
    };
    reader.onerror = () => {
      setTexBusy(false);
      setTexError("Couldn't read that image. Try another one.");
    };
    reader.readAsDataURL(file);
  };

  const pill = (on: boolean) =>
    cn(
      "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
      colors.panelBorder,
      on ? "bytelight-on-accent border-transparent" : colors.textMain,
    );
  const pillStyle = (on: boolean) => (on ? { background: accent } : undefined);

  return (
    <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md bytelight-theme-panel", colors.panelBorder)}>
      <div className="space-y-1">
        <h3 className={cn("micro-label", colors.accentText)}>Glass</h3>
        <p className={cn("text-[11px]", colors.textMuted)}>
          The one material every card, bubble, chip and the dock are made of. Change it here and the whole house follows.
        </p>
      </div>

      {/* Colour or Texture (Slice 3). Switching back to Colour keeps her texture saved. */}
      <div className="flex gap-2">
        <button type="button" onClick={() => set({ mode: "colour" })} className={pill(!textured)} style={pillStyle(!textured)}>Colour</button>
        <button type="button" onClick={() => set({ mode: "texture" })} className={pill(textured)} style={pillStyle(textured)}>Texture</button>
      </div>

      {textured && (
        <div className="space-y-3">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onTextureFile} />
          {g.texture ? (
            <div className="flex items-center gap-3">
              <span
                className={cn("block h-14 w-14 shrink-0 rounded-xl border bg-cover bg-center", colors.panelBorder)}
                style={{ backgroundImage: `url("${g.texture}")` }}
                aria-label="Your texture"
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className={pill(false)} disabled={texBusy}>
                  {texBusy ? "Loading…" : "Replace"}
                </button>
                <button type="button" onClick={() => set({ texture: null, mode: "colour" })} className={pill(false)}>Remove</button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={texBusy}
                className="bytelight-on-accent w-full rounded-xl px-4 py-2.5 text-[12px] font-bold"
                style={{ background: accent }}
              >
                {texBusy ? "Loading…" : "Upload a texture"}
              </button>
              <p className={cn("text-[11px]", colors.textMuted)}>
                Stained glass, opal, marble, anything. Every card, bubble, chip and the dock will be made of it.
              </p>
            </div>
          )}
          {texError && <p className="text-[11px] text-red-400">{texError}</p>}
          {g.texture && (
            <>
              <Slider colors={colors} accent={accent} label="Texture strength" value={strength} shown={`${strength}%`} min={0} max={100} step={5} onChange={(n) => set({ textureStrength: n })} />
              <div className="space-y-2">
                <span className={cn("text-[12px] font-semibold", colors.textMain)}>Fit</span>
                <div className="flex flex-wrap gap-2">
                  {([["sheet", "One sheet"], ["fill", "Fill each"], ["tile", "Tile"]] as [TextureFit, string][]).map(([id, label]) => (
                    <button key={id} type="button" onClick={() => set({ textureFit: id })} className={pill(fit === id)} style={pillStyle(fit === id)}>{label}</button>
                  ))}
                </div>
                <p className={cn("text-[11px]", colors.textMuted)}>
                  {fit === "sheet"
                    ? "One pane across the screen. Every surface is a window onto it."
                    : fit === "fill"
                      ? "Each surface shows the whole texture, cropped to fit."
                      : "The texture repeats, like wallpaper. Best for small patterns."}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      <ColourRow colors={colors} pill={pill} pillStyle={pillStyle} label="Tint" value={g.tint} onPick={(hex) => set({ tint: hex })} onTheme={() => set({ tint: null })} />
      <Slider colors={colors} accent={accent} label={textured && g.texture ? "Tint over texture" : "Opacity"} value={opacity} shown={`${opacity}%`} min={0} max={100} step={1} onChange={(n) => set({ opacity: n })} />
      <Slider colors={colors} accent={accent} label="Frost" value={blur} shown={blur === 0 ? "Off" : `${blur}px`} min={0} max={24} step={1} onChange={(n) => set({ blur: n })} />

      <ColourRow colors={colors} pill={pill} pillStyle={pillStyle} label="Border" value={g.borderColor} onPick={(hex) => set({ borderColor: hex })} onTheme={() => set({ borderColor: null })} />
      <Slider colors={colors} accent={accent} label="Border thickness" value={borderWidth} shown={borderWidth === 0 ? "None" : `${borderWidth}px`} min={0} max={3} step={0.5} onChange={(n) => set({ borderWidth: n })} />
      <Slider colors={colors} accent={accent} label="Glow" value={glow} shown={glow === 0 ? "Off" : `${glow}%`} min={0} max={100} step={5} onChange={(n) => set({ glow: n })} />
      <Slider
        colors={colors}
        accent={accent}
        label="Roundness"
        value={roundness}
        shown={roundness <= 6 ? "Sharp" : roundness >= 18 ? "Round" : "Soft"}
        min={0}
        max={24}
        step={2}
        onChange={(n) => onThemeChange({ shapeRadius: n })}
      />

      <div className="space-y-2">
        <span className={cn("text-[12px] font-semibold", colors.textMain)}>Text on glass</span>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => set({ ink: "auto" })} className={pill(ink === "auto")} style={pillStyle(ink === "auto")}>Auto</button>
          <button type="button" onClick={() => set({ ink: "theme" })} className={pill(ink === "theme")} style={pillStyle(ink === "theme")}>Theme</button>
          <label className={cn("relative h-8 w-8 overflow-hidden rounded-full border cursor-pointer", colors.panelBorder, ink.startsWith("#") && "ring-2")} title="Pick text colour">
            <span className="absolute inset-0" style={{ background: ink.startsWith("#") ? ink : "conic-gradient(#e05252, #d4a030, #44b8a0, #5080c0, #9060a0, #e05252)" }} />
            <input type="color" value={ink.startsWith("#") ? ink : "#ffffff"} onChange={(e) => set({ ink: e.target.value })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Pick text colour" />
          </label>
        </div>
        <p className={cn("text-[11px]", colors.textMuted)}>Auto picks light or dark text so it always reads on your tint.</p>
      </div>

      <div className="space-y-2">
        <span className={cn("text-[12px] font-semibold", colors.textMain)}>Bubble frost</span>
        <div className="flex gap-2">
          <button type="button" onClick={() => set({ bubbleFrost: "plain" })} className={pill(frost === "plain")} style={pillStyle(frost === "plain")}>Plain</button>
          <button type="button" onClick={() => set({ bubbleFrost: "painted" })} className={pill(frost === "painted")} style={pillStyle(frost === "painted")}>Painted</button>
        </div>
        <p className={cn("text-[11px]", colors.textMuted)}>
          {hasWallpaper
            ? "Painted gives bubbles and chat chips a frosted look made from your wallpaper. Try both in chat."
            : "Painted needs a wallpaper to frost. Without one, bubbles stay Plain."}
        </p>
      </div>

      <button
        type="button"
        // Back to the Slice 1 look, but her uploaded texture stays saved so
        // she can switch Texture back on without uploading it again.
        onClick={() => onThemeChange({ glass: g.texture ? { texture: g.texture } : undefined, shapeRadius: undefined })}
        className="text-[10px] font-bold uppercase tracking-widest opacity-80 transition-colors hover:opacity-100"
        style={{ color: accent }}
      >
        Reset glass
      </button>
    </section>
  );
}
