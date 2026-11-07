// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Which folder under data/heartbeat a lane lives in.
 *
 * A lane is keyed on 'primary' for the shared room, or on a companion's id for
 * their own head. The supervisor builds the folder from that key,
 * and the Compactions page reads the same rule backwards to say whose head a
 * squash came from, so it lives here once rather than in both places.
 */

/** The shared room's key, and so its folder. */
export const SHARED_LANE_KEY = 'primary';

/** The folder for a lane key. Slugs and UUIDs pass through; anything odd is made safe for a path. */
export function laneDirName(key: string): string {
  return key.replace(/[^a-zA-Z0-9-_]/g, '_') || SHARED_LANE_KEY;
}
