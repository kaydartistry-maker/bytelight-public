// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Split a message into plain runs and "-# whisper" lines, for the places that
 * draw text themselves instead of through the chat's markdown renderer. Chat
 * turns a line that starts with "-# " into small muted text (MessageBubble and
 * MessageSegments rewrite it to an h6); the Treehouse page printed the marker
 * as it was. One marker is consumed, the same as chat, so "-# -# x" keeps one.
 */
export interface TextRun {
  whisper: boolean;
  text: string;
}

const WHISPER = /^-# +(.*)$/;

export function splitWhispers(text: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(WHISPER);
    if (m) {
      runs.push({ whisper: true, text: m[1] });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && !last.whisper) last.text += `\n${line}`;
    else runs.push({ whisper: false, text: line });
  }
  return runs;
}
