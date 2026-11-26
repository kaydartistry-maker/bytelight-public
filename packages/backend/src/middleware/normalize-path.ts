// Collapse duplicate slashes in a request URL's PATH, leaving the query alone.
//
// Express prefix-mounted middleware matches on exact path segments, so an
// address like '/api//cortex/...' slips past a gate mounted at '/api/cortex'
// while still reaching a router mounted at the broad '/api'. Normalizing the
// path before routing shuts that whole class. The query string is untouched so
// a parameter that legitimately contains '//' (a URL) survives intact.

export function collapseDuplicateSlashes(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  if (!path.includes('//')) return url;
  const rest = q === -1 ? '' : url.slice(q);
  return path.replace(/\/{2,}/g, '/') + rest;
}
