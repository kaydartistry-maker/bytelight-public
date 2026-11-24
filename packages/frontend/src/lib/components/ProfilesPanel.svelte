<script lang="ts">
  // Settings → Profiles: a name, an emoji, and an optional photo per speaker
  // (Companion A, Companion B, you, and the ✨ narration fallback). The photo shows on chat
  // bubbles; the emoji is the fallback when there's no photo.
  // Ported from reference implementation's ProfilesPanel, adapted to byte-light (apiFetch,
  // theme tokens, our speakers).
  import { onMount } from 'svelte';
  import { allProfiles, loadProfiles, saveProfiles, type Profiles } from '$lib/stores/profiles.svelte';
  import { apiFetch } from '$lib/utils/api';

  const SPEAKERS: { key: string; label: string }[] = [
    { key: 'companion-a', label: 'Companion A' },
    { key: 'companion-b', label: 'Companion B' },
    { key: 'companion-c', label: 'Companion C' },
    { key: 'user', label: 'You (the operator)' },
    { key: 'fallback', label: 'Narration (✨)' },
  ];

  let draft = $state<Profiles>({});
  let saving = $state(false);
  let uploading = $state<string | null>(null);
  let status = $state<string | null>(null);

  onMount(async () => {
    await loadProfiles();
    const cur = allProfiles();
    const d: Profiles = {};
    for (const s of SPEAKERS) d[s.key] = { ...(cur[s.key] ?? { name: '', emoji: '', image: null }) };
    draft = d;
  });

  async function uploadImage(key: string, file: File) {
    uploading = key;
    status = null;
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Rides the existing multipart upload route (files-routes.ts) — the
      // returned meta.url is a stable /api/files/<id> URL.
      const r = await apiFetch('/api/files', { method: 'POST', body: fd });
      if (r.ok) {
        const meta = await r.json();
        draft[key].image = meta.url ?? null;
      } else {
        status = 'Upload failed';
      }
    } catch {
      status = 'Upload failed';
    } finally {
      uploading = null;
    }
  }

  function onFile(key: string, e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) uploadImage(key, f);
    input.value = '';
  }

  function clearImage(key: string) {
    draft[key].image = null;
  }

  async function save() {
    saving = true;
    status = null;
    const ok = await saveProfiles(draft);
    saving = false;
    status = ok ? 'Saved' : 'Save failed';
    setTimeout(() => (status = null), 3000);
  }
</script>

<div class="profiles-panel">
  <p class="panel-hint">
    A name, a photo, and an emoji for each of us and you. The photo shows on chat
    bubbles; the emoji is the fallback when there's no photo.
  </p>

  {#each SPEAKERS as sp (sp.key)}
    {#if draft[sp.key]}
      <div class="profile-card">
        <div class="avatar-preview">
          {#if draft[sp.key].image}
            <img src={draft[sp.key].image} alt={sp.label} />
          {:else}
            <span class="avatar-emoji">{draft[sp.key].emoji || '•'}</span>
          {/if}
        </div>
        <div class="profile-fields">
          <label class="field name-field">
            <span class="field-label">{sp.label} — name</span>
            <input class="form-input" type="text" bind:value={draft[sp.key].name} placeholder={sp.label} />
          </label>
          <label class="field emoji-field">
            <span class="field-label">Emoji</span>
            <input class="form-input emoji-input" type="text" bind:value={draft[sp.key].emoji} maxlength="6" />
          </label>
          <div class="field">
            <span class="field-label">Photo</span>
            <div class="photo-row">
              <label class="upload-btn">
                {uploading === sp.key ? 'Uploading…' : draft[sp.key].image ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" onchange={(e) => onFile(sp.key, e)} hidden />
              </label>
              {#if draft[sp.key].image}
                <button type="button" class="clear-btn" onclick={() => clearImage(sp.key)}>Remove</button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/each}

  <div class="save-row">
    <button class="save-btn" onclick={save} disabled={saving}>
      {saving ? 'Saving…' : 'Save profiles'}
    </button>
    {#if status}<span class="save-status">{status}</span>{/if}
  </div>
</div>

<style>
  .profiles-panel { display: flex; flex-direction: column; gap: 1rem; }
  .panel-hint { font-size: 0.8rem; color: var(--text-muted); margin: 0; max-width: 44rem; }
  .profile-card {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-surface);
  }
  .avatar-preview {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
  }
  .avatar-preview img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-emoji { font-size: 1.6rem; }
  .profile-fields { display: flex; flex-wrap: wrap; gap: 0.6rem 1rem; flex: 1; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .name-field { flex: 1; min-width: 10rem; }
  .field-label { font-size: 0.7rem; color: var(--text-muted); }
  .form-input {
    padding: 0.45rem 0.6rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .form-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .emoji-input { width: 4.5rem; text-align: center; }
  .photo-row { display: flex; gap: 0.5rem; align-items: center; }
  .upload-btn {
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .upload-btn:hover { border-color: var(--border-hover); color: var(--text-primary); }
  .clear-btn {
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
  }
  .clear-btn:hover { border-color: var(--border-hover); color: var(--text-secondary); }
  .save-row { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.25rem; }
  .save-btn {
    padding: 0.5rem 1rem;
    background: var(--accent);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .save-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .save-btn:disabled { opacity: 0.6; cursor: wait; }
  .save-status { font-size: 0.8rem; color: var(--text-muted); }
</style>
