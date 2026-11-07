// Barrel export — all database functions from domain modules

// Core state
export { initDb, getDb } from './init.js';

// Domain modules
export * from './config.js';
export * from './threads.js';
export * from './messages.js';
export * from './reactions.js';
export * from './embeddings.js';
export * from './sessions.js';
export * from './web-sessions.js';
export * from './push.js';
export * from './canvases.js';
export * from './timers.js';
export * from './triggers.js';
export * from './usage.js';
export * from './mcp-servers.js';
export * from './tts.js';
export * from './journal.js';
export * from './letters.js';
export * from './self-knowledge.js';

// Domain modules only main has
export * from './provider-sessions.js';
export * from './routing.js';
export * from './starred.js';
export * from './companion-settings.js';
export * from './rooms.js';

// The Fleet Room and the Card Room (ported from Aerie): Battleship, the table,
// Klondike and Egyptian Rat Screw ride the barrel as they do in Aerie; the
// other card games are imported directly.
export * from './battleship.js';
export * from './emojis.js';
export * from './cards.js';
export * from './solitaire.js';
export * from './rat-screw.js';
