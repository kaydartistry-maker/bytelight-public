<script lang="ts">
  import type { StickerPack, Sticker } from '@bytelight/shared';
  import { refreshStickers } from '$lib/stores/stickers.svelte';
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';

  let packs = $state<StickerPack[]>([]);
  let stickers = $state<Record<string, Sticker[]>>({});
  let loading = $state(true);
  let expandedPack = $state<string | null>(null);
  let statusMessage = $state<string | null>(null);

  let showNewPack = $state(false);
  let newPackName = $state('');
  let newPackDesc = $state('');

  let uploading = $state(false);

  // Naming UX state - queue files for naming before upload
  let pendingFiles = $state<Array<{ file: File; packId: string }>>([]);
  let pendingStickerName = $state('');

  // Inline rename state
  let editingStickerId = $state<string | null>(null);
  let editStickerName = $state('');

  function notify(message: string) {
    statusMessage = message;
    setTimeout(() => statusMessage = null, 3000);
  }

  async function loadPacks() {
    loading = true;
    try {
      const res = await apiFetch('/api/sticker-packs');
      if (res.ok) {
        const data = await res.json();
        packs = data.packs || [];
      }
    } catch (err) {
      console.error('Failed to load sticker packs:', err);
    } finally {
      loading = false;
    }
  }

  async function loadStickersForPack(packId: string) {
    try {
      const res = await apiFetch(`/api/stickers?packId=${packId}`);
      if (res.ok) {
        const data = await res.json();
        stickers = { ...stickers, [packId]: data.stickers || [] };
      }
    } catch (err) {
      console.error('Failed to load stickers:', err);
    }
  }

  async function createPack() {
    const name = newPackName.trim();
    if (!name) return;
    try {
      const res = await apiFetch('/api/sticker-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: newPackDesc.trim() }),
      });
      if (res.ok) {
        notify(`Pack "${name}" created`);
        newPackName = '';
        newPackDesc = '';
        showNewPack = false;
        await loadPacks();
        refreshStickers();
      } else {
        const data = await res.json().catch(() => ({}));
        notify(data.error || 'Failed to create pack');
      }
    } catch {
      notify('Failed to create pack');
    }
  }

  async function deletePack(packId: string, packName: string) {
    if (!confirm(`Delete pack "${packName}" and all its stickers?`)) return;
    try {
      const res = await apiFetch(`/api/sticker-packs/${packId}`, { method: 'DELETE' });
      if (res.ok) {
        notify(`Pack "${packName}" deleted`);
        await loadPacks();
        refreshStickers();
      } else {
        notify('Failed to delete pack');
      }
    } catch {
      notify('Failed to delete pack');
    }
  }

  async function uploadSticker(packId: string, file: File, name: string) {
    uploading = true;
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('packId', packId);
      formData.append('name', name);
      const res = await apiFetch('/api/stickers', { method: 'POST', body: formData });
      if (res.ok) {
        notify(`Uploaded ${name}`);
        await loadStickersForPack(packId);
        refreshStickers();
      } else {
        const data = await res.json().catch(() => ({}));
        notify(data.error || 'Failed to upload');
      }
    } catch {
      notify('Failed to upload sticker');
    } finally {
      uploading = false;
    }
  }

  async function deleteSticker(stickerId: string, stickerName: string, packId: string) {
    if (!confirm(`Delete sticker "${stickerName}"?`)) return;
    try {
      const res = await apiFetch(`/api/stickers/${stickerId}`, { method: 'DELETE' });
      if (res.ok) {
        notify(`Deleted ${stickerName}`);
        await loadStickersForPack(packId);
        refreshStickers();
      } else {
        notify('Failed to delete sticker');
      }
    } catch {
      notify('Failed to delete sticker');
    }
  }

  function togglePack(packId: string) {
    if (expandedPack === packId) {
      expandedPack = null;
    } else {
      expandedPack = packId;
      if (!stickers[packId]) loadStickersForPack(packId);
    }
  }

  function handleFileInput(packId: string, e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    const queue: Array<{ file: File; packId: string }> = [];
    for (const file of files) {
      if (file.type !== 'image/png' && file.type !== 'image/webp') {
        notify('Only PNG and WebP files allowed');
        continue;
      }
      queue.push({ file, packId });
    }
    input.value = '';
    if (queue.length > 0) {
      pendingFiles = queue;
      const first = queue[0].file.name.replace(/\.\w+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      pendingStickerName = first === 'image' || first.length < 2 ? '' : first;
    }
  }

  async function confirmPendingUpload() {
    const name = pendingStickerName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!name || pendingFiles.length === 0) return;
    const { file, packId } = pendingFiles[0];
    await uploadSticker(packId, file, name);
    pendingFiles = pendingFiles.slice(1);
    if (pendingFiles.length > 0) {
      const next = pendingFiles[0].file.name.replace(/\.\w+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      pendingStickerName = next === 'image' || next.length < 2 ? '' : next;
    } else {
      pendingStickerName = '';
    }
  }

  function cancelPendingUpload() {
    pendingFiles = [];
    pendingStickerName = '';
  }

  // Inline sticker rename
  function startEditSticker(sticker: { id: string; name: string }) {
    editingStickerId = sticker.id;
    editStickerName = sticker.name;
  }

  function cancelEditSticker() {
    editingStickerId = null;
    editStickerName = '';
  }

  async function saveStickerEdit(stickerId: string, packId: string) {
    const name = editStickerName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!name) return;
    try {
      const res = await apiFetch(`/api/stickers/${stickerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        notify(`Renamed to ${name}`);
        await loadStickersForPack(packId);
        refreshStickers();
        cancelEditSticker();
      } else {
        notify('Failed to rename sticker');
      }
    } catch {
      notify('Failed to rename sticker');
    }
  }

  onMount(() => {
    loadPacks();
  });
</script>

<div class="sm">
  <div class="sm-header">
    <h3 class="sm-title">Sticker Packs</h3>
    <button class="res-btn res-btn--primary res-btn--sm" onclick={() => showNewPack = !showNewPack}>
      {showNewPack ? 'Cancel' : '+ New Pack'}
    </button>
  </div>

  {#if statusMessage}
    <div class="sm-status">{statusMessage}</div>
  {/if}

  {#if showNewPack}
    <div class="sm-new-pack">
      <input
        type="text"
        class="sm-input"
        placeholder="Pack name"
        bind:value={newPackName}
      />
      <input
        type="text"
        class="sm-input"
        placeholder="Description (optional)"
        bind:value={newPackDesc}
      />
      <button class="res-btn res-btn--primary res-btn--sm" onclick={createPack} disabled={!newPackName.trim()}>
        Create Pack
      </button>
    </div>
  {/if}

  {#if loading}
    <p class="sm-loading">Loading packs...</p>
  {:else if packs.length === 0}
    <p class="sm-empty">No sticker packs yet. Create one above!</p>
  {:else}
    <div class="sm-packs">
      {#each packs as pack (pack.id)}
        <div class="sm-pack">
          <button class="sm-pack-header" onclick={() => togglePack(pack.id)}>
            <span class="sm-pack-name">{pack.name}</span>
            <span class="sm-pack-chevron" class:open={expandedPack === pack.id}>&#9656;</span>
          </button>

          {#if expandedPack === pack.id}
            <div class="sm-pack-content">
              {#if pack.description}
                <p class="sm-pack-desc">{pack.description}</p>
              {/if}

              <div class="sm-stickers-grid">
                {#if stickers[pack.id]}
                  {#each stickers[pack.id] as sticker (sticker.id)}
                    <div class="sm-sticker">
                      <img src={sticker.url} alt={sticker.name} />
                      <div class="sm-sticker-info">
                        {#if editingStickerId === sticker.id}
                          <input
                            type="text"
                            class="sm-input sm-sticker-rename"
                            bind:value={editStickerName}
                            onkeydown={(e) => { if (e.key === 'Enter') saveStickerEdit(sticker.id, pack.id); if (e.key === 'Escape') cancelEditSticker(); }}
                          />
                          <button class="sm-btn-icon" onclick={() => saveStickerEdit(sticker.id, pack.id)} title="Save">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          </button>
                          <button class="sm-btn-icon" onclick={cancelEditSticker} title="Cancel">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                          </button>
                        {:else}
                          <span class="sm-sticker-name">:{pack.name}_{sticker.name}:</span>
                          <button class="sm-btn-icon" onclick={() => startEditSticker(sticker)} title="Rename">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/>
                            </svg>
                          </button>
                          <button class="sm-btn-icon sm-btn-danger" onclick={() => deleteSticker(sticker.id, sticker.name, pack.id)} title="Delete">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                {:else}
                  <p class="sm-loading">Loading...</p>
                {/if}
              </div>

              <div class="sm-pack-actions">
                <label class="res-btn res-btn--ghost res-btn--sm">
                  {uploading ? 'Uploading...' : '+ Upload Sticker'}
                  <input
                    type="file"
                    accept=".png,.webp,image/png,image/webp"
                    multiple
                    onchange={(e) => handleFileInput(pack.id, e)}
                    disabled={uploading}
                    hidden
                  />
                </label>
                <button class="res-btn res-btn--danger res-btn--sm" onclick={() => deletePack(pack.id, pack.name)}>
                  Delete Pack
                </button>
              </div>

              {#if pendingFiles.length > 0 && pendingFiles[0].packId === pack.id}
                <div class="sm-name-dialog">
                  <img src={URL.createObjectURL(pendingFiles[0].file)} alt="preview" class="sm-name-preview" />
                  <div class="sm-name-form">
                    <span class="sm-name-label">Name this sticker ({pendingFiles.length} remaining)</span>
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      type="text"
                      class="sm-input"
                      bind:value={pendingStickerName}
                      placeholder="e.g. wink, heart..."
                      autofocus
                      onkeydown={(e) => { if (e.key === 'Enter') confirmPendingUpload(); if (e.key === 'Escape') cancelPendingUpload(); }}
                    />
                    <div class="sm-name-actions">
                      <button class="res-btn res-btn--primary res-btn--sm" onclick={confirmPendingUpload} disabled={!pendingStickerName.trim() || uploading}>
                        {uploading ? 'Uploading...' : 'Upload'}
                      </button>
                      <button class="res-btn res-btn--ghost res-btn--sm" onclick={cancelPendingUpload}>Cancel</button>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sm { padding: 1rem 0; }
  .sm-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .sm-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .sm-status {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.5rem;
    margin-bottom: 0.75rem;
    font-size: 0.8rem;
    color: var(--gold);
  }
  .sm-new-pack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: var(--bg-surface);
    border-radius: 0.5rem;
  }
  .sm-input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.5rem;
    color: var(--text-primary);
    font-size: 0.8rem;
  }
  .sm-input:focus { border-color: var(--gold-dim); outline: none; }
  .sm-loading, .sm-empty {
    color: var(--text-muted);
    font-size: 0.8rem;
    text-align: center;
    padding: 1rem;
  }
  .sm-packs { display: flex; flex-direction: column; gap: 0.5rem; }
  .sm-pack {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .sm-pack-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: transparent;
    color: var(--text-primary);
    font-weight: 500;
    cursor: pointer;
  }
  .sm-pack-header:hover { background: var(--bg-hover); }
  .sm-pack-chevron {
    transition: transform 0.15s ease;
    color: var(--text-muted);
  }
  .sm-pack-chevron.open { transform: rotate(90deg); }
  .sm-pack-content {
    padding: 0.75rem;
    border-top: 1px solid var(--border);
  }
  .sm-pack-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }
  .sm-stickers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .sm-sticker {
    position: relative;
    aspect-ratio: 1;
    background: var(--bg-input);
    border-radius: 0.375rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.25rem;
  }
  .sm-sticker img {
    width: 100%;
    height: 70%;
    object-fit: contain;
  }
  .sm-sticker-name {
    font-size: 0.6rem;
    color: var(--text-muted);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }
  .sm-pack-actions {
    display: flex;
    gap: 0.5rem;
  }

  /* Naming dialog for upload */
  .sm-name-dialog {
    display: flex;
    gap: 0.75rem;
    padding: 0.75rem;
    margin-top: 0.75rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--gold-dim);
    border-radius: 0.5rem;
  }
  .sm-name-preview {
    width: 64px;
    height: 64px;
    object-fit: contain;
    border-radius: 0.375rem;
    background: var(--bg-input);
  }
  .sm-name-form {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sm-name-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }
  .sm-name-actions {
    display: flex;
    gap: 0.5rem;
  }
  /* Sticker info with rename */
  .sm-sticker-info {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }
  .sm-sticker-rename {
    flex: 1;
    font-size: 0.7rem;
    padding: 0.25rem 0.35rem;
  }
  .sm-btn-icon {
    padding: 0.25rem;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 0.25rem;
  }
  .sm-btn-icon:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .sm-btn-danger:hover { color: var(--color-error); }
</style>
