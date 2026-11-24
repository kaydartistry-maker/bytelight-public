/** Owner-only Letta control plane wire contracts. */
export interface SkillInventory {
  skills: { id: string; name: string; description: string }[];
  revision: string;
  fetchedAt: string;
  stale: boolean;
}
export type WakeSchedule =
  | { type: 'one-time'; scheduled_at: number }
  | { type: 'recurring'; cron_expression: string };
export interface Wake {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: WakeSchedule;
  nextRun: string | null;
  conversation: string | null;
  target: string;
  createdAt: string | null;
}
export interface WakeInventory { wakes: Wake[]; hasMore: boolean }
export interface CreateWakeInput {
  name: string;
  description: string;
  prompt: string;
  schedule: WakeSchedule;
}
