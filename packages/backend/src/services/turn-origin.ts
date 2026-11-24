/** Trusted process options only. Enriched prompt text and tool arguments are deliberately absent. */
import { randomUUID } from 'node:crypto';
import type { BeltContext } from './chat-tool-belt.js';
export type TurnOrigin = Pick<BeltContext, 'turnId' | 'rawOwnerMessageText' | 'ownerMessageId' | 'replyToMessageId' | 'audience' | 'isAutonomous'>;
export function trustedTurnOrigin(opts: TurnOrigin | undefined): TurnOrigin {
  return {
    turnId: opts?.turnId ?? randomUUID(), rawOwnerMessageText: opts?.rawOwnerMessageText,
    ownerMessageId: opts?.ownerMessageId, replyToMessageId: opts?.replyToMessageId,
    audience: opts?.audience, isAutonomous: opts?.isAutonomous,
  };
}
export function beltTurnOrigin(opts: TurnOrigin | undefined, threadId: string, proposalMessageId: string, isAutonomous: boolean): BeltContext {
  return { ...trustedTurnOrigin(opts), threadId, proposalMessageId, isAutonomous, audience: opts?.audience ?? { kind: 'owner' } };
}
