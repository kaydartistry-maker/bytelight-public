import { getDb } from './init.js';

// Per-message TTS cache — one rendered audio file per source message.
export interface MessageTts {
  message_id: string;
  file_id: string;
  voice_used: string | null;
  created_at: string;
}

export function getMessageTts(messageId: string): MessageTts | null {
  const stmt = getDb().prepare('SELECT * FROM message_tts WHERE message_id = ?');
  return (stmt.get(messageId) as MessageTts | undefined) || null;
}

export function setMessageTts(params: {
  messageId: string;
  fileId: string;
  voiceUsed?: string | null;
  createdAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_tts (message_id, file_id, voice_used, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.messageId, params.fileId, params.voiceUsed ?? null, params.createdAt);
}
