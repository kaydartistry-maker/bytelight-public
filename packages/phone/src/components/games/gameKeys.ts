// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { useEffect, useRef } from 'react';

/**
 * Keyboard equivalents for the arcade's pointer-only controls.
 *
 * Every game in here is played by tapping or dragging, which is right on a
 * phone and leaves anyone on a keyboard unable to play at all. These two
 * hooks give each game a second way in without changing how it looks or how
 * it plays under a finger.
 *
 * Held movement runs its own animation frame loop rather than leaning on the
 * browser's key-repeat, which pauses for half a second before it starts and
 * would make a paddle feel broken.
 */

/**
 * A game listens on the window, so it would otherwise swallow the Enter or
 * Space that was meant for whatever the player currently has focused — which
 * is exactly the keyboard user these controls exist for.
 */
function typingOrOnAControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('button, a, input, select, textarea, [contenteditable="true"]');
}

/** One-shot actions — jump, fire, start. Fires once per press, not per repeat. */
export function useKeyPress(active: boolean, keys: string[], onPress: () => void) {
  const handler = useRef(onPress);
  handler.current = onPress;

  useEffect(() => {
    if (!active) return;
    const watched = new Set(keys);
    const down = (e: KeyboardEvent) => {
      if (!watched.has(e.key) || e.repeat) return;
      if (typingOrOnAControl(e.target)) return;
      e.preventDefault();
      handler.current();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [active, keys.join('|')]);
}

/**
 * Continuous controls — steering a paddle, sweeping an aim. `onFrame` is
 * called once per animation frame with the keys currently held down, and is
 * expected to nudge game state the way a pointer move would.
 */
export function useHeldKeys(
  active: boolean,
  keys: string[],
  onFrame: (held: ReadonlySet<string>) => void,
) {
  const frame = useRef(onFrame);
  frame.current = onFrame;

  useEffect(() => {
    if (!active) return;
    const watched = new Set(keys);
    const held = new Set<string>();
    let raf = 0;

    const down = (e: KeyboardEvent) => {
      if (!watched.has(e.key)) return;
      if (typingOrOnAControl(e.target)) return;
      e.preventDefault();
      held.add(e.key);
    };
    const up = (e: KeyboardEvent) => {
      if (!watched.has(e.key)) return;
      held.delete(e.key);
    };
    // A key held while the tab loses focus never reports its keyup, which
    // would leave a paddle sliding into the wall on return.
    const clear = () => held.clear();

    // Called every frame, held or not, so a game can also act on a key being
    // RELEASED — holding a key to keep firing needs somewhere to stop.
    const tick = () => {
      frame.current(held);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, [active, keys.join('|')]);
}
