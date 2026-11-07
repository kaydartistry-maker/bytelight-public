// Telegram utility functions
import { splitMessage } from '../split-message.js';

/**
 * Split a response into Telegram-safe chunks (max 4096 chars).
 * Breaks at paragraph boundaries first, then line breaks, then spaces.
 */
export function splitResponse(text: string, maxLength = 4096): string[] {
  return splitMessage(text, maxLength, 0.3);
}
