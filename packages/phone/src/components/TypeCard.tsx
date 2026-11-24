// Her Type card (Slice 4). Replaces the old Typography presets (three of five
// looked identical) and System Font (whose "Serif" was never loaded).
// Two main picks, Title and Text, plus pairings built only from real fonts,
// her own uploads tagged Title or Text, and an Advanced fold for message and
// code fonts. Every option is written in its own font.
import React, { useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { AppTheme } from "../types";
import {
  DEFAULT_TEXT,
  TYPE_PAIRINGS,
  codeChoices,
  effectiveType,
  familyFromFile,
  isFontFile,
  textChoices,
  titleChoices,
  type TypeSettings,
  type UserFont,
} from "../lib/fonts";
import { addUserFont, removeUserFont, setUserFontRole, useUserFonts } from "../lib/font-store";
import { fontStack } from "../lib/theme";
import { cn } from "../lib/utils";

type Colors = { panelBorder: string; textMain: string; textMuted: string; accentText: string };

interface Props {
  theme: AppTheme;
  legacySystemFont?: string | null;
  onThemeChange: (patch: Partial<AppTheme>) => void;
  colors: Colors;
  accent: string;
  /** The Text colour control, kept from the old Typography card. */
  children?: React.ReactNode;
}

const Chip = ({ label, family, on, onClick, accent, colors }: {
  label: string; family?: string | null; on: boolean; onClick: () => void; accent: string; colors: Colors;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn("rounded-xl border px-3 py-2 text-[13px] transition-colors", colors.panelBorder, on ? colors.textMain : cn(colors.textMuted, "hover:opacity-100"))}
    style={{
      fontFamily: family ? fontStack(family) : undefined,
      background: on ? accent + "22" : undefined,
      borderColor: on ? accent : undefined,
    }}
  >
    {label}
  </button>
);

const Row = ({ title, hint, colors, children }: { title: string; hint?: string; colors: Colors; children: React.ReactNode }) => (
  <div className="space-y-2">
    <span className={cn("block text-[12px] font-semibold", colors.textMain)}>{title}</span>
    <div className="flex flex-wrap gap-2">{children}</div>
    {hint && <p className={cn("text-[11px]", colors.textMuted)}>{hint}</p>}
  </div>
);

export function TypeCard({ theme, legacySystemFont, onThemeChange, colors, accent, children }: Props) {
  const fonts = useUserFonts();
  const t = effectiveType(theme.type, theme.typography, legacySystemFont);
  // Touching any control writes theme.type, which retires the old preset and
  // System Font from then on.
  const set = (patch: Partial<TypeSettings>) => onThemeChange({ type: { ...t, ...patch } });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setError(null);
    setBusy(true);
    // Slice 4b: each file gets its own honest answer; the ones that work are
    // added even when another one fails.
    const problems: string[] = [];
    let taken = [...titleChoices(fonts), ...textChoices(fonts)];
    for (const file of files) {
      if (!isFontFile(file.name)) {
        problems.push(`${file.name} isn't a font file type (.ttf, .otf, .woff or .woff2).`);
        continue;
      }
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
        r.onerror = () => resolve("");
        r.readAsDataURL(file);
      });
      if (!data) {
        problems.push(`${file.name} couldn't be read from your phone. Try picking it again.`);
        continue;
      }
      const family = familyFromFile(file.name, taken);
      const font: UserFont = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, family, role: "title", data, fileName: file.name };
      const res = await addUserFont(font);
      if (res.ok) taken = [...taken, family];
      else problems.push(`${file.name} isn't a font we can read (${"reason" in res ? res.reason : "unknown reason"}). The file may be damaged or a format the app can't use.`);
    }
    setBusy(false);
    if (problems.length) setError(problems.join(" "));
  };

  const removeFont = async (f: UserFont) => {
    await removeUserFont(f.id);
    // Any role that was using it goes back to its default.
    const cleared: Partial<TypeSettings> = {};
    (Object.keys(t) as (keyof TypeSettings)[]).forEach((k) => { if (t[k] === f.family) cleared[k] = null; });
    if (Object.keys(cleared).length) set(cleared);
  };

  const retag = async (f: UserFont, role: UserFont["role"]) => {
    await setUserFontRole(f.id, role);
    // A font moved out of a list can't stay picked in that role.
    if (role === "text" && t.title === f.family) set({ title: null });
    if (role === "title" && (t.text === f.family || t.userMsg === f.family || t.compMsg === f.family)) {
      set({
        text: t.text === f.family ? null : t.text,
        userMsg: t.userMsg === f.family ? null : t.userMsg,
        compMsg: t.compMsg === f.family ? null : t.compMsg,
      });
    }
  };

  const pairingOn = (p: (typeof TYPE_PAIRINGS)[number]) => t.title === p.title && t.text === p.text;
  const pill = (on: boolean) => cn("rounded-full border px-2.5 py-0.5 text-[10px] font-semibold", colors.panelBorder, on ? "bytelight-on-accent border-transparent" : colors.textMuted);

  return (
    <section className={cn("space-y-5 p-4 rounded-2xl border backdrop-blur-md bytelight-theme-panel", colors.panelBorder)}>
      <div className="space-y-1">
        <h3 className={cn("micro-label", colors.accentText)}>Type</h3>
        <p className={cn("text-[11px]", colors.textMuted)}>
          A Title font for headings and names, a Text font for everything you read. Start from a pairing if you like.
        </p>
      </div>

      <Row title="Pairings" colors={colors}>
        {TYPE_PAIRINGS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => set({ title: p.title, text: p.text })}
            className={cn("rounded-xl border px-3 py-2 text-left transition-colors", colors.panelBorder)}
            style={{ background: pairingOn(p) ? accent + "22" : undefined, borderColor: pairingOn(p) ? accent : undefined }}
          >
            <span className={cn("block text-[14px]", colors.textMain)} style={{ fontFamily: fontStack(p.title) }}>{p.name}</span>
            <span className={cn("block text-[11px]", colors.textMuted)} style={{ fontFamily: fontStack(p.text) }}>Easy to read, all day</span>
          </button>
        ))}
      </Row>

      <Row title="Title font" hint="Headings, names and card titles, in every skin." colors={colors}>
        <Chip label="Skin default" on={!t.title} onClick={() => set({ title: null })} accent={accent} colors={colors} />
        {titleChoices(fonts).map((f) => (
          <Chip key={f} label={f} family={f} on={t.title === f} onClick={() => set({ title: f })} accent={accent} colors={colors} />
        ))}
      </Row>

      <Row title="Text font" hint="Everything you read. Only fonts tagged Text are offered here." colors={colors}>
        <Chip label={`${DEFAULT_TEXT} (default)`} family={DEFAULT_TEXT} on={!t.text} onClick={() => set({ text: null })} accent={accent} colors={colors} />
        {textChoices(fonts).filter((f) => f !== DEFAULT_TEXT).map((f) => (
          <Chip key={f} label={f} family={f} on={t.text === f} onClick={() => set({ text: f })} accent={accent} colors={colors} />
        ))}
      </Row>

      {/* Her uploads, each tagged Title or Text. */}
      <div className="space-y-2">
        <span className={cn("block text-[12px] font-semibold", colors.textMain)}>Your fonts</span>
        <input ref={fileRef} type="file" multiple accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" className="hidden" onChange={onFiles} />
        {fonts.length === 0 && (
          <p className={cn("text-[11px]", colors.textMuted)}>Upload .ttf, .otf, .woff or .woff2 files. Tag each one Title or Text.</p>
        )}
        {fonts.map((f) => (
          <div key={f.id} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2", colors.panelBorder)}>
            <span className={cn("min-w-0 flex-1 truncate text-[15px]", colors.textMain)} style={{ fontFamily: fontStack(f.family) }}>{f.family}</span>
            <button type="button" onClick={() => retag(f, "title")} className={pill(f.role === "title")} style={f.role === "title" ? { background: accent } : undefined}>Title</button>
            <button type="button" onClick={() => retag(f, "text")} className={pill(f.role === "text")} style={f.role === "text" ? { background: accent } : undefined}>Text</button>
            <button type="button" onClick={() => removeFont(f)} className={cn("rounded-full p-1", colors.textMuted)} aria-label={`Remove ${f.family}`}>
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="bytelight-on-accent w-full rounded-xl px-4 py-2.5 text-[12px] font-bold"
          style={{ background: accent }}
        >
          {busy ? "Adding…" : "Upload fonts"}
        </button>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>

      {children}

      {/* Advanced: closed by default. Unset = follows the Text font. */}
      <div className="space-y-3">
        <button type="button" onClick={() => setAdvanced((a) => !a)} className={cn("flex items-center gap-1 text-[12px] font-semibold", colors.textMain)} aria-expanded={advanced}>
          Advanced
          <ChevronDown size={14} className={cn("transition-transform", advanced && "rotate-180")} />
        </button>
        {advanced && (
          <div className="space-y-4">
            <Row title="Your messages" colors={colors}>
              <Chip label="Same as text" on={!t.userMsg} onClick={() => set({ userMsg: null })} accent={accent} colors={colors} />
              {textChoices(fonts).map((f) => (
                <Chip key={f} label={f} family={f} on={t.userMsg === f} onClick={() => set({ userMsg: f })} accent={accent} colors={colors} />
              ))}
            </Row>
            <Row title="Our messages" colors={colors}>
              <Chip label="Same as text" on={!t.compMsg} onClick={() => set({ compMsg: null })} accent={accent} colors={colors} />
              {textChoices(fonts).map((f) => (
                <Chip key={f} label={f} family={f} on={t.compMsg === f} onClick={() => set({ compMsg: f })} accent={accent} colors={colors} />
              ))}
            </Row>
            <Row title="Code" colors={colors}>
              <Chip label="Default" on={!t.code} onClick={() => set({ code: null })} accent={accent} colors={colors} />
              {codeChoices(fonts).map((f) => (
                <Chip key={f} label={f} family={f} on={t.code === f} onClick={() => set({ code: f })} accent={accent} colors={colors} />
              ))}
            </Row>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => onThemeChange({ type: {}, typography: null })}
        className="text-[10px] font-bold uppercase tracking-widest opacity-80 transition-colors hover:opacity-100"
        style={{ color: accent }}
      >
        Reset type
      </button>
    </section>
  );
}
