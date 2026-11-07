// Grouping for the Keys screen, kept identical to the classic Keys panel:
// the backend registry (services/secrets.ts) tags every slot with one of
// these categories, and only the four non-provider buckets render here.
// `providers` slots and any read-only slot are skipped — model provider
// keys live on the Providers screen.

export type SecretCategory = 'search' | 'voice' | 'platforms' | 'other' | 'providers';

export interface SecretStatus {
  name: string;
  label: string;
  category: SecretCategory;
  hint?: string;
  hasValue: boolean;
  readonly?: boolean;
}

export const SECRET_CATEGORY_ORDER = ['search', 'voice', 'platforms', 'other'] as const;
export type ShownSecretCategory = (typeof SECRET_CATEGORY_ORDER)[number];

export const SECRET_CATEGORY_LABEL: Record<ShownSecretCategory, string> = {
  search: 'Search',
  voice: 'Voice',
  platforms: 'Platforms',
  other: 'Other',
};

export interface SecretGroup {
  category: ShownSecretCategory;
  label: string;
  items: SecretStatus[];
}

export function groupSecrets(secrets: readonly SecretStatus[]): SecretGroup[] {
  return SECRET_CATEGORY_ORDER
    .map((category) => ({
      category,
      label: SECRET_CATEGORY_LABEL[category],
      items: secrets.filter((s) => s.category === category && !s.readonly),
    }))
    .filter((group) => group.items.length > 0);
}
