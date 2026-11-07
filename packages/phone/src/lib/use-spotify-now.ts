// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// What is playing, kept by lib/spotify.ts createSpotifyNow, as a screen sees
// it: the Spotify app and the lock screen's card each make one keeper and draw
// from its state, kept current.
import { useSyncExternalStore } from 'react';
import type { SpotifyNowKeeper, SpotifyNowState } from './spotify';

export function useSpotifyNow(keeper: SpotifyNowKeeper): SpotifyNowState {
  return useSyncExternalStore(keeper.subscribe, keeper.state, keeper.state);
}
