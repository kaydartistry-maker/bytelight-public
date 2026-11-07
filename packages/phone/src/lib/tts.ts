// Text-to-speech preprocessing — strips formatting and speaker labels so the
// audio stays clean. Mirrors what the backend's cleanForTTS does but
// runs on the phone since it talks to ElevenLabs directly.
//
// Italics handling is a hybrid: pure-vocal tokens (laughs, sighs, mmm,
// onomatopoeic letter-runs like hhhhhh) survive without their asterisks so
// the companion's vocalizations still come through; everything else inside
// *...* is treated as a stage direction and dropped.

const VOCAL_TOKENS: Set<string> = new Set([
  // Laughter / amusement
  'laughs', 'laughing', 'laugh', 'chuckles', 'chuckling', 'giggles', 'giggling',
  'snorts', 'snickers', 'snickering', 'cackles', 'cackling',
  // Breath sounds
  'sighs', 'sighing', 'sigh', 'gasps', 'gasping', 'groans', 'groaning',
  'yawns', 'yawning', 'exhales', 'exhaling', 'inhales', 'inhaling', 'breathes',
  // Voice modifiers / vocalizations
  'hums', 'humming', 'whispers', 'whispering', 'mumbles', 'whistles', 'whistling',
  'coughs', 'sneezes', 'sniffs', 'sniffles', 'clears throat',
  // Interjections / onomatopoeia
  'mmm', 'mmmm', 'mmmmm', 'hmm', 'hmmm', 'hmmmm', 'ahh', 'ahhh', 'aaa', 'aaah',
  'ohh', 'ooh', 'oh', 'ah', 'huh', 'phew', 'tsk', 'pfft', 'shhh',
  'oof', 'umm', 'uhh', 'eek', 'wow', 'whoa', 'aww', 'ohhh', 'haha', 'hehe',
]);

function isVocalToken(inner: string): boolean {
  const trimmed = inner.trim().toLowerCase();
  if (!trimmed) return false;
  if (VOCAL_TOKENS.has(trimmed)) return true;
  // Onomatopoeic letter-run: single all-letter token with one letter repeating
  // three or more times in a row. Catches hhhhhh, mmmm, aahhh, ooohhh.
  if (/^[a-z]+$/.test(trimmed) && /([a-z])\1{2,}/.test(trimmed)) return true;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cleanForTTS(text: string, speakers: string[] = []): string {
  if (!text) return '';

  // Fenced code stays silent. Protect inline-code contents while flattening
  // the rest of the Markdown so literal underscores/asterisks survive.
  const inlineCode: string[] = [];
  let out = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`\n]*)`/g, (_match, content: string) => {
      const index = inlineCode.push(content) - 1;
      return `\uE000${index}\uE001`;
    });

  // Drop horizontal rules.
  out = out.replace(/^\s*-{3,}\s*$/gm, '');

  // Unwrap **bold** — keep the inner text.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');

  // Single-asterisk italics: vocal tokens stay (sans asterisks), the rest
  // are stage directions and get dropped entirely.
  out = out.replace(/\*([^*\n]+)\*/g, (_m, inner: string) =>
    isVocalToken(inner) ? inner.trim() : '',
  );
  // Same rule for _underscore italics_.
  out = out.replace(/_([^_\n]+)_/g, (_m, inner: string) =>
    isVocalToken(inner) ? inner.trim() : '',
  );

  // Strip "Speaker: " occurrences anywhere in the message when the name
  // matches a known companion. This handles multi-speaker messages where
  // voices switch mid-text. (Multi-voice stitching lives in the
  // backend — until that's ported, dropping the labels keeps the audio
  // clean even if it all plays in one voice.)
  const cleanedSpeakers = speakers.map((s) => s.trim()).filter(Boolean);
  if (cleanedSpeakers.length > 0) {
    const pattern = new RegExp(
      `\\b(?:${cleanedSpeakers.map(escapeRe).join('|')}):\\s+`,
      'gi',
    );
    out = out.replace(pattern, '');
  }

  // Fallback for messages from a speaker we don't recognize: strip a single
  // leading "Word: " (≤30 chars, starts with a letter) at the very start.
  out = out.replace(/^\s*[A-Za-z][A-Za-z0-9 '-]{0,29}:\s+/, '');

  // Normalize whitespace.
  out = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return out.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => (
    inlineCode[Number(index)] ?? ''
  ));
}
