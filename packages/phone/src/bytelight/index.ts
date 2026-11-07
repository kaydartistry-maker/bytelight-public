// Public surface of the Bytelight integration layer.

export type {
  Message as BytelightMessage,
  Thread,
  ThreadSummary,
  PresenceStatus,
  Canvas,
  MessageSegment,
  SystemStatus,
  McpServerInfo,
  CommandRegistryEntry,
  ClientMessage,
  ServerMessage,
  Reaction,
} from './protocol';

export type { BytelightState, ConnectionState, ToolEvent, ThinkingEvent, ContextUsage, AuthState } from './store';
export { getState, setState, useBytelight } from './store';

export {
  useConnectionState,
  useAuth,
  useMessages,
  useThreads,
  useActiveThreadId,
  usePresence,
  useUnreadCounts,
  useLastError,
  useContextUsage,
  useCompactionNotice,
  useRateLimitInfo,
  useLoadingThread,
  useCommandRegistry,
  useSystemStatus,
  useIsStreaming,
  useStreaming,
  useStreamingSegments,
  useTotalUnread,
  buildStreamingSegments,
  useMemoryBlockVersion,
  useSelfKnowledgeVersion,
  useJournalVersion,
  useRoutingThreadId,
  useLimitWarning,
  useStarredBy,
  useProfiles,
} from './hooks';

export {
  connect,
  disconnect,
  proveAliveOrReconnect,
  send,
  loadThread,
  loadThreadAround,
  loadThreads,
  loadOlderMessages,
  switchThread,
  createThread,
  dropArchivedThread,
  setRoutingThreadId,
  pinThread,
  unpinThread,
  sendUserMessage,
  sendUserMessageToThread,
  deleteMessage,
  editMessage,
  regenerateMessage,
  RerollChangedError,
  addReaction,
  removeReaction,
  stopGeneration,
  sendCommand,
  mcpToggle,
  mcpReconnect,
  markRead,
  requestStatus,
} from './socket';

export { toPhoneMessage, streamingToPhoneMessage, reactionsToEmojiList } from './adapter';
export { api, apiFetch, checkAuth, login, logout, stopAuthPolling } from './api';
export {
  listEmojis,
  uploadEmoji,
  renameEmoji,
  deleteEmojiApi,
  syncEmojis,
  toCustomEmoji,
  listEmojiPacks,
} from './emojis';
export type { BackendEmoji } from './emojis';
export { loadStickers, getStickerPacks, resolveStickerRef } from './stickers';
export type { BackendSticker, BackendStickerPack } from './stickers';
export { BytelightProvider } from './BytelightProvider';
export { BytelightLoginGate } from './BytelightLoginGate';
export {
  startVoiceRecording,
  stopVoiceRecording,
  cancelVoiceRecording,
  clearTranscription,
  isRecordingSupported,
  isVoiceRecording,
} from './voice-recorder';
export type { VoiceRecordingMode, VoiceRecordingOptions } from './voice-recorder';
export {
  unlockVoicePlayback,
  stopVoicePlayback,
  suspendVoicePlayback,
  requestMessageTts,
  requestMessageTtsStream,
  isMessageTtsStreamUnavailable,
  playVoiceUrl,
  playVoiceSequence,
} from './voice-playback';
export type {
  MessageTtsResponse,
  MessageTtsStreamResponse,
  MessageTtsStreamSegment,
} from './voice-playback';
export { fetchServerSettings, pushServerSettings } from './settings-sync';
export type { ServerSettingsBlob } from './settings-sync';

export { HUMAN_STAR_ACTOR, loadMyStars, toggleStar, unstar, listStarred, isStarredByMe } from './stars';
export type { StarredItem } from './stars';
export { loadProfiles, saveProfiles, getProfiles } from './profiles';
export type { ProfileEntry, Profiles } from './profiles';
