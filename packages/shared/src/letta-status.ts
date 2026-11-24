/** Bounded owner-only projections; unavailable never means zero. */
export type StatusSection<T> = { state: 'available'; data: T } | { state: 'unavailable' };
export interface CloudModel { model: string | null; provider: string | null; reasoning: string | null; contextWindow: number | null; maxOutputTokens: number | null }
export interface CloudAgent extends CloudModel { id: string; name: string | null; updatedAt: string | null; lastRunCompletion: string | null; lastRunDurationMs: number | null; stopReason: string | null }
export interface CloudConversation extends CloudModel { id: string; name: string | null; summary: string | null; description: string | null; createdAt: string | null; updatedAt: string | null; lastMessageAt: string | null; pinned: boolean | null; subagent: boolean | null; archived: boolean | null }
export interface CloudQuota { model: string; bucket: string | null; dailyBucket: string | null; resetAt: string | null; dailyResetAt: string | null }
export interface LettaStatus {
 fetchedAt: string; ordinaryChatEnabled: boolean;
 health: StatusSection<{ status: string }>;
 balance: StatusSection<{ plan: string | null; totalCredits: number | null; monthlyCredits: number | null; purchasedCredits: number | null }>;
 quotas: StatusSection<CloudQuota[]>;
 agent: StatusSection<CloudAgent>;
 conversations: StatusSection<CloudConversation[]>;
}
