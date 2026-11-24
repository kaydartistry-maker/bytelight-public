<script lang="ts">
  let { onselect }: {
    onselect?: (emoji: string) => void;
  } = $props();

  let open = $state(false);
  let activeCategory = $state('smileys');
  let searchQuery = $state('');
  let searchInput: HTMLInputElement;
  let pickerEl: HTMLDivElement;

  const categories: Record<string, { label: string; icon: string; emojis: string[] }> = {
    smileys: {
      label: 'Smileys',
      icon: '😊',
      emojis: [
        '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊',
        '😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋',
        '😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫',
        '🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒',
        '🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒',
        '🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🥳','🥸',
        '😎','🤓','🧐','😕','🫤','😟','🙁','😮','😯','😲',
        '😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭',
        '😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡',
        '😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺',
      ],
    },
    hearts: {
      label: 'Hearts',
      icon: '❤️',
      emojis: [
        '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔',
        '❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝',
        '♥️','🫶','💋','💏','💑','🥰','😍','😘','😻',
      ],
    },
    hands: {
      label: 'Hands',
      icon: '👋',
      emojis: [
        '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌',
        '🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉',
        '👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛',
        '🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','💪','🫂',
      ],
    },
    animals: {
      label: 'Animals',
      icon: '🐱',
      emojis: [
        '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
        '🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆',
        '🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛',
        '🦋','🐌','🐞','🐜','🪳','🦂','🐢','🐍','🦎','🦖',
        '🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳',
        '🐋','🦈','🐊','🐆','🐅','🐃','🦬','🐂','🐄','🫎',
      ],
    },
    food: {
      label: 'Food',
      icon: '🍕',
      emojis: [
        '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈',
        '🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🌶️',
        '🫑','🥒','🥬','🥦','🧄','🧅','🍄','🥜','🫘','🌰',
        '🍞','🥐','🥖','🫓','🥨','🥯','🥞','🧇','🧀','🍖',
        '🍗','🥩','🌭','🍔','🍟','🍕','🫔','🌮','🌯','🫔',
        '🥗','🍿','🧈','🥚','🍳','🧆','🥘','🍲','🫕','🥣',
      ],
    },
    objects: {
      label: 'Objects',
      icon: '🔥',
      emojis: [
        '🔥','💫','⭐','🌟','✨','⚡','💥','🎉','🎊','🎈',
        '🎯','🏆','🎵','🎶','🎤','🎧','🎸','🎹','🥁','🎮',
        '🔷','🔮','🧿','🪄','🎭','🎨','🖤','💎','💰','💸',
        '📱','💻','🖥️','📷','📸','🔔','🕯️','💡','📚','📖',
        '✏️','🖊️','📌','📎','🔑','🗝️','🔒','🔓','🛡️','⚔️',
        '🪦','⚰️','🚬','💊','🩹','🩺','🔬','🔭','🧲','🪜',
      ],
    },
    flags: {
      label: 'Symbols',
      icon: '💯',
      emojis: [
        '💯','💢','💬','👁️‍🗨️','🗨️','💭','💤','💮','♨️','💈',
        '🛑','🕛','🕐','🕑','🕒','✅','❌','❓','❗','‼️',
        '⁉️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤',
        '🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🏳️','🏴',
        '🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🚩',
      ],
    },
  };

  const allEmojis = Object.entries(categories).flatMap(([_, cat]) =>
    cat.emojis.map(e => ({ emoji: e, category: cat.label }))
  );

  let visibleEmojis = $derived(
    searchQuery.trim()
      ? allEmojis.filter(e => e.emoji.includes(searchQuery)).map(e => e.emoji)
      : categories[activeCategory]?.emojis ?? []
  );

  function toggle() {
    open = !open;
    if (open) {
      searchQuery = '';
      activeCategory = 'smileys';
      setTimeout(() => searchInput?.focus(), 50);
    }
  }

  function close() {
    open = false;
  }

  function select(emoji: string) {
    onselect?.(emoji);
  }

  function handleClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      close();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  $effect(() => {
    if (open) {
      document.addEventListener('click', handleClickOutside, true);
      return () => document.removeEventListener('click', handleClickOutside, true);
    }
  });
</script>

<div class="emoji-picker-wrapper" bind:this={pickerEl}>
  <button
    class="emoji-button"
    class:active={open}
    onclick={(e) => { e.stopPropagation(); toggle(); }}
    aria-label="Insert emoji"
    title="Insert emoji"
  >
    <span class="emoji-icon">😊</span>
  </button>

  {#if open}
    <div class="emoji-panel" onkeydown={handleKeydown}>
      <div class="emoji-search">
        <input
          bind:this={searchInput}
          bind:value={searchQuery}
          placeholder="Search emoji..."
          type="text"
        />
      </div>

      {#if !searchQuery.trim()}
        <div class="emoji-categories">
          {#each Object.entries(categories) as [key, cat]}
            <button
              class="category-tab"
              class:active={activeCategory === key}
              onclick={() => { activeCategory = key; }}
              title={cat.label}
            >
              {cat.icon}
            </button>
          {/each}
        </div>
      {/if}

      <div class="emoji-grid">
        {#each visibleEmojis as emoji}
          <button
            class="emoji-item"
            onclick={() => select(emoji)}
            title={emoji}
          >
            {emoji}
          </button>
        {/each}
        {#if visibleEmojis.length === 0}
          <div class="emoji-empty">No emoji found</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .emoji-picker-wrapper {
    position: relative;
  }

  .emoji-button {
    padding: 0.5rem;
    color: var(--text-muted);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .emoji-button:hover, .emoji-button.active {
    background: var(--gold-ember);
  }

  .emoji-icon {
    font-size: 1.125rem;
    line-height: 1;
  }

  .emoji-panel {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    width: 320px;
    max-height: 380px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 0.75rem);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 100;
  }

  .emoji-search {
    padding: 0.625rem;
    border-bottom: 1px solid var(--border);
  }

  .emoji-search input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 0.875rem;
  }

  .emoji-search input:focus {
    outline: none;
    border-color: var(--border-hover);
  }

  .emoji-search input::placeholder {
    color: var(--text-muted);
  }

  .emoji-categories {
    display: flex;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .category-tab {
    padding: 0.375rem;
    border-radius: var(--radius-sm, 0.25rem);
    font-size: 1.125rem;
    line-height: 1;
    opacity: 0.5;
    transition: opacity var(--transition-fast), background var(--transition-fast);
    flex-shrink: 0;
  }

  .category-tab:hover {
    opacity: 0.8;
    background: var(--gold-ember);
  }

  .category-tab.active {
    opacity: 1;
    background: var(--gold-ember);
  }

  .emoji-grid {
    flex: 1;
    overflow-y: auto;
    padding: 0.375rem;
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 0.125rem;
    min-height: 180px;
    max-height: 260px;
  }

  .emoji-item {
    padding: 0.375rem;
    border-radius: var(--radius-sm, 0.25rem);
    font-size: 1.25rem;
    line-height: 1;
    text-align: center;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .emoji-item:hover {
    background: var(--gold-ember);
  }

  .emoji-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  @media (max-width: 768px) {
    .emoji-panel {
      position: fixed;
      bottom: 4rem;
      left: 0.5rem;
      right: 0.5rem;
      width: auto;
      transform: none;
      max-height: 50vh;
      z-index: 200;
    }

    .emoji-grid {
      grid-template-columns: repeat(7, 1fr);
      max-height: 40vh;
    }
  }
</style>
