<script lang="ts">
  import type { Message, CommandRegistryEntry, Sticker } from '@bytelight/shared';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import VoiceModeToggle from './VoiceModeToggle.svelte';
  import GifPicker from './GifPicker.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import StickerPicker from './StickerPicker.svelte';
  import { getCompanionName } from '$lib/stores/settings.svelte';
  import { getStickerPacks } from '$lib/stores/stickers.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { getCommandRegistry, sendCommand } from '$lib/stores/websocket.svelte';
  import { apiFetch } from '../utils/api.js';

  let companionName = $derived(getCompanionName());

  interface FileUploadResult {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentType: 'image' | 'audio' | 'file';
    url: string;
  }

  let {
    replyTo = null,
    isStreaming = false,
    activeThreadId = null,
    onbatchsend,
    oncancelreply,
    onstop,
    oncall,
  } = $props<{
    replyTo?: Message | null;
    isStreaming?: boolean;
    activeThreadId?: string | null;
    onbatchsend?: (text: string, files: FileUploadResult[], prosody?: Record<string, number>) => void;
    oncancelreply?: () => void;
    onstop?: () => void;
    oncall?: () => void;
  }>();

  let textarea: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;
  let content = $state('');
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);
  let pendingAttachments = $state<FileUploadResult[]>([]);
  let pendingCanvasRefs = $state<Array<{ canvasId: string; title: string }>>([]);
  let pendingProsody = $state<Record<string, number> | null>(null);

  // Command palette state
  let showCommandPalette = $state(false);
  let commandFilter = $state('');
  let paletteRef = $state<CommandPalette>();
  let commandRegistry = $derived(getCommandRegistry());

  // Can send if there's text or pending attachments
  let canSend = $derived(content.trim().length > 0 || pendingAttachments.length > 0 || pendingCanvasRefs.length > 0);

  // Sticker picker state
  let stickerPickerOpen = $state(false);
  let stickerPacks = $derived(getStickerPacks());

  // Confirm before stopping a response — the Stop button is easy to hit by
  // accident, and a stray click kills a reply the operator wanted. If the reply
  // finishes on its own while the prompt is open, dismiss it (nothing left
  // to stop). Ported from reference implementation (reference implementation).
  let showStopConfirm = $state(false);
  $effect(() => { if (!isStreaming) showStopConfirm = false; });

  // Composer reveals its full toolbar only when there's something going on —
  // pending content, attachments, or an open picker. Focus also expands it (CSS :focus-within).
  let composerExpanded = $derived(
    content.trim().length > 0 ||
    pendingAttachments.length > 0 ||
    pendingCanvasRefs.length > 0 ||
    stickerPickerOpen
  );

  function handleStickerSelect(sticker: Sticker) {
    const packName = stickerPacks.find(p => p.id === sticker.pack_id)?.name || '';
    const ref = `:${packName}_${sticker.name}:`;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const insert = (start > 0 && content[start - 1] && content[start - 1] !== ' ') ? ' ' + ref : ref;
      content = content.slice(0, start) + insert + content.slice(end);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        textarea.focus();
      }, 0);
    } else {
      content = (content ? content + ' ' : '') + ref;
    }
    stickerPickerOpen = false;
  }

  // Large paste threshold — text over this size becomes a .txt attachment
  const LARGE_PASTE_THRESHOLD = 64 * 1024; // 64KB

  // Convert large text to a .txt file and upload it
  async function convertLargeTextToFile(text: string, prefix: string = 'pasted-text'): Promise<boolean> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${prefix}-${timestamp}.txt`;
    const blob = new Blob([text], { type: 'text/plain' });
    const file = new File([blob], filename, { type: 'text/plain' });
    return await uploadFile(file);
  }

  // Auto-resize textarea
  function autoResize() {
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }

  // Detect slash commands on input
  function handleInput() {
    autoResize();
    // Show command palette when content starts with / and is a single line
    if (content.startsWith('/') && !content.includes('\n')) {
      showCommandPalette = true;
      commandFilter = content.slice(1).split(' ')[0]; // filter on command name only
    } else {
      showCommandPalette = false;
      commandFilter = '';
    }
  }

  // Handle command selection from palette
  function handleCommandSelect(command: CommandRegistryEntry) {
    showCommandPalette = false;

    if (command.clientOnly) {
      executeClientCommand(command.name);
      resetInput();
      return;
    }

    if (command.args) {
      // Command takes arguments — fill prefix and let user type
      content = `/${command.name} `;
      textarea?.focus();
      return;
    }

    // No-arg server command — execute immediately
    sendCommand(command.name, undefined, activeThreadId ?? undefined);
    resetInput();
  }

  // Client-side command execution
  function executeClientCommand(name: string) {
    switch (name) {
      case 'help':
        // Show full palette with no filter
        showCommandPalette = true;
        commandFilter = '';
        content = '/';
        return; // Don't reset — keep palette open
      case 'stop':
        onstop?.();
        break;
    }
  }

  // Handle send — check for slash commands first, convert large text to file
  async function handleSend() {
    if (!canSend || uploading) return;

    let trimmed = content.trim();

    // Check if this is a slash command
    if (trimmed.startsWith('/')) {
      const spaceIndex = trimmed.indexOf(' ');
      const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
      const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim() || undefined;

      const cmd = commandRegistry.find(c => c.name === name);
      if (cmd) {
        if (cmd.clientOnly) {
          executeClientCommand(name);
        } else {
          sendCommand(name, args, activeThreadId ?? undefined);
        }
        resetInput();
        return;
      }
      // Not a recognized command — fall through to send as regular message
    }

    // Safety net: if text is over threshold at send time, convert to file
    if (trimmed.length > LARGE_PASTE_THRESHOLD) {
      const uploaded = await convertLargeTextToFile(trimmed, 'large-message');
      if (!uploaded) return;
      trimmed = '(see attached text)';
    }

    const files = [...pendingAttachments];
    // Append canvas references as compact markers the bubble renderer can detect
    let finalContent = trimmed;
    if (pendingCanvasRefs.length > 0) {
      const refs = pendingCanvasRefs.map(r => `<<canvas:${r.canvasId}:${r.title}>>`).join(' ');
      finalContent = finalContent ? `${finalContent}\n${refs}` : refs;
    }
    onbatchsend?.(finalContent, files, pendingProsody ?? undefined);
    resetInput();
  }

  function resetInput() {
    pendingAttachments = [];
    pendingCanvasRefs = [];
    content = '';
    pendingProsody = null;
    showCommandPalette = false;
    commandFilter = '';
    if (textarea) textarea.style.height = 'auto';
  }

  // Remove a pending attachment
  function removeAttachment(index: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
  }

  // Detect mobile/touch devices
  const isMobile = typeof window !== 'undefined' && (
    'ontouchstart' in window || navigator.maxTouchPoints > 0
  );

  // Canvas references — called externally via bind:this
  export function attachCanvasRef(canvasId: string, title: string) {
    // Don't add duplicates
    if (pendingCanvasRefs.some(r => r.canvasId === canvasId)) return;
    pendingCanvasRefs = [...pendingCanvasRefs, { canvasId, title }];
    textarea?.focus();
  }

  function removeCanvasRef(index: number) {
    pendingCanvasRefs = pendingCanvasRefs.filter((_, i) => i !== index);
  }

  // Handle keyboard — route to palette when open
  function handleKeydown(e: KeyboardEvent) {
    if (showCommandPalette && paletteRef) {
      const handled = paletteRef.handleKey(e);
      if (handled) return;
    }

    // On mobile, Enter creates newline — use send button to send
    // On desktop, Enter sends (Shift+Enter for newline)
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      void handleSend();
    }
  }

  // Upload a file to the server — queues as pending, doesn't send
  async function uploadFile(file: File): Promise<boolean> {
    uploading = true;
    uploadError = null;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiFetch('/api/files', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || `Upload failed (${response.status})`);
      }

      const result: FileUploadResult = await response.json();
      pendingAttachments = [...pendingAttachments, result];
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      uploadError = msg;
      setTimeout(() => { uploadError = null; }, 5000);
      return false;
    } finally {
      uploading = false;
    }
  }

  // Handle file input change — supports multiple files
  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      for (const file of files) {
        uploadFile(file);
      }
    }
    input.value = '';
  }

  // Handle paste — detect images and large text, queue as pending
  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      // Handle image pastes
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) uploadFile(file);
        return;
      }
    }

    // Check for large text pastes
    const pastedText = e.clipboardData?.getData('text/plain');
    if (pastedText && pastedText.length > LARGE_PASTE_THRESHOLD) {
      e.preventDefault();
      void convertLargeTextToFile(pastedText);
      content = '(see attached pasted text)';
    }
  }

  // Handle voice transcript — populate textarea, hold prosody
  function handleTranscript(text: string, prosody?: Record<string, number> | null) {
    content = text;
    pendingProsody = prosody ?? null;
    textarea?.focus();
  }

  // Handle gif selection — insert the URL as the message and send
  function handleGifSelect(url: string) {
    onbatchsend?.(url, [], undefined);
  }

  // Handle emoji selection — insert at cursor position
  function handleEmojiSelect(emoji: string) {
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      content = content.slice(0, start) + emoji + content.slice(end);
      // Set cursor after inserted emoji
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
        textarea.focus();
      }, 0);
    } else {
      content += emoji;
    }
  }

  // Cancel reply
  function handleCancelReply() {
    oncancelreply?.();
  }

  // Watch content for auto-resize + discard prosody if textarea fully cleared
  $effect(() => {
    if (content === '' && pendingProsody) {
      pendingProsody = null;
    }
    autoResize();
  });
</script>

<div class="message-input-container">
  {#if replyTo}
    <div class="reply-indicator">
      <div class="reply-bar"></div>
      <div class="reply-info">
        <span class="replying-to">Replying to {replyTo.role === 'companion' ? 'Bytelight' : 'You'}</span>
        <span class="reply-preview">{replyTo.content.substring(0, 100)}</span>
      </div>
      <button class="cancel-reply" onclick={handleCancelReply} aria-label="Cancel reply">
        ✕
      </button>
    </div>
  {/if}

  {#if uploadError}
    <div class="upload-error">{uploadError}</div>
  {/if}

  {#if pendingAttachments.length > 0}
    <div class="attachment-strip">
      {#each pendingAttachments as attachment, i}
        <div class="attachment-preview">
          {#if attachment.contentType === 'image'}
            <img src={attachment.url} alt={attachment.filename} class="attachment-thumb" />
          {:else}
            <div class="attachment-file-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <span class="attachment-name">{attachment.filename}</span>
            </div>
          {/if}
          <button class="attachment-remove" onclick={() => removeAttachment(i)} aria-label="Remove attachment">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if pendingCanvasRefs.length > 0}
    <div class="attachment-strip">
      {#each pendingCanvasRefs as ref, i}
        <div class="attachment-preview canvas-ref-chip">
          <div class="attachment-file-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            <span class="attachment-name">{ref.title}</span>
          </div>
          <button class="attachment-remove" onclick={() => removeCanvasRef(i)} aria-label="Remove canvas reference">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if showCommandPalette}
    <CommandPalette
      bind:this={paletteRef}
      filter={commandFilter}
      commands={commandRegistry}
      onselect={handleCommandSelect}
      onclose={() => { showCommandPalette = false; }}
    />
  {/if}

  <div class="input-bar" class:expanded={composerExpanded}>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,audio/*,.pdf,.txt,.md,.json,.zip,.docx,.xlsx,.doc,.xls,.csv"
      multiple
      onchange={handleFileSelect}
      hidden
      aria-hidden="true"
    />

    <!-- Top row: action buttons -->
    <div class="input-actions">
      <button
        class="attach-button"
        onclick={() => fileInput?.click()}
        disabled={uploading}
        aria-label="Attach file"
        title="Attach file"
      >
        {#if uploading}
          <span class="upload-spinner"></span>
        {:else}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>
          </svg>
        {/if}
      </button>

      <GifPicker onselect={handleGifSelect} />
      <EmojiPicker onselect={handleEmojiSelect} />

      <div class="sticker-picker-wrapper">
        <button
          class="picker-button"
          onclick={() => stickerPickerOpen = !stickerPickerOpen}
          aria-label="Stickers"
          title="Stickers"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
        </button>
        {#if stickerPickerOpen}
          <StickerPicker onselect={handleStickerSelect} onclose={() => stickerPickerOpen = false} />
        {/if}
      </div>

      <VoiceRecorder ontranscript={handleTranscript} />
      <VoiceModeToggle />

      <!-- Live voice call — hands-free conversation with both companions -->
      <button
        class="call-button"
        onclick={() => oncall?.()}
        aria-label="Start voice call"
        title="Voice call — hands-free conversation"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      </button>
    </div>

    <!-- Bottom row: textarea + send -->
    <div class="input-text-row">
      <textarea
        bind:this={textarea}
        bind:value={content}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
        placeholder="Type a message..."
        rows="1"
        aria-label="Message input"
      ></textarea>

      {#if isStreaming}
        <button
          class="stop-button"
          onclick={() => (showStopConfirm = true)}
          aria-label="Stop generation"
          title="Stop response"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
          </svg>
        </button>
      {/if}
      <button
        class="send-button"
        onclick={() => void handleSend()}
        disabled={!canSend}
        aria-label="Send message"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
        </svg>
      </button>
    </div>
  </div>
</div>

<ConfirmDialog
  open={showStopConfirm}
  title="Stop this response?"
  message="I'll stop mid-reply and keep whatever I've written so far. You can't resume it — only regenerate."
  confirmLabel="Stop"
  cancelLabel="Keep going"
  destructive={true}
  onconfirm={() => { showStopConfirm = false; onstop?.(); }}
  oncancel={() => { showStopConfirm = false; }}
/>

<style>
  .message-input-container {
    display: flex;
    flex-direction: column;
    background: transparent;
    max-width: 50rem;
    margin: 0 auto;
    padding: 0 1rem 1.5rem;
    position: relative;
    width: 100%;
  }

  .reply-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border);
  }

  .reply-bar {
    width: 2px;
    height: 2rem;
    background: var(--gold-dim);
    border-radius: 1px;
    flex-shrink: 0;
  }

  .reply-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow: hidden;
  }

  .replying-to {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--gold);
    font-family: var(--font-heading);
    letter-spacing: 0.03em;
  }

  .reply-preview {
    font-size: 0.875rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cancel-reply {
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition-fast);
  }

  .cancel-reply:hover {
    color: var(--text-secondary);
  }

  .upload-error {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    color: var(--error, var(--color-error));
    background: rgba(239, 68, 68, 0.1);
    border-bottom: 1px solid var(--border);
  }

  .attachment-strip {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1rem 0;
    overflow-x: auto;
    flex-wrap: wrap;
  }

  .attachment-preview {
    position: relative;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-surface);
  }

  .canvas-ref-chip {
    border-color: var(--accent, #9b72cf);
  }

  .attachment-thumb {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    display: block;
  }

  .attachment-file-icon {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    max-width: 8rem;
  }

  .attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.7);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-fast);
  }

  .attachment-remove:hover {
    background: rgba(239, 68, 68, 0.8);
  }

  .input-bar {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-lg, 1rem);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    transition: border-color var(--transition);
  }

  .input-bar:focus-within {
    border-color: var(--border-hover);
  }

  /* Toolbar is collapsed at idle so the composer stays compact;
     it reveals on focus or when there's active content/attachments. */
  .input-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-height: 0;
    margin-bottom: 0;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    transition: max-height var(--transition), opacity var(--transition), margin-bottom var(--transition);
  }

  .input-bar:focus-within .input-actions,
  .input-bar.expanded .input-actions {
    max-height: 3rem;
    margin-bottom: 0.5rem;
    opacity: 1;
    pointer-events: auto;
    /* let absolutely-positioned pickers (stickers/gif/emoji) escape the toolbar */
    overflow: visible;
  }

  .input-text-row {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .attach-button {
    padding: 0.5rem;
    color: var(--text-muted);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .attach-button:hover:not(:disabled) {
    color: var(--gold-dim);
    background: var(--gold-ember);
  }

  .attach-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .upload-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--text-muted);
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  textarea {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0.375rem 0.5rem;
    color: var(--text-primary);
    font-size: 1rem;
    line-height: 1.5;
    resize: none;
    min-height: 2.5rem;
    max-height: 200px;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  .send-button {
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    background: var(--accent, var(--gold-dim));
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    flex-shrink: 0;
    align-self: flex-end;
  }

  .send-button:hover:not(:disabled) {
    background: var(--gold);
  }

  .send-button:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }

  /* Compact secondary control that lives BESIDE the send button while a
     turn is streaming. Distinct silhouette (smaller, square-ish, ember)
     so it can't be confused with send. */
  .stop-button {
    width: 1.875rem;
    height: 1.875rem;
    padding: 0;
    background: transparent;
    color: var(--gold-dim);
    border: 1px solid var(--gold-dim);
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    flex-shrink: 0;
    align-self: flex-end;
    margin-bottom: 3px;
  }

  .stop-button:hover {
    background: var(--gold-ember, rgba(200, 160, 90, 0.15));
    color: var(--gold);
    box-shadow: 0 0 8px var(--gold-glow, rgba(200, 160, 90, 0.35));
  }

  @media (max-width: 768px) {
    .message-input-container {
      padding: 0 0.5rem 0.75rem;
    }

    .input-bar {
      padding: 0.5rem 0.625rem;
      gap: 0;
    }

    .input-actions {
      gap: 0.25rem;
    }

    .input-bar:focus-within .input-actions,
    .input-bar.expanded .input-actions {
      margin-bottom: 0.375rem;
    }

    .attach-button {
      padding: 0.375rem;
    }

    textarea {
      padding: 0.375rem 0.25rem;
      font-size: 1rem;
      min-height: 2.25rem;
    }
  }

  .sticker-picker-wrapper {
    position: relative;
    display: flex;
  }

  .picker-button {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    transition: color 0.15s;
  }

  .picker-button:hover {
    color: var(--gold);
  }

  .call-button {
    padding: 0.5rem;
    color: var(--text-muted);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .call-button:hover {
    color: var(--gold);
    background: var(--gold-ember);
  }

  @media (max-width: 768px) {
    .call-button {
      padding: 0.375rem;
    }
  }
</style>
