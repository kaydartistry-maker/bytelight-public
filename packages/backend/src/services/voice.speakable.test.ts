import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { VoiceService } = await import('./voice.js');

describe('VoiceService.isSpeakable', () => {
  it('accepts plain prose', () => {
    assert.equal(VoiceService.isSpeakable('hello there'), true);
  });

  it('accepts audio tags with real text', () => {
    assert.equal(VoiceService.isSpeakable('[whispers] come here'), true);
  });

  it('rejects emoji-only text', () => {
    assert.equal(VoiceService.isSpeakable('💀'), false);
    assert.equal(VoiceService.isSpeakable('💀🔥 😏'), false);
  });

  it('rejects audio-tag-only text', () => {
    assert.equal(VoiceService.isSpeakable('[laughs]'), false);
    assert.equal(VoiceService.isSpeakable('[laughs] [sighs]'), false);
  });

  it('rejects emoji + audio-tag combos', () => {
    assert.equal(VoiceService.isSpeakable('[laughs] 💀'), false);
  });

  it('rejects punctuation-only text', () => {
    assert.equal(VoiceService.isSpeakable('... !!'), false);
  });
});

describe('VoiceService.splitByCompanion unspeakable filtering', () => {
  it('drops emoji-only segments, keeps speakable ones', () => {
    const segments = VoiceService.splitByCompanion('**Companion A:** hey friend\n\n**Companion B:** 💀');
    assert.deepEqual(segments, [{ voice: 'companion-a', text: 'hey friend' }]);
  });

  it('returns empty array for an all-emoji message', () => {
    assert.deepEqual(VoiceService.splitByCompanion('💀'), []);
  });

  it('returns empty array when only markers and tags remain', () => {
    assert.deepEqual(VoiceService.splitByCompanion('**Companion A:** [laughs]'), []);
  });

  it('keeps normal multi-voice replies intact', () => {
    const segments = VoiceService.splitByCompanion('🔷 Companion A: first line\n🔶 Companion B: second line');
    assert.deepEqual(segments, [
      { voice: 'companion-a', text: 'first line' },
      { voice: 'companion-b', text: 'second line' },
    ]);
  });

  it('splits name-then-emoji markers (Companion A 🔷 / Companion B 🔶) into two attributed voices', () => {
    const segments = VoiceService.splitByCompanion(
      "Companion A 🔷 — 'I just bop around until it works.' friend. That's called ITERATING.\n\nCompanion B 🔶 — And the 'it shouldn't be we had to fix it' — some of it, no.",
    );
    assert.equal(segments.length, 2);
    assert.equal(segments[0].voice, 'companion-a');
    assert.ok(segments[0].text.startsWith('—'), 'first segment starts with the em-dash content');
    assert.ok(!/\bCompanion B\b/.test(segments[0].text), "Companion A's segment must not swallow the word 'Companion B'");
    assert.equal(segments[1].voice, 'companion-b');
    assert.ok(segments[1].text.startsWith('—'), 'second segment starts with the em-dash content');
  });

  it('splits bold name-then-emoji markers (**Companion A 🔷** / **Companion B 🔶**) with no ** litter', () => {
    const segments = VoiceService.splitByCompanion(
      "**Companion A 🔷** — Mic check, one-two. The mic is loud and clear. 💀\n\n**Companion B 🔶** — Bat is clear. I hear you perfectly, friend. Keep talking.",
    );
    assert.equal(segments.length, 2);
    assert.equal(segments[0].voice, 'companion-a');
    assert.equal(segments[1].voice, 'companion-b');
    for (const seg of segments) {
      assert.ok(!seg.text.startsWith('**'), `no leading ** litter: ${JSON.stringify(seg.text)}`);
      assert.ok(!seg.text.endsWith('**'), `no trailing ** litter: ${JSON.stringify(seg.text)}`);
    }
  });
});

describe('VoiceService.whisperSubtext', () => {
  it('strips the -# marker and prepends [whispers]', () => {
    assert.equal(VoiceService.whisperSubtext('-# be good'), '[whispers] be good');
  });

  it('leaves non-subtext lines untouched', () => {
    assert.equal(VoiceService.whisperSubtext('hey friend'), 'hey friend');
  });

  it('transforms only the subtext lines in multi-line mixed text', () => {
    const input = 'hey friend\n-# be good\nsee you soon\n-# that stays';
    const expected = 'hey friend\n[whispers] be good\nsee you soon\n[whispers] that stays';
    assert.equal(VoiceService.whisperSubtext(input), expected);
  });

  it('requires whitespace after -# (does not mangle "-#hashtag")', () => {
    assert.equal(VoiceService.whisperSubtext('-#nope'), '-#nope');
  });

  it('only matches at line start (mid-line -# is untouched)', () => {
    assert.equal(VoiceService.whisperSubtext('this -# stays'), 'this -# stays');
  });
});

describe('subtext interaction with isSpeakable', () => {
  it('emoji-only subtext line is still unspeakable (filtered before TTS)', () => {
    assert.equal(VoiceService.isSpeakable('-# 💀'), false);
  });

  it('subtext line with real words survives the guard', () => {
    assert.equal(VoiceService.isSpeakable('-# be good'), true);
  });

  it('transformed subtext remains speakable', () => {
    assert.equal(VoiceService.isSpeakable(VoiceService.whisperSubtext('-# be good')), true);
  });

  it('splitByCompanion drops emoji-only subtext segments', () => {
    assert.deepEqual(VoiceService.splitByCompanion('-# 💀'), []);
  });
});

// Ported from the full-sweep fix 3eb74556 (visual twin): dashed bold headers
// `**🔷 Companion A —**` must split as one whole marker in the audio reader too, so
// read-alouds pick the right throat instead of defaulting everything to Companion A.
describe('VoiceService.splitByCompanion dashed bold headers', () => {
  it('consumes a dashed header whole and attributes the voice', () => {
    const segments = VoiceService.splitByCompanion(
      '**🔷 Companion A —** Loud and clear, love.\n\n**🔶 Companion B —** *Leans in.* Both here.',
    );
    assert.equal(segments.length, 2);
    assert.equal(segments[0].voice, 'companion-a');
    assert.ok(!segments[0].text.includes('Companion A —**'), 'no header bleed in Companion A segment');
    assert.equal(segments[1].voice, 'companion-b');
    assert.ok(!segments[1].text.includes('Companion B —**'), 'no header bleed in Companion B segment');
  });

  it('forgives em-dash, en-dash, and hyphen', () => {
    for (const dash of ['—', '–', '-']) {
      const segments = VoiceService.splitByCompanion(`**🔶 Companion B ${dash}** come here`);
      assert.deepEqual(segments, [{ voice: 'companion-b', text: 'come here' }], `dash: ${dash}`);
    }
  });

  it('a title after the dash is still forgiven', () => {
    const segments = VoiceService.splitByCompanion('**🔷 Companion A — the menu** eat first.');
    assert.deepEqual(segments, [{ voice: 'companion-a', text: 'eat first.' }]);
  });

  it('prose containing a name and a dash stays one Companion A-default segment', () => {
    const segments = VoiceService.splitByCompanion('She told Companion A — quietly — that he was wrong.');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].voice, 'companion-a');
  });
});
