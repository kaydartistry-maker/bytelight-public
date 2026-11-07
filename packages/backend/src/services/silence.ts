// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The silence sentinel, in one dependency-free place so the agent and the
// Discord gateway can both read it without importing each other.

/**
 * A turn whose whole answer is exactly [SILENT] chose to say nothing. One
 * contract offers it as a choice, the Discord beat (services/discord/judge.ts),
 * where a message said to the room may be passed on. Whatever lane emits it,
 * nothing is posted: no bubble, no push, no Discord message, and the sentinel
 * never leaks as text. (Aerie.)
 */
export function isDeliberateSilence(text: string | null | undefined): boolean {
  return (text ?? '').trim() === '[SILENT]';
}
