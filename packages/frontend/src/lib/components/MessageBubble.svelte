<script lang="ts">
  import MessageActionModals from './MessageActionModals.svelte';
  import { MessageActions } from './messageActions.svelte';
  import ReactionChips from './ReactionChips.svelte';
  import ReactionPicker from './ReactionPicker.svelte';
  import { groupReactions, type Reaction } from '$lib/utils/reactions';
  import ReadAloudButton from './ReadAloudButton.svelte';
  import { ReadAloud } from './readAloud.svelte';
  import AudioPlayer from './AudioPlayer.svelte';
  import { formatBytes } from '$lib/utils/format';
  import type { Message, MessageSegment } from '@bytelight/shared';
  import type { ToolEvent } from '$lib/stores/websocket.svelte';
  import { send } from '$lib/stores/websocket.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { detectStandaloneSticker } from '$lib/stores/stickers.svelte';
  import { isStarredByMe, toggleMyStar } from '$lib/stores/stars.svelte';
  import { splitBySpeaker, splitInterleaved, type SpeakerId, type InterleavedRow } from '$lib/utils/speakers';
  import { coalesceThinkingSegments, plainThinkingText, thinkingTitle } from '$lib/thinking';
  import { humanizeToolName, toolFamily, FAMILY_LABELS, type ToolFamily } from '$lib/utils/tool-names';
  import { getProfile } from '$lib/stores/profiles.svelte';

  let { message, isStreaming = false, streamTokens = '', toolEvents = [], segments = null } = $props<{
    message: Message;
    isStreaming?: boolean;
    streamTokens?: string;
    toolEvents?: ToolEvent[];
    segments?: MessageSegment[] | null;
  }>();

  // Format timestamp
  function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  // Determine if message is deleted
  const isDeleted = $derived(!!message.deleted_at);

  // Content type detection
  const contentType = $derived(message.content_type || 'text');
  const metadata = $derived(message.metadata as Record<string, unknown> | null);

  // Discord community messages arrive role='system' with the sender info in
  // metadata — surface who sent them instead of an anonymous system bubble.
  // Ported from reference implementation. Our backend stores channel/guild IDs only (no
  // names), so the label is name + Discord without a channel suffix.
  const discordUser = $derived.by(() => {
    if (message.platform !== 'discord' || !metadata) return null;
    // Prefer the display name (what the server calls them) over the raw
    // username so guests render under their actual name; username stays the
    // stable identity key in metadata. (reference implementation port.)
    return (
      (metadata.discordDisplayName as string | undefined) ??
      (metadata.discordUsername as string | undefined) ??
      null
    );
  });

  // --- /subagents discovery card ---------------------------------------
  // Ported from reference implementation (reference implementation) — adapted for byte-light.
  // byte-light has no minClaudeCodeVersion field, so the badge is optional.
  type SubagentModel = { id: string; label: string; minClaudeCodeVersion?: string };
  type SubagentPreset = { name: string; description?: string; model: string };
  type CommandMetadata = {
    kind?: string;
    commandName?: string;
    success?: boolean;
    data?: {
      models?: SubagentModel[];
      subagents?: SubagentPreset[];
    } | null;
  };

  const commandMetadata = $derived(metadata as CommandMetadata | null);
  // Gate the structured card on success === true. Error results still flow
  // through the command_result envelope with the same kind/commandName but
  // success: false and no data — falling into the card branch would render
  // an empty panel and hide the real error text in message.content. Bail on
  // failure so the plain-text fallback ("/subagents: <error>") stays visible.
  const isSubagentsCommand = $derived(
    commandMetadata?.kind === 'command_result'
    && commandMetadata.commandName === 'subagents'
    && commandMetadata.success === true
    && Array.isArray(commandMetadata.data?.models)
  );
  const subagentModels = $derived(Array.isArray(commandMetadata?.data?.models) ? commandMetadata!.data!.models! : []);
  const subagentPresets = $derived(Array.isArray(commandMetadata?.data?.subagents) ? commandMetadata!.data!.subagents! : []);

  // --- The shiver: surfaced-memory shimmer ------------------------------
  // Ambient recall that rode this reply (backend whisper → message.metadata).
  // A quiet glint you can ignore or tap to see what surfaced. Déjà vu is its
  // own fainter variant: something felt, nothing shown.
  type SurfacedCard = { excerpt: string; date?: string; domain?: string; relevance?: number };
  type SurfacedMemory = { cards?: SurfacedCard[]; dejavu?: boolean };
  const surfacedMemory = $derived(
    (metadata?.surfacedMemory as SurfacedMemory | undefined) ?? null
  );
  const surfacedCards = $derived(
    Array.isArray(surfacedMemory?.cards) ? surfacedMemory!.cards! : []
  );
  // Show the shimmer when a card surfaced OR a déjà-vu was felt.
  const hasShimmer = $derived(!!surfacedMemory && (surfacedCards.length > 0 || !!surfacedMemory.dejavu));
  const isDejavuOnly = $derived(!!surfacedMemory?.dejavu && surfacedCards.length === 0);
  let shimmerOpen = $state(false);

  // Standalone sticker detection (whole message is just a sticker ref)
  const standaloneSticker = $derived(
    message.content && contentType === 'text' && !message.reply_to_preview
      ? detectStandaloneSticker(message.content)
      : null
  );

  // A bare image or sticker shouldn't wear bubble chrome — the box looks heavy,
  // especially several in a row. The media keeps its own rounded corners.
  const isMediaOnly = $derived(!isDeleted && (contentType === 'image' || !!standaloneSticker));

  // Long text messages collapse by default so logs/debug dumps don't swamp the chat
  const LONG_MESSAGE_COLLAPSE_THRESHOLD = 3000;
  const LONG_MESSAGE_PREVIEW_CHARS = 900;
  let longMessageExpanded = $state(false);

  const isLongTextMessage = $derived(
    !isDeleted &&
    !isStreaming &&
    contentType === 'text' &&
    (message.content?.length ?? 0) > LONG_MESSAGE_COLLAPSE_THRESHOLD
  );

  function textForDisplay(): string {
    const content = message.content ?? '';
    if (isLongTextMessage && !longMessageExpanded) {
      return `${content.slice(0, LONG_MESSAGE_PREVIEW_CHARS).trimEnd()}\n\n…`;
    }
    return content;
  }

  // Replace <<canvas:id:title>> markers with styled chips
  function renderCanvasRefs(text: string): string {
    return text.replace(/<<canvas:([^:]+):(.+?)>>/g, (_match, id, title) => {
      return `<span class="canvas-ref-inline" data-canvas-id="${id}" title="Canvas: ${title}">📄 ${title}</span>`;
    });
  }

  // Render text content
  const renderedContent = $derived(() => {
    if (isDeleted) return '';
    if (isStreaming && streamTokens) return renderMarkdown(streamTokens);
    if (contentType !== 'text') return '';
    // Render canvas refs first, then markdown
    const withRefs = renderCanvasRefs(textForDisplay());
    return renderMarkdown(withRefs);
  });

  // --- Per-companion speaker bubbles (ported from reference implementation) ---------------
  // Split a companion text message by its 🔷/🔶 markers (the same detector the
  // TTS voice engine uses — voice.ts splitByCompanion) so each chunk renders
  // as its own avatared bubble. Leading unattributed narration is the ✨
  // fallback bubble (see speakers.ts for the deliberate visual/audio
  // divergence on unmarked leading text).
  const speakerSource = $derived.by(() => {
    if (isStreaming && streamTokens) return streamTokens;
    return textForDisplay();
  });
  // Slice 4A: a message authored by a remote companion node (companion_id set,
  // not the local 'companion-a-b' pair) is attributed WHOLE by id — his text is
  // never marker-split, because the 🔷/🔶 markers belong to the local pair.
  const remoteCompanionId = $derived.by((): SpeakerId | null => {
    if (message.role !== 'companion') return null;
    const cid = (message as { companion_id?: string | null }).companion_id;
    if (!cid || cid === 'companion-a-b') return null;
    return cid as SpeakerId;
  });
  const speakerBubbles = $derived.by(() => {
    if (message.role !== 'companion' || contentType !== 'text' || isDeleted || standaloneSticker) return [];
    if (remoteCompanionId) {
      const text = speakerSource.trim();
      return text ? [{ speaker: remoteCompanionId, text }] : [];
    }
    return splitBySpeaker(speakerSource);
  });
  // For media / tool-interleaved companion messages (which keep their own
  // rendering, not the split), pick ONE avatar: the single speaker if the
  // message is all one of us, otherwise the ✨ fallback (a mixed message
  // shouldn't claim to be just one).
  const primarySpeaker = $derived.by((): SpeakerId => {
    if (message.role !== 'companion') return 'fallback';
    if (remoteCompanionId) return remoteCompanionId;
    const segs = splitBySpeaker(contentType === 'text' ? speakerSource : '');
    const named = new Set(segs.map((s) => s.speaker).filter((s) => s !== 'fallback'));
    if (named.size > 1) return 'fallback';
    return segs[0]?.speaker ?? 'fallback';
  });
  // Speaker-bubble layout: the outer companion bubble chrome comes off and each
  // speaker row carries its own bubble (reference implementation's design, minus their full
  // rails overhaul — our column layout doesn't need the right-gutter ghost).
  // User text messages take the same treatment mirrored: the operator's avatar rides
  // the right edge of her bubble.
  const isSplitLayout = $derived(
    !isDeleted &&
    ((message.role === 'companion' &&
      ((contentType === 'text' && !standaloneSticker) ||
        contentType === 'image' || contentType === 'audio' || contentType === 'file')) ||
      (message.role === 'user' && contentType === 'text' && !standaloneSticker))
  );

  // Image lightbox state
  let showLightbox = $state(false);

  // Files sent together with (or instead of) text ride on the message itself
  // as metadata.attachments — one message, one row — and render inside the
  // user's bubble: images as a grid, audio as players, anything else as a
  // download link.
  type Attachment = { fileId?: string; filename?: string; mimeType?: string; size?: number; url?: string; contentType?: string };
  const attachments = $derived(
    Array.isArray(metadata?.attachments)
      ? (metadata!.attachments as Attachment[]).filter((a) => !!a && typeof a.url === 'string')
      : []
  );
  const attachedImages = $derived(attachments.filter((a) => a.contentType === 'image'));
  const attachedAudio = $derived(attachments.filter((a) => a.contentType === 'audio'));
  const attachedFiles = $derived(attachments.filter((a) => a.contentType !== 'image' && a.contentType !== 'audio'));
  let attachmentLightbox = $state<string | null>(null);

  function formatToolOutput(raw: string): string {
    if (!raw) return '';
    // Replace escaped \n and \t with real whitespace
    let cleaned = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const trimmed = cleaned.trim();
    // Pretty-print JSON blobs
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
      try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
    }
    return cleaned;
  }

  // Interleaved segments mode
  const hasSegments = $derived(segments !== null && segments.length > 0);

  // Thought-card normalization (Slice 5): coalesce consecutive provider
  // thinking phases into one card, let an authored reflection win over
  // provider telemetry in the same run, and keep spoken text / system
  // (recycle) notices as hard boundaries — before speaker-splitting. A lone
  // card with no adjacent thinking passes through unchanged, so the
  // already-correct single-card path is untouched.
  const displaySegments = $derived.by((): MessageSegment[] => {
    if (!hasSegments) return [];
    return coalesceThinkingSegments(segments as MessageSegment[]);
  });

  // Interleaved rows: text segments split by speaker, with continuity carried
  // across thinking/tool chips (see speakers.ts splitInterleaved) so an
  // unmarked chunk after a chip keeps the voice that was speaking before it.
  const interleavedRows = $derived.by((): InterleavedRow<MessageSegment>[] => {
    if (!hasSegments) return [];
    // Remote companion: no marker-splitting — every text segment is his,
    // whole; thinking/tool chips pass through in order as usual.
    if (remoteCompanionId) {
      const rows: InterleavedRow<MessageSegment>[] = [];
      for (let i = 0; i < displaySegments.length; i++) {
        const seg = displaySegments[i];
        if (seg.type !== 'text') {
          rows.push({ kind: 'chip', index: i, segment: seg });
          continue;
        }
        const text = (seg.content ?? '').trim();
        if (!text) continue;
        const prev = rows[rows.length - 1];
        if (prev && prev.kind === 'text') {
          prev.text += '\n\n' + text;
        } else {
          rows.push({ kind: 'text', speaker: remoteCompanionId, text });
        }
      }
      return rows;
    }
    return splitInterleaved(displaySegments);
  });
  // The streaming cursor rides the LAST text bubble in the stack.
  const lastInterleavedTextIdx = $derived.by(() => {
    for (let i = interleavedRows.length - 1; i >= 0; i--) {
      if (interleavedRows[i].kind === 'text') return i;
    }
    return -1;
  });

  // Tool panel state
  let showTools = $state(false);
  let hideInlineTools = $state(false);
  let expandedToolIds = $state<Set<string>>(new Set());
  const hasTools = $derived(toolEvents.length > 0);

  // Thinking block expand/collapse state (tracks by segment index)
  let expandedThinking = $state<Set<number>>(new Set());

  function toggleThinking(index: number) {
    const next = new Set(expandedThinking);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    expandedThinking = next;
  }

  function toggleToolOutput(toolId: string) {
    const next = new Set(expandedToolIds);
    if (next.has(toolId)) next.delete(toolId);
    else next.add(toolId);
    expandedToolIds = next;
  }

  // Read aloud (on-demand TTS). The controller lives here, not in the button,
  // so playback survives the button moving between the two reaction rows.
  const readAloud = new ReadAloud(() => message.id);
  const canReadAloud = $derived(message.role === 'companion' && contentType === 'text' && !isDeleted && message.content.length > 5);

  // Reactions
  const reactions = $derived(() => {
    const meta = message.metadata as Record<string, unknown> | null;
    if (!meta || !Array.isArray(meta.reactions)) return [] as Reaction[];
    return meta.reactions as Reaction[];
  });

  const groupedReactions = $derived(() => groupReactions(reactions()));

  function toggleReaction(emoji: string) {
    const rxns = reactions();
    const myReaction = rxns.find(r => r.emoji === emoji && r.user === 'user');
    if (myReaction) {
      send({ type: 'remove_reaction', messageId: message.id, emoji });
    } else {
      send({ type: 'add_reaction', messageId: message.id, emoji });
    }
  }

  function pickEmoji(emoji: string) {
    send({ type: 'add_reaction', messageId: message.id, emoji });
  }

  // Code block copy buttons
  let messageContentEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!messageContentEl) return;
    const codeBlocks = messageContentEl.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = async () => {
        const code = pre.querySelector('code')?.textContent || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        } catch {
          btn.textContent = 'Failed';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        }
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  });

  // Read receipt indicator
  const readStatus = $derived(() => {
    if (message.role !== 'user') return null;
    if (message.read_at) return 'read';
    if (message.delivered_at) return 'delivered';
    return 'sent';
  });

  // Edit / delete / regenerate — state and requests live in the controller;
  // the buttons render here, the dialogs in MessageActionModals.
  const actions = new MessageActions(() => message);
