// The house nameplate: a small glass pill with her logo and/or name.
import React from "react";
import type { Nameplate as Plate } from "../lib/nameplate";
import { cn } from "../lib/utils";

export function Nameplate({ plate, className }: { plate: Plate; className?: string }) {
  return (
    <div className={cn("bytelight-glass-chip inline-flex max-w-full items-center gap-2 rounded-full border py-1 pl-1", plate.name ? "pr-4" : "pr-1", className)}>
      {plate.logo && <img src={plate.logo} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />}
      {plate.name && (
        <span className="truncate text-[14px] font-semibold" style={{ fontFamily: "var(--font-heading, inherit)" }}>
          {plate.name}
        </span>
      )}
    </div>
  );
}
