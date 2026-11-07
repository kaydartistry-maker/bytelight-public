// Command Center lists: the Shopping list is permanent. Classic hides its
// "Delete list" button by exact name, and the phone follows the same rule.
export function canDeleteList(name: unknown): boolean {
  return name !== 'Shopping';
}
