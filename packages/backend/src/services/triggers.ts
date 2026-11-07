// triggers.ts — Pure condition evaluator for impulse queue + event triggers

import type { TriggerCondition } from './db.js';

export interface TriggerContext {
  presenceNow: 'active' | 'idle' | 'offline';
  presencePrev: 'active' | 'idle' | 'offline';
  agentFree: boolean;
  statusText: string;
  hour: number;
  minute: number;
  /** Now, in ms — for `after`. Absent reads as never reached. */
  nowMs?: number;
  /** Her status is Busy or Away right now — for `status_clears`. */
  ownerAway?: boolean;
}

export function evaluateConditions(conditions: TriggerCondition[], context: TriggerContext): boolean {
  if (conditions.length === 0) return true;
  return conditions.every(c => evaluateSingle(c, context));
}

function evaluateSingle(condition: TriggerCondition, ctx: TriggerContext): boolean {
  switch (condition.type) {
    case 'presence_state':
      return ctx.presenceNow === condition.state;
    case 'presence_transition':
      return ctx.presencePrev === condition.from && ctx.presenceNow === condition.to;
    case 'agent_free':
      return ctx.agentFree;
    case 'time_window':
      return evaluateTimeWindow(condition.after, condition.before, ctx.hour, ctx.minute);
    case 'routine_missing':
      return evaluateRoutineMissing(condition.routine, condition.after_hour, ctx.statusText, ctx.hour);
    case 'after': {
      const at = Date.parse(condition.at);
      return Number.isFinite(at) && ctx.nowMs !== undefined && ctx.nowMs >= at;
    }
    case 'status_clears':
      return condition.armed === true && ctx.ownerAway === false;
    default:
      return false;
  }
}

function evaluateTimeWindow(after: string, before: string | undefined, hour: number, minute: number): boolean {
  const nowMinutes = hour * 60 + minute;
  const afterMinutes = parseTimeString(after);
  if (afterMinutes === null) return false;
  if (!before) return nowMinutes >= afterMinutes;
  const beforeMinutes = parseTimeString(before);
  if (beforeMinutes === null) return false;
  if (afterMinutes <= beforeMinutes) return nowMinutes >= afterMinutes && nowMinutes < beforeMinutes;
  return nowMinutes >= afterMinutes || nowMinutes < beforeMinutes;
}

function parseTimeString(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function evaluateRoutineMissing(routine: string, afterHour: number, statusText: string, currentHour: number): boolean {
  if (currentHour < afterHour) return false;
  if (!statusText) return false;
  const pattern = new RegExp(`${routine}\\s*:\\s*no`, 'i');
  return pattern.test(statusText);
}
