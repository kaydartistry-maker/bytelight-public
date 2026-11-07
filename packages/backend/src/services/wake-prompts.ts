// Wake prompt file helpers — section-level parsing and editing for the
// orchestrator's prompts/wake.md overrides.
//
// The effective prompt for a wake is: defaults from getDefaultWakePrompts()
// overridden key-by-key by `## <section>` blocks in the wake prompts file.
// These helpers keep that file editable per-section, so the Wakes tab can
// edit or reset one wake's prompt without disturbing the rest of the file.
//
// Ported from the Keystone fork's wake-prompts service; the outcome-log
// parser from that source is intentionally not carried here yet — it depends
// on this tree's orchestrator.log format, which is verified separately.

export interface WakeFileSection {
  key: string;
  body: string;
}

export interface ParsedWakeFile {
  preamble: string;
  sections: WakeFileSection[];
}

const SECTION_RE = /^##\s+(\w+)/;

/** Parse a wake prompts file into its preamble and ordered `## key` sections. */
export function parseWakeSections(raw: string): ParsedWakeFile {
  const preambleLines: string[] = [];
  const sections: WakeFileSection[] = [];
  let current: { key: string; lines: string[] } | null = null;

  for (const line of raw.split('\n')) {
    const match = line.match(SECTION_RE);
    if (match) {
      if (current) sections.push({ key: current.key, body: current.lines.join('\n').trim() });
      current = { key: match[1].toLowerCase(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push({ key: current.key, body: current.lines.join('\n').trim() });

  return { preamble: preambleLines.join('\n').trimEnd(), sections };
}

/** Serialize a parsed wake file back to markdown. */
export function serializeWakeSections(parsed: ParsedWakeFile): string {
  const parts: string[] = [];
  if (parsed.preamble.trim()) parts.push(parsed.preamble.trimEnd());
  for (const section of parsed.sections) {
    parts.push(`## ${section.key}\n\n${section.body.trim()}`);
  }
  return parts.join('\n\n') + '\n';
}

/** Replace or append one section's body, preserving everything else. */
export function upsertWakeSection(raw: string, key: string, body: string): string {
  const parsed = parseWakeSections(raw);
  const normalized = key.toLowerCase();
  const existing = parsed.sections.find((s) => s.key === normalized);
  if (existing) {
    existing.body = body.trim();
  } else {
    parsed.sections.push({ key: normalized, body: body.trim() });
  }
  return serializeWakeSections(parsed);
}

/** Remove one section entirely — the orchestrator default applies again. */
export function removeWakeSection(raw: string, key: string): string {
  const parsed = parseWakeSections(raw);
  const normalized = key.toLowerCase();
  parsed.sections = parsed.sections.filter((s) => s.key !== normalized);
  return serializeWakeSections(parsed);
}
