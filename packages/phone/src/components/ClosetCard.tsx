// The Closet (Slice 6): save the whole look, swap between looks like
// outfits, rename, update, delete. Top of The Look. Wearing a look changes
// styling only; the house's furniture (clock spots, shortcuts, widgets,
// dock) never moves. See lib/closet.ts for exactly what a look carries.
import React, { useRef, useState } from "react";
import { Check, Pencil, RefreshCw, Share2, Trash2 } from "lucide-react";
import type { AppTheme } from "../types";
import { missingFonts, wearPatch, wornLook, type SavedLook } from "../lib/closet";
import { deleteLook, exportLook, importLook, prepareToWear, renameLook, saveLook, updateLook, useCloset } from "../lib/closet-store";
import { parseLookFile, type LookFile } from "../lib/look-file";
import { shareTextFile } from "../lib/share-file";
import { useUserFonts } from "../lib/font-store";
import { cn } from "../lib/utils";

type Colors = { panelBorder: string; textMain: string; textMuted: string; accentText: string };

interface Props {
  theme: AppTheme;
  onThemeChange: (patch: Partial<AppTheme>) => void;
  colors: Colors;
  accent: string;
  /** The operator: importing other people's looks is off by default. */
  allowImport: boolean;
  onAllowImport: (on: boolean) => void;
}

