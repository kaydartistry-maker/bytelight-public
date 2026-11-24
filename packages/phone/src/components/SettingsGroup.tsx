// A collapsible group on the Settings > Appearance tab (Slice 2b). The operator:
// "a little collapsible button for the groups so I can choose one and open it
// up, because it IS a lot of data." The header is a full-width glass bar;
// open/closed is remembered per group on this device.
import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

const KEY = "bytelight-settings-groups";

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return typeof saved[id] === "boolean" ? saved[id] : fallback;
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, open: boolean) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    localStorage.setItem(KEY, JSON.stringify({ ...saved, [id]: open }));
  } catch {
    /* storage blocked: the group still opens and closes, it just won't remember */
  }
}

interface Props {
  id: string;
  title: string;
  summary: string;
  defaultOpen?: boolean;
  colors: { panelBorder: string; textMain: string; textMuted: string; accentText: string };
  children: React.ReactNode;
}

export function SettingsGroup({ id, title, summary, defaultOpen = false, colors, children }: Props) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const toggle = () => {
    setOpen((o) => {
      writeOpen(id, !o);
      return !o;
    });
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`settings-group-${id}`}
        className={cn("bytelight-theme-panel flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left", colors.panelBorder)}
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[13px] font-bold uppercase tracking-widest", colors.accentText)}>{title}</span>
          <span className={cn("block truncate text-[11px]", colors.textMuted)}>{summary}</span>
        </span>
        <ChevronDown size={18} className={cn("shrink-0 transition-transform duration-200", colors.textMain, open && "rotate-180")} />
      </button>
      {open && (
        <div id={`settings-group-${id}`} className="space-y-8">
          {children}
        </div>
      )}
    </div>
  );
}