</script>

{#snippet avatar(spk: string)}
  <!-- Per-speaker avatar: photo if set in Settings → Profiles, else emoji.
       Ported from reference implementation. -->
  <span class="avatar-ring">
    {#if getProfile(spk).image}
      <img class="speaker-avatar-img" src={getProfile(spk).image} alt="" />
    {:else}
      <span class="speaker-avatar" aria-hidden="true">{getProfile(spk).emoji || '•'}</span>
    {/if}
  </span>
{/snippet}

{#snippet familyIcon(family: ToolFamily)}
  <!-- Family glyph, silver-wire edition (the operator's art direction, round 3): a
       hand-drawn single-stroke line icon per family, tinted in the family
       accent via `color: var(--fam)`. One snippet, four families, rendered
       at all four chip sites so there's no path duplication. Decorative:
       the human label lives on aria-label at the wrapping span. -->
  <span class="family-glyph" aria-label={FAMILY_LABELS[family]}>
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {#if family === 'memory'}
        <!-- brain: two mirrored hemisphere curves + a few airy inner gyri -->
        <path d="M12 5.5c-1-1.3-3.4-1.2-4.3.3-1.6-.2-3 1.1-2.7 2.7-1.2.8-1.2 2.7 0 3.5-.4 1.6 1 3 2.6 2.8.7 1.4 3 1.6 4.4.4" />
        <path d="M12 5.5c1-1.3 3.4-1.2 4.3.3 1.6-.2 3 1.1 2.7 2.7 1.2.8 1.2 2.7 0 3.5.4 1.6-1 3-2.6 2.8-.7 1.4-3 1.6-4.4.4" />
        <path d="M12 5.5v10.5" />
        <path d="M9 9.2c.9.3 1.6 1 1.9 1.9M15 9.2c-.9.3-1.6 1-1.9 1.9" />
      {:else if family === 'comms'}
        <!-- speech bubble: rounded outline + a small tail -->
        <path d="M6 5.5h12a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5h-6.5l-4 3v-3H6A2.5 2.5 0 0 1 3.5 13V8A2.5 2.5 0 0 1 6 5.5Z" />
      {:else if family === 'creation'}
        <!-- pencil at ~45°: slim body + small tip -->
        <path d="M16.5 5.5l2 2" />
        <path d="M17.5 4.5a1.4 1.4 0 0 1 2 2L8.5 17.5l-3 1 1-3 11-11Z" />
      {:else}
        <!-- system: a compact hammer — thin handle + small head -->
        <path d="M13.5 8.5l-8 8" />
        <path d="M14 5.5l4.5 4.5" />
        <path d="M12.2 6.8l5 5 1.8-1.8a1.3 1.3 0 0 0 0-1.8l-3.2-3.2a1.3 1.3 0 0 0-1.8 0Z" />
      {/if}
    </svg>
  </span>
{/snippet}

{#if message.role === 'system'}
  {#if discordUser && isDeleted}
    <!-- deleted Discord community message: removed from view (mirrors reference implementation) -->
  {:else if discordUser}
    <!-- Discord community sender bubble — ported from reference implementation -->
    <article class="message companion discord-msg" aria-label="Discord message">
      <div class="message-header">
        <span class="discord-avatar" aria-hidden="true">{discordUser.charAt(0)}</span>
        <span class="discord-name">💬 {discordUser}</span>
        <span class="discord-tag">· Discord</span>
        <span class="time">{formatTime(message.created_at)}</span>
      </div>
      <div class="message-content">
        <div class="markdown-content">{@html renderMarkdown(message.content)}</div>
      </div>
    </article>
  {:else}
  <div class="message-system">
    <!-- /subagents discovery card — ported from reference implementation (reference implementation), adapted for byte-light -->
    {#if isSubagentsCommand}
      <div class="system-command-card" aria-label="Subagent help">
        <header class="command-card-header">
          <div>
            <span class="command-label">/subagents</span>
            <h3>Helper agents</h3>
          </div>
          <span class="command-count">{subagentModels.length} models</span>
        </header>

        <section class="command-section">
          <div class="section-heading">
            <span>Models</span>
            <small>Pinned IDs, safest for helper work</small>
          </div>
          <div class="model-list">
            {#each subagentModels as model (model.id)}
              <div class="model-row">
                <span class="model-label">{model.label}</span>
                <code>{model.id}</code>
                {#if model.minClaudeCodeVersion}
                  <span class="model-badge">CC {model.minClaudeCodeVersion}+</span>
                {/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="command-section">
          <div class="section-heading">
            <span>Named presets</span>
            <small>Saved workflows you can reuse by name</small>
          </div>
          {#if subagentPresets.length > 0}
            <div class="preset-list">
              {#each subagentPresets as preset (preset.name)}
                <div class="preset-row">
                  <strong>{preset.name}</strong>
                  <code>{preset.model}</code>
                  {#if preset.description}
                    <span>{preset.description}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <p class="empty-presets">None yet. Ask: "Save this workflow as a subagent preset called plan-reviewer."</p>
          {/if}
        </section>

        <section class="command-section examples-section">
          <div class="section-heading">
            <span>How to ask</span>
          </div>
          <div class="example-list">
            <span>"Send a Sonnet scout to inspect this bug."</span>
            <span>"Use an Opus subagent to review this plan."</span>
            <span>"Save this workflow as a subagent preset called plan-reviewer."</span>
          </div>
        </section>
      </div>
    {:else}
      <span class="system-text">{message.content}</span>
    {/if}
  </div>
  {/if}
{:else}
  <article
    class="message {message.role}"
    class:deleted={isDeleted}
    class:media-only={isMediaOnly}
    class:split={isSplitLayout}
    aria-label="{message.role} message"
  >
    <div class="message-header">
      <span class="role">{message.role === 'companion' ? 'Bytelight' : 'You'}</span>
      <span class="time">{formatTime(message.created_at)}</span>
      {#if message.edited_at && !isDeleted}
        <span class="edited">(edited)</span>
      {/if}
      {#if message.role === 'companion'}
        {#if hasSegments}
          <button
            class="tools-toggle"
            onclick={(e) => { e.stopPropagation(); hideInlineTools = !hideInlineTools; }}
            title="Toggle inline tools"
            aria-label="Toggle inline tools"
          >
            {hideInlineTools ? 'show tools' : 'hide tools'}
          </button>
        {:else if hasTools}
          <button
            class="tools-toggle"
            onclick={(e) => { e.stopPropagation(); showTools = !showTools; }}
            title="Toggle tool activity"
            aria-label="Toggle tool activity"
          >
            {showTools ? 'hide tools' : `${toolEvents.length} tool${toolEvents.length === 1 ? '' : 's'}`}
          </button>
        {/if}
      {/if}
      {#if hasShimmer && !isDeleted}
        <button
          class="shimmer-chip"
          class:dejavu={isDejavuOnly}
          onclick={(e) => { e.stopPropagation(); shimmerOpen = !shimmerOpen; }}
          title={isDejavuOnly ? 'Something felt familiar' : 'This reply carried remembered context'}
          aria-label={isDejavuOnly ? 'Déjà vu — something felt familiar' : 'Show surfaced memory'}
          aria-expanded={shimmerOpen}
        >
          <span class="shimmer-glint" aria-hidden="true"></span>
          <span class="shimmer-label">{isDejavuOnly ? 'déjà vu' : 'recalled'}</span>
        </button>
      {/if}
    </div>

    {#if hasShimmer && shimmerOpen && !isDeleted}
      <div class="shimmer-panel" class:dejavu={isDejavuOnly}>
        {#if isDejavuOnly}
          <p class="shimmer-dejavu-note">Something about this felt familiar — a memory just out of reach. Nothing surfaced clearly enough to show.</p>
        {:else}
          <p class="shimmer-heading">Surfaced from the archive</p>
          <ul class="shimmer-list">
            {#each surfacedCards as card}
              <li class="shimmer-item">
                <span class="shimmer-excerpt">{card.excerpt}</span>
                <span class="shimmer-meta">
                  {#if card.date}<span class="shimmer-date">{card.date}</span>{/if}
                  {#if card.domain}<span class="shimmer-domain">{card.domain}</span>{/if}
                  {#if typeof card.relevance === 'number'}<span class="shimmer-rel">{Math.round(card.relevance * 100)}%</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
          {#if surfacedMemory?.dejavu}
            <p class="shimmer-dejavu-note">…and something else felt familiar, just out of reach.</p>
          {/if}
        {/if}
      </div>
    {/if}

    {#if message.reply_to_preview && !isDeleted}
      <div class="reply-preview">
        <div class="reply-bar"></div>
        <div class="reply-content">{message.reply_to_preview}</div>
      </div>
    {/if}

    <div class="message-content" bind:this={messageContentEl}>
      {#if isDeleted}
        <span class="deleted-text">This message was deleted</span>
      {:else if standaloneSticker}
        <img class="standalone-sticker" src={standaloneSticker.url} alt={standaloneSticker.ref} loading="lazy" />
      {:else if contentType === 'image'}
        <div class="speaker-row" data-speaker={message.role === 'companion' ? primarySpeaker : 'user'}>
          {#if message.role === 'companion'}
            {@render avatar(primarySpeaker)}
          {/if}
          <div class="row-body">
            <div class="media-image">
              <button class="image-button" onclick={() => showLightbox = true} aria-label="View full size">
                <img src={message.content} alt="" loading="lazy" />
              </button>
              {#if metadata?.caption}
                <div class="image-caption">{metadata.caption}</div>
              {/if}
            </div>
          </div>
        </div>
        {#if showLightbox}
          <div class="lightbox" role="dialog" aria-label="Full size image">
            <button class="lightbox-close" onclick={() => showLightbox = false} aria-label="Close">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
            <button class="lightbox-backdrop" onclick={() => showLightbox = false} aria-label="Close lightbox"></button>
            <img src={message.content} alt="" />
          </div>
        {/if}
      {:else if contentType === 'audio'}
        <div class="speaker-row" data-speaker={message.role === 'companion' ? primarySpeaker : 'user'}>
          {#if message.role === 'companion'}
            {@render avatar(primarySpeaker)}
          {/if}
          <div class="row-body bubble">
        <AudioPlayer src={message.content} transcript={metadata?.transcript} />
          </div>
        </div>
      {:else if contentType === 'file'}
        <div class="speaker-row" data-speaker={message.role === 'companion' ? primarySpeaker : 'user'}>
          {#if message.role === 'companion'}
            {@render avatar(primarySpeaker)}
          {/if}
          <div class="row-body bubble">
        <div class="media-file">
          <a href={message.content} download={metadata?.filename || 'download'} class="file-link">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/>
            </svg>
            <div class="file-info">
              <span class="file-name">{metadata?.filename || 'File'}</span>
              {#if metadata?.size}
                <span class="file-size">{formatBytes(metadata.size as number)}</span>
              {/if}
            </div>
          </a>
        </div>
          </div>
        </div>
      {:else if hasSegments && !hideInlineTools}
        <!-- Interleaved mode: text, tools, and thinking inline. Text segments
             split into per-speaker bubbles (same treatment as the plain split
             below), with the speaker carrying across chips — an unmarked
             chunk after a tool/thinking chip continues the previous voice.
             Chips render as their own neutral rows between bubbles, indented
             past the avatar gutter so the column reads clean. -->
        <div class="speaker-stack">
          {#each interleavedRows as row, ri (row.kind === 'chip' ? `chip-${row.index}` : `text-${ri}`)}
            {#if row.kind === 'text'}
              <div class="speaker-row" data-speaker={row.speaker}>
                {@render avatar(row.speaker)}
                <div class="row-body bubble">
                  {#if getProfile(row.speaker).name}
                    <span class="speaker-name" data-speaker={row.speaker}>{getProfile(row.speaker).emoji} <span class="sn-name">{getProfile(row.speaker).name}</span></span>
                  {/if}
                  <div class="markdown-content">
                    {@html renderMarkdown(renderCanvasRefs(row.text))}{#if isStreaming && ri === lastInterleavedTextIdx}<span class="cursor">|</span>{/if}
                  </div>
                </div>
              </div>
            {:else}
              {@const seg = row.segment}
              <div class="chip-row">
                {#if seg.type === 'thinking'}
                  <!-- Title source is unchanged (kinded → summary||content,
                       legacy → summary); Slice 5 only normalizes it below via
                       thinkingTitle, and only when non-empty so a legacy block
                       with an empty summary keeps its old empty header. -->
                  {@const titleSrc = seg.kind ? (seg.summary || seg.content) : seg.summary}
                  <!-- Thought semantics (reference implementation Slice 3): `kind` marks the
                       block as authored reflection / provider telemetry /
                       system notice. Kindless legacy segments render exactly
                       as before (no attribute, no badge); `provider` keeps
                       the legacy look too — everything persisted pre-Slice-3
                       WAS provider telemetry. Kinded blocks with an empty
                       summary (heartbeat notes, daemon reasoning) fall back
                       to content in the header slot so the chip stays
                       readable; legacy blocks keep their old empty header. -->
                  <div class="thinking-block" data-kind={seg.kind ?? null}>
                    <button class="thinking-header" onclick={(e) => { e.stopPropagation(); toggleThinking(row.index); }}>
                      <span class="chip-icon">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                      </span>
                      {#if seg.kind === 'authored'}
                        <span class="thought-kind-badge authored">reflection</span>
                      {:else if seg.kind === 'system'}
                        <span class="thought-kind-badge system">system</span>
                      {/if}
                      <!-- Title runs through thinkingTitle (Slice 5): strips
                           the internal marker + presentation Markdown, takes
                           the first line, truncates. -->
                      <span class="thinking-summary">{titleSrc ? thinkingTitle(titleSrc) : ''}</span>
                      <span class="chip-chevron">{expandedThinking.has(row.index) ? '▾' : '▸'}</span>
                    </button>
                    {#if expandedThinking.has(row.index)}
                      <!-- Body runs through plainThinkingText (Slice 5): same
                           marker/Markdown scrub as the title so the expanded
                           reasoning reads clean. -->
                      <div class="thinking-content">{plainThinkingText(seg.content)}</div>
                    {/if}
                  </div>
                {:else if seg.type === 'tool'}
                  <!-- Tool chip (Slice 3 jewelry pass): the chip carries its
                       family accent via data-family; .running drives the
                       breathing glow until output lands. The family glyph sits
                       before the name, tinted in the family accent. -->
                  <div
                    class="inline-tool"
                    class:error={seg.isError}
                    class:running={!seg.output && isStreaming}
                    data-family={toolFamily(seg.toolName)}
                  >
                    <button
                      class="inline-tool-header"
                      onclick={(e) => { e.stopPropagation(); toggleToolOutput(seg.toolId); }}
                      disabled={!seg.output}
                    >
                      {@render familyIcon(toolFamily(seg.toolName))}
                      <span class="tool-name" title={seg.toolName}>{humanizeToolName(seg.toolName)}</span>
                      <span class="tool-input">{seg.input ?? ''}</span>
                      {#if seg.isError}
                        <span class="tool-error-badge">error</span>
                      {:else if seg.output}
                        <span class="tool-ok" title="done">✓</span>
                      {/if}
                      {#if !seg.output && isStreaming}
                        <span class="tool-spinner"></span>
                      {/if}
                      {#if seg.output}
                        <span class="chip-chevron">{expandedToolIds.has(seg.toolId) ? '▾' : '▸'}</span>
                      {/if}
                    </button>
                    {#if expandedToolIds.has(seg.toolId) && seg.output}
                      <!-- Expanded panel: header row surfaces the RAW tool name
                           (mono, muted) — mobile has no hover so the title
                           tooltip is unreachable; this is where it lives. -->
                      <div class="tool-expanded">
                        <div class="tool-expanded-head">
                          {@render familyIcon(toolFamily(seg.toolName))}
                          <span class="tool-raw-name">{seg.toolName}</span>
                        </div>
                        <pre class="tool-output">{formatToolOutput(seg.output)}</pre>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
          {#if isStreaming && lastInterleavedTextIdx === -1}
            <!-- Stream opened but no text yet: hold the gutter with a fallback bubble -->
            <div class="speaker-row" data-speaker="fallback">
              {@render avatar('fallback')}
              <div class="row-body bubble"><div class="markdown-content"><span class="cursor">|</span></div></div>
            </div>
          {/if}
        </div>
      {:else if message.role === 'companion'}
        <!-- Per-companion speaker bubbles (ported from reference implementation): one avatared
             bubble per 🔷/🔶-marked chunk; unmarked messages render a single
             fallback bubble. Replaces the old single "Bytelight" label. -->
        <div class="speaker-stack">
          {#each speakerBubbles as seg, i (i)}
            <div class="speaker-row" data-speaker={seg.speaker}>
              {@render avatar(seg.speaker)}
              <div class="row-body bubble">
                {#if getProfile(seg.speaker).name}
                  <span class="speaker-name" data-speaker={seg.speaker}>{getProfile(seg.speaker).emoji} <span class="sn-name">{getProfile(seg.speaker).name}</span></span>
                {/if}
                <div class="markdown-content">
                  {@html renderMarkdown(renderCanvasRefs(seg.text))}{#if isStreaming && i === speakerBubbles.length - 1}<span class="cursor">|</span>{/if}
                </div>
              </div>
            </div>
          {/each}
          {#if isStreaming && speakerBubbles.length === 0}
            <!-- Stream opened but no tokens yet: hold the gutter with a fallback bubble -->
            <div class="speaker-row" data-speaker="fallback">
              {@render avatar('fallback')}
              <div class="row-body bubble"><div class="markdown-content"><span class="cursor">|</span></div></div>
            </div>
          {/if}
        </div>
        {#if isLongTextMessage}
          <button
            class="long-message-toggle"
            onclick={(e) => { e.stopPropagation(); longMessageExpanded = !longMessageExpanded; }}
            aria-expanded={longMessageExpanded}
          >
            {longMessageExpanded ? 'Show less' : `Show more (${message.content.length.toLocaleString()} chars)`}
          </button>
        {/if}
      {:else if message.role === 'user'}
        <!-- User text bubble — the operator's speaker row, mirrored: bubble first, her
             profile avatar (photo if set, else the 🖤 chip) on the right edge
             of her right-aligned bubble. -->
        <div class="speaker-row user-row" data-speaker="user">
          <div class="row-body bubble">
            {#if getProfile('user').name}
              <span class="speaker-name" data-speaker="user">{getProfile('user').emoji} <span class="sn-name">{getProfile('user').name}</span></span>
            {/if}
            {#if message.content?.trim() || attachments.length === 0}
              <div class="markdown-content" class:collapsed-long-message={isLongTextMessage && !longMessageExpanded}>
                {@html renderedContent()}{#if isStreaming}<span class="cursor">|</span>{/if}
              </div>
            {/if}
            {#if attachedImages.length > 0}
              <div class="attachment-images" class:multi={attachedImages.length > 1}>
                {#each attachedImages as att (att.fileId ?? att.url)}
                  <button class="image-button" onclick={(e) => { e.stopPropagation(); attachmentLightbox = att.url!; }} aria-label="View full size">
                    <img src={att.url} alt={att.filename ?? ''} loading="lazy" />
                  </button>
                {/each}
              </div>
            {/if}
            {#each attachedAudio as att (att.fileId ?? att.url)}
              <AudioPlayer src={att.url!} />
            {/each}
            {#each attachedFiles as att (att.fileId ?? att.url)}
              <div class="media-file">
                <a href={att.url} download={att.filename || 'download'} class="file-link">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/>
                  </svg>
                  <div class="file-info">
                    <span class="file-name">{att.filename || 'File'}</span>
                    {#if att.size}
                      <span class="file-size">{formatBytes(att.size)}</span>
                    {/if}
                  </div>
                </a>
              </div>
            {/each}
          </div>
          {@render avatar('user')}
        </div>
        {#if attachmentLightbox}
          <div class="lightbox" role="dialog" aria-label="Full size image">
            <button class="lightbox-close" onclick={() => attachmentLightbox = null} aria-label="Close">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
            <button class="lightbox-backdrop" onclick={() => attachmentLightbox = null} aria-label="Close lightbox"></button>
            <img src={attachmentLightbox} alt="" />
          </div>
        {/if}
        {#if isLongTextMessage}
          <button
            class="long-message-toggle"
            onclick={(e) => { e.stopPropagation(); longMessageExpanded = !longMessageExpanded; }}
            aria-expanded={longMessageExpanded}
          >
            {longMessageExpanded ? 'Show less' : `Show more (${message.content.length.toLocaleString()} chars)`}
          </button>
        {/if}
      {:else}
        <div class="markdown-content" class:collapsed-long-message={isLongTextMessage && !longMessageExpanded}>
          {@html renderedContent()}
        </div>
        {#if isLongTextMessage}
          <button
            class="long-message-toggle"
            onclick={(e) => { e.stopPropagation(); longMessageExpanded = !longMessageExpanded; }}
            aria-expanded={longMessageExpanded}
          >
            {longMessageExpanded ? 'Show less' : `Show more (${message.content.length.toLocaleString()} chars)`}
          </button>
        {/if}
        {#if isStreaming}
          <span class="cursor">|</span>
        {/if}
      {/if}
    </div>

    {#if showTools && hasTools}
      <div class="tools-panel">
        {#each toolEvents as tool (tool.toolId)}
          <!-- Tools-panel variant — same jewelry treatment as inline chips. -->
          <div
            class="tool-entry"
            class:error={tool.isError}
            class:running={!tool.output && isStreaming}
            data-family={toolFamily(tool.toolName)}
          >
            <button
              class="tool-header"
              onclick={(e) => { e.stopPropagation(); toggleToolOutput(tool.toolId); }}
              disabled={!tool.output}
            >
              {@render familyIcon(toolFamily(tool.toolName))}
              <span class="tool-name" title={tool.toolName}>{humanizeToolName(tool.toolName)}</span>
              <span class="tool-input">{tool.input ?? ''}</span>
              {#if tool.isError}
                <span class="tool-error-badge">error</span>
              {:else if tool.output}
                <span class="tool-ok" title="done">✓</span>
              {/if}
              {#if !tool.output && isStreaming}
                <span class="tool-spinner"></span>
              {/if}
              {#if tool.output}
                <span class="chip-chevron">{expandedToolIds.has(tool.toolId) ? '▾' : '▸'}</span>
              {/if}
            </button>
            {#if expandedToolIds.has(tool.toolId) && tool.output}
              <div class="tool-expanded">
                <div class="tool-expanded-head">
                  {@render familyIcon(toolFamily(tool.toolName))}
                  <span class="tool-raw-name">{tool.toolName}</span>
                </div>
                <pre class="tool-output">{formatToolOutput(tool.output)}</pre>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#snippet starButton()}
      <button
        type="button"
        class="msg-action-btn star-btn"
        class:starred={isStarredByMe(message.id)}
        onclick={(e) => { e.stopPropagation(); toggleMyStar(message.id); }}
        title={isStarredByMe(message.id) ? 'Unstar' : 'Star this message'}
        aria-label={isStarredByMe(message.id) ? 'Unstar message' : 'Star message'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={isStarredByMe(message.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </button>
    {/snippet}

    {#if !isDeleted && groupedReactions().length > 0}
      <div class="reactions-row">
        {#if canReadAloud}
          <ReadAloudButton state={readAloud.state} onclick={() => readAloud.toggle()} />
        {/if}
        <ReactionChips reactions={groupedReactions()} ontoggle={toggleReaction} />
        <ReactionPicker onpick={pickEmoji} />
        {@render starButton()}
      </div>
    {:else if !isDeleted && !isStreaming}
      <div class="reactions-row reactions-hover-only">
        {#if canReadAloud}
          <ReadAloudButton state={readAloud.state} onclick={() => readAloud.toggle()} />
        {/if}
        <ReactionPicker onpick={pickEmoji} />
        {@render starButton()}
        <!-- Message actions -->
        {#if message.role === 'user'}
          <button class="msg-action-btn" onclick={actions.openEditModal} title="Edit" disabled={actions.actionPending}>✏️</button>
          <button class="msg-action-btn destructive" onclick={() => (actions.showDeleteConfirm = true)} title="Delete" disabled={actions.actionPending}>🗑️</button>
        {:else if message.role === 'companion'}
          <button class="msg-action-btn" onclick={actions.previewRegenerate} title="Regenerate" disabled={actions.actionPending}>🔄</button>
          <button class="msg-action-btn destructive" onclick={() => (actions.showDeleteConfirm = true)} title="Delete" disabled={actions.actionPending}>🗑️</button>
        {/if}
      </div>
    {/if}

    {#if readStatus() && message.role === 'user'}
      <div class="read-status">
        {#if readStatus() === 'read'}
          <span class="check read" title="Read">&#10003;&#10003;</span>
        {:else if readStatus() === 'delivered'}
          <span class="check" title="Delivered">&#10003;&#10003;</span>
        {:else}
          <span class="check" title="Sent">&#10003;</span>
        {/if}
      </div>
    {/if}
  </article>
{/if}

<MessageActionModals {actions} />

<style>
  .message-system {
    display: flex;
    justify-content: center;
    margin: 1rem 0;
  }

  /* Discord community sender — ported from reference implementation, byte-light theme vars.
     First-initial avatar chip + sender name in the bubble header. */
  .discord-avatar {
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-weight: 600;
    font-size: 0.8rem;
    background: var(--bg-tertiary);
    color: var(--accent);
    border: 1px solid var(--border);
    text-transform: uppercase;
  }

  .discord-name {
    font-weight: 600;
    color: var(--accent);
    font-size: 0.85rem;
  }

  .discord-tag {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  /* /subagents discovery card — ported from reference implementation (reference implementation), byte-light theme vars */
  .system-command-card {
    width: min(720px, calc(100vw - 3rem));
    padding: 1rem;
    border: 1px solid color-mix(in srgb, var(--border) 70%, var(--accent) 30%);
    border-radius: 0.75rem;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent) 8%), var(--bg-surface));
    color: var(--text-secondary);
    box-shadow: var(--shadow-sm), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .command-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.85rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  }

  .command-label {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--gold);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .command-card-header h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 650;
  }

  .command-count,
  .model-badge {
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 999px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    font-size: 0.72rem;
    line-height: 1;
    padding: 0.32rem 0.5rem;
  }

  .command-section {
    padding-top: 0.9rem;
  }

  .section-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.55rem;
  }

  .section-heading span {
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 650;
  }

  .section-heading small {
    color: var(--text-muted);
    font-size: 0.74rem;
  }

  .model-list,
  .preset-list,
  .example-list {
    display: grid;
    gap: 0.4rem;
  }

  .model-row,
  .preset-row {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    min-height: 2rem;
    padding: 0.35rem 0;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }

  .model-row:first-child,
  .preset-row:first-child {
    border-top: none;
  }

  .model-label,
  .preset-row strong {
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 600;
  }

  .model-row code,
  .preset-row code {
    min-width: 0;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-hover) 85%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: 0.35rem;
    padding: 0.18rem 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.77rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preset-row {
    grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  }

  .preset-row span {
    grid-column: 1 / -1;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .empty-presets {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.84rem;
    line-height: 1.5;
  }

  .examples-section {
    margin-top: 0.15rem;
    padding-top: 0.85rem;
    border-top: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  }

  .example-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .example-list span {
    border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
    border-radius: 0.5rem;
    padding: 0.55rem 0.6rem;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 45%, transparent);
    font-size: 0.78rem;
    line-height: 1.35;
  }

  :global(.canvas-ref-inline) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.5rem;
    border-radius: 0.75rem;
    background: var(--bg-tertiary, #1a1428);
    border: 1px solid var(--accent, #9b72cf);
    color: var(--accent, #9b72cf);
    font-size: 0.8rem;
    font-family: var(--font-heading, 'Cinzel', serif);
    letter-spacing: 0.03em;
    white-space: nowrap;
    vertical-align: middle;
  }

  .system-text {
    font-size: 0.875rem;
    color: var(--text-muted);
    background: var(--bg-surface);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.5rem 0;
    padding: 1rem 1.25rem;
    position: relative;
    max-width: 100%;
    overflow-wrap: break-word;
  }

  .message.companion {
    align-self: flex-start;
    max-width: 90%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 1.25rem;
    border-top-left-radius: 0.4rem;
    box-shadow: var(--shadow-sm);
  }

  .message.user {
    align-self: flex-end;
    max-width: 85%;
    background: var(--user-bg, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: 1.25rem;
    border-top-right-radius: 0.4rem;
    box-shadow: var(--shadow-sm);
  }

  /* Bare image / sticker — drop the bubble; the media keeps its own corners */
  .message.media-only {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0.25rem 0;
  }

  .message.deleted {
    opacity: 0.6;
  }

  /* ── Per-companion speaker bubbles (🔷 Companion A / 🔶 Companion B / ✨ fallback) ──
     Ported from reference implementation's speaker rows, adapted to byte-light theme tokens.
     The outer companion bubble drops its chrome; each speaker row carries its
     own bubble next to its avatar. (Their full rails/ghost overhaul is NOT
     ported — our left-anchored column has no right-side avatar gutter.) */
  .message.companion.split {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0.25rem 0;
  }

  .speaker-stack {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  /* Thought-only turns: when a turn is entirely tool/thought chips and the
     text segment is empty, the text container renders with no children.
     Left standing it reserves the flex-column gap height, leaving a large
     empty gap above the chips. Collapse the empty container so nothing is
     reserved. Scoped to the split layout so no other message type shifts;
     the .message gap/padding is untouched.
     NB: the task's candidate `.message.split .message-content:empty` does NOT
     fire — in every split path .message-content wraps a .speaker-stack node,
     so it is never truly :empty. The genuinely-empty node is the
     .speaker-stack itself (no chip/text rows, e.g. a thought-only turn with
     inline tools hidden), so that is what we collapse. The
     .message-content:empty guard is kept as harmless defense for any future
     path that leaves the content node truly empty. */
  .message.split .speaker-stack:empty,
  .message.split .message-content:empty {
    display: none;
  }

  .speaker-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .row-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Companion-face ring — unified to the picker/editor chip ring ("the GOOD
     one"): a 2px solid accent halo. Was a thinner 1px blended ring that read
     washed-out on the larger 2.6rem bubble avatars; the operator wanted the
     same ring weight wherever a face appears. */
  .avatar-ring {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: flex-start;
    border-radius: 50%;
    padding: 2px;
    background: var(--accent);
    margin-top: 0.15rem;
  }

  .speaker-avatar {
    width: 2.6rem;
    height: 2.6rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    border-radius: 50%;
    background: var(--bg-surface);
  }

  .speaker-avatar-img {
    width: 2.6rem;
    height: 2.6rem;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .speaker-name {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 0.15rem;
    line-height: 1.1;
    width: fit-content;
    color: var(--text-muted);
  }

  .sn-name {
    color: var(--accent);
  }

  /* Bubble chrome only under the split layout — for user/media rows the
     .bubble class is inert so those paths keep their existing look. The top
     left corner stays pointier: the "tail" toward the avatar. */
  .message.companion.split .bubble {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 1.1rem;
    border-top-left-radius: 0.3rem;
    padding: 0.6rem 0.9rem;
    box-shadow: var(--shadow-sm);
    overflow-wrap: break-word;
    /* Clip children to the rounded boundary: an inline .canvas-ref-inline
       link chip carries its own accent border which otherwise escaped the
       bubble's border-radius at the corners. Nothing nested in the bubble is
       meant to overflow (reactions/actions render OUTSIDE, below the bubble). */
    overflow: hidden;
  }

  /* User split: same treatment mirrored — the outer article sheds its chrome
     and the inner bubble carries it, with the operator's avatar on the right edge. The
     pointier corner flips to the top RIGHT: the tail toward her avatar. */
  .message.user.split {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0.25rem 0;
  }

  .message.user.split .bubble {
    background: var(--user-bg, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: 1.1rem;
    border-top-right-radius: 0.3rem;
    padding: 0.6rem 0.9rem;
    box-shadow: var(--shadow-sm);
    overflow-wrap: break-word;
    /* Same as the companion split bubble: clip inline chips (canvas-ref link
       borders) to the rounded boundary. Reactions/actions live outside. */
    overflow: hidden;
  }

  .user-row .speaker-name {
    margin-left: auto;
  }

  /* Thinking/tool chips inside the interleaved speaker stack sit in the
     bubble column: indented past the avatar gutter (ring + row gap), no
     bubble chrome or avatar of their own. */
  .chip-row {
    margin-left: calc(2.6rem + 2px + 0.5rem);
  }

  @media (max-width: 768px) {
    .speaker-avatar,
    .speaker-avatar-img {
      width: 2.2rem;
      height: 2.2rem;
    }
    .speaker-avatar {
      font-size: 1.25rem;
    }
    .chip-row {
      margin-left: calc(2.2rem + 2px + 0.5rem);
    }
  }

  .message-header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.875rem;
  }

  .role {
    display: none;
  }

  .message.companion .role {
    display: none;
  }

  .message.user .role {
    display: none;
  }

  .time {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .message.companion .time {
    color: var(--text-muted);
  }

  .edited {
    color: var(--text-muted);
    font-size: 0.75rem;
    font-style: italic;
  }

  .tools-toggle {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: var(--font-mono);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .tools-toggle:hover {
    color: var(--gold-dim);
    border-color: var(--gold-dim);
  }

  .reply-preview {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
    padding: 0.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
  }

  .reply-bar {
    width: 2px;
    background: var(--gold-dim);
    border-radius: 1px;
    flex-shrink: 0;
  }

  .reply-content {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message-content {
    color: var(--text-primary);
    line-height: 1.5;
    word-wrap: break-word;
    overflow-wrap: break-word;
    min-width: 0;
  }

  .collapsed-long-message {
    position: relative;
  }

  .long-message-toggle {
    margin-top: 0.5rem;
    padding: 0.25rem 0.625rem;
    background: rgba(245, 197, 66, 0.08);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--gold-dim);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    cursor: pointer;
    transition: all 0.15s;
  }

  .long-message-toggle:hover {
    background: rgba(245, 197, 66, 0.14);
    border-color: var(--gold-dim);
    color: var(--gold);
  }

  /* Inline embedded gifs/images from URLs */
  .message-content :global(img[alt="gif"]) {
    max-width: min(320px, 100%);
    max-height: 240px;
    border-radius: var(--radius-sm);
    margin: 0.25rem 0;
    display: block;
  }

  /* Code copy button - imported from reference implementation */
  .message-content :global(.copy-btn) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.25rem 0.625rem;
    font-size: 0.6875rem;
    font-family: var(--font-body);
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-muted, #888);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.375rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
    z-index: 1;
  }

  .message-content :global(pre:hover .copy-btn) {
    opacity: 1;
  }

  .message-content :global(.copy-btn:hover) {
    background: rgba(255, 255, 255, 0.15);
    color: var(--text-primary, #e0e0e0);
  }

  .deleted-text {
    font-style: italic;
    color: var(--text-muted);
  }

  /* Tools panel */
  /* ─── Tool jewelry — compact, collapsible tool rows ─── */
  .tools-panel {
    margin-top: 0.5rem;
    padding: 0;
    background: transparent;
    border: none;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  /* Shared chip shell for inline tools, the tools panel, and thinking blocks */
  .inline-tool,
  .tool-entry,
  .thinking-block {
    display: flex;
    flex-direction: column;
    margin: 0.3rem 0;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.012));
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .tool-entry {
    margin: 0;
  }

  .inline-tool:hover,
  .tool-entry:hover,
  .thinking-block:hover {
    border-color: var(--border-hover);
  }

  .inline-tool.error,
  .tool-entry.error {
    border-color: rgba(239, 68, 68, 0.35);
    background: rgba(239, 68, 68, 0.05);
  }

  .tool-entry.error .tool-name {
    color: var(--error, var(--color-error));
  }

  /* Shared header row */
  .inline-tool-header,
  .tool-header,
  .thinking-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
  }

  .inline-tool-header:hover,
  .tool-header:hover,
  .thinking-header:hover {
    background: var(--bg-hover);
  }

  .inline-tool-header:disabled,
  .tool-header:disabled {
    cursor: default;
  }

  .inline-tool-header:disabled:hover,
  .tool-header:disabled:hover {
    background: transparent;
  }

  /* Left icon slot — shared by tools and thinking */
  .chip-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.05rem;
    color: var(--accent);
  }

  /* Right disclosure chevron — shared */
  .chip-chevron {
    flex: none;
    width: 0.85rem;
    text-align: center;
    font-size: 0.6rem;
    color: var(--text-muted);
  }

  .inline-tool .tool-name,
  .tool-entry .tool-name {
    /* Render the name at its natural width — a short name like "Bash" stays
       "Bash", never crushed to "B…" by a long input preview beside it. The
       max-width cap lets a very long MCP name (mcp__server__tool) still
       ellipsize rather than shove the status icon + chevron off the chip;
       .tool-input (flex: 1 1 auto) absorbs the squeeze. */
    flex: 0 0 auto;
    min-width: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .inline-tool .tool-input,
  .tool-entry .tool-input {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.7rem;
    opacity: 0.85;
  }

  .tool-ok {
    flex: none;
    color: var(--color-success, #22c55e);
    font-size: 0.72rem;
  }

  .tool-error-badge {
    flex: none;
    font-size: 0.56rem;
    color: var(--error, var(--color-error));
    background: rgba(239, 68, 68, 0.15);
    padding: 0.08rem 0.3rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tool-output {
    margin: 0;
    padding: 0.55rem 0.7rem;
    background: rgba(0, 0, 0, 0.28);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.68rem;
    line-height: 1.5;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Thinking blocks — reasoning label, italic to read as "thinking" */
  .thinking-summary {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-style: italic;
  }

  .thinking-content {
    margin: 0;
    padding: 0.55rem 0.7rem;
    background: rgba(0, 0, 0, 0.22);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.68rem;
    line-height: 1.5;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Thought-semantic kinds (reference implementation Slice 3). Kindless legacy blocks and
     provider telemetry keep the classic thinking look; authored reflection
     wears a badge; system notices read as neutral runtime seams (dashed,
     non-italic — they're byte-light speaking, not anyone thinking). */
  .thought-kind-badge {
    flex: none;
    font-size: 0.56rem;
    padding: 0.08rem 0.3rem;
    border-radius: 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .thought-kind-badge.authored {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border);
  }

  .thought-kind-badge.system {
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.05);
    border: 1px dashed var(--border);
  }

  .thinking-block[data-kind='system'] {
    border-style: dashed;
  }

  .thinking-block[data-kind='system'] .chip-icon {
    color: var(--text-muted);
  }

  .thinking-block[data-kind='system'] .thinking-summary {
    font-style: normal;
  }

  .tool-spinner {
    width: 0.625rem;
    height: 0.625rem;
    border: 1.5px solid var(--gold-dim);
    border-top-color: transparent;
    border-radius: 50%;
    animation: toolSpin 0.8s linear infinite;
    flex: none;
  }

  @keyframes toolSpin {
    to { transform: rotate(360deg); }
  }

  /* ─── Tool families (Slice 3 jewelry pass) ───
     Four muted jewel accents chosen to sit on the app's dark base (#09090b)
     next to the teal --accent without shouting. data-family sets a per-chip
     --fam var; the glyph, a thin left rule, and the running glow all read from
     it. Comms leans cooler-cyan so it reads distinct from the gold/teal
     --accent. These are component-scoped on purpose — no cross-fork imports. */
  .inline-tool[data-family='memory'],
  .tool-entry[data-family='memory']   { --fam: #a78bfa; } /* violet */
  .inline-tool[data-family='comms'],
  .tool-entry[data-family='comms']    { --fam: #4fd6c8; } /* teal */
  .inline-tool[data-family='creation'],
  .tool-entry[data-family='creation'] { --fam: #d8a24a; } /* warm amber */
  .inline-tool[data-family='system'],
  .tool-entry[data-family='system']   { --fam: #8b8f99; } /* cool smoke */

  /* Thin family rule down the left edge, low alpha so it's a hint not a stripe. */
  .inline-tool[data-family],
  .tool-entry[data-family] {
    box-shadow: inset 2px 0 0 -0.5px color-mix(in srgb, var(--fam) 42%, transparent);
  }

  /* Family glyph — silver-wire line icon (the operator's art direction, round 3). The
     inline SVG inherits `color: var(--fam)` so each icon glows its family
     accent — the tint the old emoji couldn't take. flex: none so it never
     nudges layout; the box is fixed so swapping families can't jump the chip.
     A hair of opacity keeps it calm in the hierarchy. */
  .family-glyph {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 1.05rem;
    line-height: 1;
    color: var(--fam, var(--text-muted));
    opacity: 0.9;
  }

  .family-glyph svg {
    display: block;
    width: 0.85rem;
    height: 0.85rem;
  }

  /* Breathing running glow — a candle in the family accent, not a strobe.
     Low amplitude, slow, alternating. Rests on the family left-rule so the two
     compose rather than fight. Stops the moment output lands (.running drops). */
  .inline-tool.running,
  .tool-entry.running {
    animation: toolBreathe 3s ease-in-out infinite alternate;
  }

  @keyframes toolBreathe {
    from {
      box-shadow:
        inset 2px 0 0 -0.5px color-mix(in srgb, var(--fam) 42%, transparent),
        0 0 0 0 color-mix(in srgb, var(--fam) 0%, transparent);
    }
    to {
      box-shadow:
        inset 2px 0 0 -0.5px color-mix(in srgb, var(--fam) 60%, transparent),
        0 0 7px 1px color-mix(in srgb, var(--fam) 22%, transparent);
    }
  }

  /* Reduced motion: hold a soft static glow instead of animating. */
  @media (prefers-reduced-motion: reduce) {
    .inline-tool.running,
    .tool-entry.running {
      animation: none;
      box-shadow:
        inset 2px 0 0 -0.5px color-mix(in srgb, var(--fam) 55%, transparent),
        0 0 6px 0 color-mix(in srgb, var(--fam) 16%, transparent);
    }
  }

  /* Expanded panel — raw-name header (mono, muted) above the output. The raw
     name lives here because mobile has no hover to reach the chip's title. */
  .tool-expanded {
    border-top: 1px solid var(--border);
    border-left: 2px solid color-mix(in srgb, var(--fam, var(--accent)) 38%, transparent);
  }

  .tool-expanded-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.7rem;
    background: rgba(0, 0, 0, 0.18);
  }

  .tool-expanded-head .family-glyph {
    width: auto;
  }

  /* Expanded header sits a touch larger so the wire reads at rest. */
  .tool-expanded-head .family-glyph svg {
    width: 0.95rem;
    height: 0.95rem;
  }

  .tool-raw-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    color: var(--text-muted);
  }

  /* Inside the expanded panel the output loses its own top border — the
     panel wrapper already draws the seam. */
  .tool-expanded .tool-output {
    border-top: none;
  }

  /* The shiver — surfaced-memory shimmer. Quiet enough to ignore at 2am,
     catchable at a glance. Theme vars only (identity quarantine). */
  .shimmer-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.05rem 0.4rem;
    margin-left: 0.35rem;
    background: transparent;
    border: 1px solid var(--gold-dim, var(--border));
    border-radius: 1rem;
    cursor: pointer;
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    color: var(--text-secondary);
    opacity: 0.72;
    transition: opacity 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  }
  .shimmer-chip:hover {
    opacity: 1;
    border-color: var(--gold, var(--accent));
    background: var(--gold-glow, var(--accent-muted));
  }
  .shimmer-chip[aria-expanded='true'] {
    opacity: 1;
    border-color: var(--gold, var(--accent));
  }
  .shimmer-chip.dejavu {
    opacity: 0.5;
    border-style: dashed;
    font-style: italic;
  }
  .shimmer-glint {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--gold, var(--accent));
    box-shadow: 0 0 5px 1px var(--gold-glow, var(--accent-muted));
    animation: shimmerPulse 3.2s ease-in-out infinite;
  }
  .shimmer-chip.dejavu .shimmer-glint {
    background: var(--text-muted);
    box-shadow: none;
    animation: shimmerPulse 4.5s ease-in-out infinite;
  }
  .shimmer-label { line-height: 1; }
  @keyframes shimmerPulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer-glint { animation: none; opacity: 0.8; }
  }

  .shimmer-panel {
    margin: 0.4rem 0 0.2rem;
    padding: 0.55rem 0.7rem;
    background: var(--bg-surface, var(--bg-secondary));
    border: 1px solid var(--border);
    border-left: 2px solid var(--gold, var(--accent));
    border-radius: var(--radius-sm, 6px);
    font-size: 0.78rem;
    color: var(--text-secondary);
  }
  .shimmer-panel.dejavu {
    border-left-color: var(--text-muted);
    font-style: italic;
    opacity: 0.85;
  }
  .shimmer-heading {
    margin: 0 0 0.4rem;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .shimmer-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .shimmer-item { display: flex; flex-direction: column; gap: 0.15rem; }
  .shimmer-excerpt { line-height: 1.4; color: var(--text-primary, var(--text-secondary)); }
  .shimmer-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-size: 0.66rem;
    color: var(--text-muted);
  }
  .shimmer-rel { color: var(--gold, var(--accent)); }
  .shimmer-dejavu-note {
    margin: 0.35rem 0 0;
    font-style: italic;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* Reactions */
  .reactions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.25rem;
  }

  .reactions-hover-only {
    opacity: 0;
    transition: opacity 0.15s;
  }

  .message:hover .reactions-hover-only {
    opacity: 1;
  }

  .read-status {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.125rem;
  }

  .check {
    font-size: 0.75rem;
    color: var(--text-muted);
    letter-spacing: -0.25em;
  }

  .check.read {
    color: var(--gold);
  }

  .markdown-content :global(p) {
    margin: 0.5rem 0;
  }

  .markdown-content :global(p:first-child) {
    margin-top: 0;
  }

  .markdown-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(code) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.875em;
  }

  .markdown-content :global(pre) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: 0.5rem 0;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown-content :global(a) {
    color: var(--gold);
    text-decoration: underline;
    text-decoration-color: var(--gold-dim);
  }

  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  .markdown-content :global(blockquote) {
    border-left: 2px solid var(--gold-dim);
    padding-left: 1rem;
    margin: 0.5rem 0;
    color: var(--text-secondary);
  }

  /* Discord-style -# subtext (ported from reference implementation) */
  .markdown-content :global(.md-subtext) {
    font-size: 0.8em;
    color: var(--text-secondary);
    line-height: 1.3;
  }

  /* Discord custom emoji + mention pills (ported from reference implementation) */
  .markdown-content :global(.discord-emoji) {
    width: 1.35em;
    height: 1.35em;
    vertical-align: text-bottom;
    object-fit: contain;
  }

  .markdown-content :global(.discord-mention) {
    color: var(--accent);
    background: var(--gold-glow);
    padding: 0 0.28em;
    border-radius: 0.28em;
    font-weight: 500;
  }

  /* Media: Image */
  .media-image {
    margin: 0.25rem 0;
  }

  .image-button {
    display: block;
    padding: 0;
    background: none;
    cursor: pointer;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .media-image img {
    max-width: 100%;
    max-height: 400px;
    border-radius: var(--radius-sm);
    display: block;
    object-fit: contain;
  }

  /* Media: images attached to a text message — one bubble, the pictures
     under the words. Two or more sit in a grid of square tiles. */
  .attachment-images {
    margin-top: 0.375rem;
  }

  .attachment-images img {
    max-width: 100%;
    max-height: 400px;
    border-radius: var(--radius-sm);
    display: block;
    object-fit: contain;
  }

  .attachment-images.multi {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25rem;
  }

  .attachment-images.multi img {
    width: 100%;
    aspect-ratio: 1;
    max-height: none;
    object-fit: cover;
  }

  .image-caption {
    margin-top: 0.375rem;
    max-width: 100%;
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-style: italic;
    line-height: 1.4;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .lightbox-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
  }

  .lightbox-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 1001;
    padding: 0.5rem;
    color: white;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 50%;
    transition: background 0.2s;
  }

  .lightbox-close:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  .lightbox img {
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    z-index: 1001;
    border-radius: var(--radius-sm);
  }

  /* Media: File */
  .media-file {
    margin: 0.25rem 0;
  }

  .file-link {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.15);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    text-decoration: none;
    transition: background 0.2s;
  }

  .file-link:hover {
    background: rgba(0, 0, 0, 0.25);
  }

  .file-link svg {
    flex-shrink: 0;
    color: var(--gold-dim);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    overflow: hidden;
  }

  .file-name {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .cursor {
    display: inline-block;
    animation: blink 1s infinite;
    color: var(--gold);
    margin-left: 0.125rem;
  }

  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  @media (max-width: 768px) {
    .message.user {
      max-width: 92%;
    }

    .message.companion {
      max-width: 95%;
    }

    .message {
      overflow: visible;
    }

    .message-content {
      overflow-x: hidden;
      overflow-y: visible;
    }

    .tool-output {
      max-width: calc(100vw - 4rem);
    }

    .markdown-content :global(pre) {
      max-width: calc(100vw - 4rem);
    }

    .tools-panel {
      max-width: calc(100vw - 4rem);
      overflow: hidden;
    }

    .reactions-row {
      flex-wrap: wrap;
    }

    .lightbox {
      padding: 0;
    }

    .lightbox-close {
      top: max(env(safe-area-inset-top, 0.5rem), 0.75rem);
      right: 0.75rem;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1002;
    }

    .lightbox img {
      max-width: 100vw;
      max-height: 100dvh;
      border-radius: 0;
    }
  }

  /* Sticker rendering - three sizes */
  .standalone-sticker {
    display: block;
    max-width: 180px;
    max-height: 180px;
    width: auto;
    height: auto;
    object-fit: contain;
  }

  .message-content :global(.block-sticker) {
    display: block;
    max-width: 128px;
    max-height: 128px;
    width: auto;
    height: auto;
    object-fit: contain;
    margin: 0.25rem 0;
  }

  .message-content :global(.inline-sticker) {
    display: inline;
    max-width: 64px;
    max-height: 64px;
    width: auto;
    height: auto;
    object-fit: contain;
    vertical-align: middle;
  }

  /* Message action buttons */
  .msg-action-btn {
    background: transparent;
    border: none;
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s;
    border-radius: 0.25rem;
  }

  .msg-action-btn:hover {
    opacity: 1;
    background: var(--surface-hover, rgba(255,255,255,0.05));
  }

  .msg-action-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .msg-action-btn.destructive:hover {
    background: rgba(239, 68, 68, 0.15);
  }

  /* Star button — filled + accent-colored when starred by the human viewer. */
  .star-btn {
    display: inline-flex;
    align-items: center;
    color: var(--text-muted);
  }
  .star-btn.starred {
    opacity: 1;
    color: var(--gold, var(--accent));
  }
  .star-btn:hover {
    color: var(--accent);
  }
</style>
