// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
/**
 * The one way a spontaneous wake delivers its picture, shared by the wake
 * outcome contract (appended at fire time) and the Codex operating contract,
 * so the two can never hand a companion contradicting instructions.
 *
 * `sc.mjs image` renders through the in-house Studio and posts the finished
 * picture into the thread itself. The bare Studio route only fills the
 * gallery and would leave the image undelivered.
 */
export const SPONTANEOUS_SELFIE_COMMAND =
  'node tools/sc.mjs image "<prompt>" --subjects <slug,slug> --size portrait|landscape';
