/** Search friendly labels and provider IDs without mutating discovery/default order. */
const order = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function filterModelCatalog<T>(items: readonly T[], search: string, label: (item: T) => string, id: (item: T) => string): T[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(item => `${label(item)} ${id(item)}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => order.compare(label(a), label(b)) || order.compare(id(a), id(b)));
}