const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ClosetCard({ theme, onThemeChange, colors, accent, allowImport, onAllowImport }: Props) {
  const looks = useCloset();
  const fonts = useUserFonts();
  const worn = wornLook(theme, looks);
  const unsaved = !worn;

  const [naming, setNaming] = useState<null | { mode: "new" } | { mode: "rename"; id: string }>(null);
  const [name, setName] = useState("");
  const [pendingWear, setPendingWear] = useState<SavedLook | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [incoming, setIncoming] = useState<LookFile | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  // Slice 6b: share a look as a .bllook (font names only).
  const share = async (l: SavedLook) => {
    setBusy(true);
    setNote(null);
    try {
      const { fileName, text } = await exportLook(l);
      const res = await shareTextFile(fileName, text, "application/json", l.name);
      if (res === "downloaded") setNote({ text: `Saved "${fileName}" to your downloads. Send it to whoever you like.` });
      else if (res === "failed") setNote({ text: "Couldn't open the share sheet. Try again.", bad: true });
    } catch {
      setNote({ text: "Couldn't package that look. Try again.", bad: true });
    }
    setBusy(false);
  };

  // Slice 6b: import a look someone sent. Checked first, previewed, never worn automatically.
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setNote(null);
    setBusy(true);
    let text = "";
    try { text = await f.text(); } catch { /* handled below */ }
    setBusy(false);
    const parsed = parseLookFile(text);
    if (parsed.ok) setIncoming(parsed.file);
    else setNote({ text: "reason" in parsed ? parsed.reason : "That file can't be used.", bad: true });
  };

  const addIncoming = async () => {
    if (!incoming) return;
    setBusy(true);
    const res = await importLook(incoming);
    setBusy(false);
    setIncoming(null);
    if (res.ok) {
      const missing = missingFonts(res.look.look, fonts.map((x) => x.family));
      setNote({ text: `Added "${res.look.name}" to your closet. Tap it to wear it.${missing.length ? ` It uses ${missing.join(", ")}; upload ${missing.length > 1 ? "them" : "it"} in Type, or it shows Geist.` : ""}` });
    } else setNote({ text: "reason" in res ? res.reason : "Couldn't add it.", bad: true });
  };

  const pill = cn("rounded-full border px-3 py-1 text-[11px] font-semibold", colors.panelBorder, colors.textMain);
  const primary = "bytelight-on-accent rounded-full px-3 py-1 text-[11px] font-bold";

  const doSaveNew = async () => {
    setBusy(true);
    const res = await saveLook(theme, name);
    setBusy(false);
    setNaming(null);
    setName("");
    if (res.ok) setNote({ text: `Saved "${res.look.name}".` });
    else setNote({ text: "reason" in res ? res.reason : "Couldn't save.", bad: true });
    return res.ok;
  };

  const wear = async (look: SavedLook) => {
    setPendingWear(null);
    setBusy(true);
    const movingOk = await prepareToWear(look);
    const patch = wearPatch(look.look);
    if (!movingOk) patch.movingWallpaper = false;
    onThemeChange(patch);
    setBusy(false);
    const missing = missingFonts(look.look, fonts.map((f) => f.family));
    const bits = [`Wearing "${look.name}".`];
    if (!movingOk) bits.push("Its moving wallpaper couldn't be found on this device, so the still one shows.");
    if (missing.length) bits.push(`Missing font${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} (showing Geist instead). Upload ${missing.length > 1 ? "them" : "it"} in Type to bring ${missing.length > 1 ? "them" : "it"} back.`);
    setNote({ text: bits.join(" "), bad: !movingOk || missing.length > 0 });
  };

  const onTapLook = (look: SavedLook) => {
    if (worn?.id === look.id) return;
    setNote(null);
    if (unsaved) setPendingWear(look);
    else void wear(look);
  };

  return (
    <section className={cn("space-y-4 p-4 rounded-2xl border backdrop-blur-md bytelight-theme-panel", colors.panelBorder)}>
      <div className="space-y-1">
        <h3 className={cn("micro-label", colors.accentText)}>Closet</h3>
        <p className={cn("text-[11px]", colors.textMuted)}>
          Save the whole look and swap between looks like outfits. Your clock spots, shortcuts, widgets and dock stay put.
        </p>
      </div>

      {/* Her looks */}
      {looks.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {looks.map((l) => {
            const on = worn?.id === l.id;
            return (
              <div key={l.id} className="w-[92px] shrink-0 space-y-1.5">
                <button
                  type="button"
                  onClick={() => onTapLook(l)}
                  disabled={busy}
                  className={cn("relative block h-[140px] w-full overflow-hidden rounded-xl border-2 bg-cover bg-center", colors.panelBorder)}
                  style={{
                    backgroundImage: l.thumb ? `url("${l.thumb}")` : `linear-gradient(160deg, ${accent}, transparent)`,
                    borderColor: on ? accent : undefined,
                  }}
                  aria-label={on ? `${l.name}, wearing` : `Wear ${l.name}`}
                >
                  {on && (
                    <span className="bytelight-on-accent absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: accent }}>
                      <Check size={12} />
                    </span>
                  )}
                </button>
                <span className={cn("block truncate text-[11px] font-semibold", colors.textMain)}>{l.name}</span>
                <span className={cn("block text-[10px]", colors.textMuted)}>{on ? "Wearing" : size(l.bytes)}</span>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => { setNaming({ mode: "rename", id: l.id }); setName(l.name); setNote(null); }} className={colors.textMuted} aria-label={`Rename ${l.name}`}><Pencil size={13} /></button>
                  <button
                    type="button"
                    onClick={async () => { setBusy(true); const r = await updateLook(l.id, theme); setBusy(false); setNote(r.ok ? { text: `"${l.name}" now matches what you're wearing.` } : { text: "reason" in r ? r.reason : "Couldn't update.", bad: true }); }}
                    className={colors.textMuted}
                    aria-label={`Update ${l.name} to what you're wearing`}
                    disabled={busy || on}
                  ><RefreshCw size={13} /></button>
                  <button type="button" onClick={() => share(l)} className={colors.textMuted} aria-label={`Share ${l.name}`} disabled={busy}><Share2 size={13} /></button>
                  <button type="button" onClick={() => { setConfirmDelete(l.id); setNote(null); }} className={colors.textMuted} aria-label={`Delete ${l.name}`}><Trash2 size={13} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {looks.length === 0 && (
        <p className={cn("text-[11px]", colors.textMuted)}>Nothing in the closet yet. Save what you're wearing to start.</p>
      )}

      {/* Delete, confirmed */}
      {confirmDelete && (
        <div className={cn("space-y-2 rounded-xl border p-3", colors.panelBorder)}>
          <p className={cn("text-[12px]", colors.textMain)}>Delete "{looks.find((l) => l.id === confirmDelete)?.name}"? This can't be undone.</p>
          <div className="flex gap-2">
            <button type="button" className={primary} style={{ background: "#e05252" }} onClick={async () => { await deleteLook(confirmDelete); setConfirmDelete(null); }}>Delete</button>
            <button type="button" className={pill} onClick={() => setConfirmDelete(null)}>Keep it</button>
          </div>
        </div>
      )}

      {/* Switching with unsaved changes */}
      {pendingWear && (
        <div className={cn("space-y-2 rounded-xl border p-3", colors.panelBorder)}>
          <p className={cn("text-[12px]", colors.textMain)}>What you're wearing now isn't saved. Save it first?</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} style={{ background: accent }} onClick={() => { setNaming({ mode: "new" }); setName(""); }}>Save first</button>
            <button type="button" className={pill} onClick={() => wear(pendingWear)}>Switch anyway</button>
            <button type="button" className={pill} onClick={() => setPendingWear(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Name a new look, or rename one */}
      {naming && (
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (naming.mode === "rename") {
              await renameLook(naming.id, name);
              setNaming(null);
              setName("");
              return;
            }
            const ok = await doSaveNew();
            if (ok && pendingWear) void wear(pendingWear);
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={naming.mode === "new" ? "Name this look" : "New name"}
            maxLength={40}
            className={cn("bytelight-field min-w-0 flex-1 rounded-xl border px-3 py-2 text-[13px] outline-none", colors.panelBorder, colors.textMain)}
          />
          <button type="submit" disabled={busy} className={primary} style={{ background: accent }}>{naming.mode === "new" ? "Save" : "Rename"}</button>
          <button type="button" className={pill} onClick={() => { setNaming(null); setName(""); }}>Cancel</button>
        </form>
      )}

      {!naming && (
        <button
          type="button"
          onClick={() => { setNaming({ mode: "new" }); setName(""); setNote(null); }}
          disabled={busy}
          className="bytelight-on-accent w-full rounded-xl px-4 py-2.5 text-[12px] font-bold"
          style={{ background: accent }}
        >
          {unsaved ? "Save this look" : "Save a copy of this look"}
        </button>
      )}

      {/* Import preview: what's in the file before it goes in the closet. */}
      {incoming && (() => {
        const missing = missingFonts(incoming.look, fonts.map((x) => x.family));
        const pic = incoming.look.movingPoster || incoming.look.wallpaper || incoming.look.wallpapers?.[0] || incoming.look.glass?.texture;
        const parts = [
          incoming.moving ? "a moving wallpaper" : incoming.look.wallpaper || incoming.look.wallpapers?.length ? "a wallpaper" : null,
          incoming.look.glass?.texture ? "a glass texture" : null,
          incoming.fonts.length ? `fonts: ${incoming.fonts.join(", ")}` : null,
        ].filter(Boolean);
        return (
          <div className={cn("flex gap-3 rounded-xl border p-3", colors.panelBorder)}>
            <span className={cn("block h-24 w-16 shrink-0 rounded-lg border bg-cover bg-center", colors.panelBorder)} style={{ backgroundImage: pic ? `url("${pic}")` : `linear-gradient(160deg, ${accent}, transparent)` }} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className={cn("truncate text-[13px] font-semibold", colors.textMain)}>{incoming.name}</p>
              <p className={cn("text-[11px]", colors.textMuted)}>{parts.length ? `Includes ${parts.join(" · ")}.` : "Colours and glass."}</p>
              {missing.length > 0 && <p className="text-[11px] text-amber-300">You don't have {missing.join(", ")}. It'll show Geist until you upload {missing.length > 1 ? "them" : "it"}.</p>}
              <div className="flex gap-2 pt-1">
                <button type="button" className={primary} style={{ background: accent }} onClick={addIncoming} disabled={busy}>Add to closet</button>
                <button type="button" className={pill} onClick={() => setIncoming(null)}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Importing other people's looks: off unless she turns it on. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className={cn("block text-[12px] font-semibold", colors.textMain)}>Allow importing looks</span>
          <span className={cn("block text-[11px]", colors.textMuted)}>Off keeps your house to looks you made. Sharing yours always works.</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowImport}
          aria-label="Allow importing looks"
          onClick={() => { onAllowImport(!allowImport); if (allowImport) setIncoming(null); }}
          className={cn("relative h-[22px] w-10 shrink-0 rounded-full border transition-colors", colors.panelBorder)}
          style={{ background: allowImport ? accent : "transparent" }}
        >
          <span className="absolute top-[2px] h-4 w-4 rounded-full bg-white transition-all" style={{ left: allowImport ? 20 : 2 }} />
        </button>
      </div>
      {allowImport && (
        <>
          <input ref={importRef} type="file" accept=".bllook,application/json,.json" className="hidden" onChange={onImportFile} />
          <button type="button" onClick={() => importRef.current?.click()} disabled={busy} className={cn("w-full rounded-xl border px-4 py-2 text-[12px] font-semibold", colors.panelBorder, colors.textMain)}>
            Import a look
          </button>
        </>
      )}

      {note && <p className={cn("text-[11px]", note.bad ? "text-amber-300" : colors.textMuted)}>{note.text}</p>}
    </section>
  );
}
