import type Database from 'better-sqlite3';
import { recentCompanionChat, runNativeDraft } from './boss-companion.js';
import { QuestError, validDraft, type QuestDraft } from './life-quests.js';

export function questDraftPrompt(dump: string) {
  return `Turn this brain dump into separate Daily Quests. Return only JSON: {"quests":[{"title":"short playful Virelle fantasy title","task":"plain concrete action","category":"artistry|vitality|dominion|lore|revelry|veil|bonds","xp":5|10|20|30}]}. Use one primary category per quest. XP measures resistance: 5 easy, 10 some effort, 20 hard/avoided, 30 major. Preserve every actual task, but do not invent obligations. Split only genuinely compound tasks. Maximum 12 quests. No shame, advice, commentary, markdown, or reward text. Brain dump: ${JSON.stringify(dump)}`;
}
export async function draftLifeQuests(db: Database.Database, raw: unknown): Promise<QuestDraft[]> {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4000) throw new QuestError('Enter a brain dump up to 4,000 characters.');
  const source = recentCompanionChat(db);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const text = await runNativeDraft(source, questDraftPrompt(raw.trim()), controller.signal);
    const json = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!Array.isArray(json?.quests) || json.quests.length < 1 || json.quests.length > 12) throw new Error();
    return json.quests.map(validDraft);
  } catch (error) {
    if (error instanceof QuestError) throw error;
    throw new QuestError('The Quest Forge could not separate that dump with the selected chat model. Nothing was added.', 502);
  } finally { clearTimeout(timer); controller.abort(); }
}
