// Which stored files does the house still point at? A file is in use if its id
// appears anywhere in a live message (metadata or text), a voice-note row, or a
// setting such as a profile avatar. Matching the id as text, instead of reading
// one known field, keeps new places that carry files (attachments lists,
// embedded urls) from silently turning in-use files into "orphans".
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function referencedFileIds(
  texts: Iterable<string | null | undefined>,
  knownFileIds: ReadonlySet<string>,
): Set<string> {
  const used = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(UUID)) {
      const id = match[0].toLowerCase();
      if (knownFileIds.has(id)) used.add(id);
    }
  }
  return used;
}
