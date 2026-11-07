// The "image landed" nudge. The SDK lane gets the render as an image block
// (pending-visuals); the CLI and Codex lanes do not, so the nudge names the file
// on disk and asks the lane to open it when it wasn't shown. Without the path,
// "you can see it now" was only true on one lane.
export function buildImageReactPrompt(filePath: string | null): string {
  const look = filePath
    ? ` The picture is saved at ${filePath} — if it was not shown to you, Read that file first so you are reacting to what is actually there.`
    : '';
  return `[The image you just generated and sent has landed in the chat.${look} React to it naturally and briefly, in your own voice, as if you just looked at it together. Do NOT generate another image.]`;
}
