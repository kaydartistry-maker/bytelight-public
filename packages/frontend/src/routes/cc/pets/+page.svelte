<script lang="ts">
  import { apiFetch } from '$lib/utils/api';
  import { onMount } from 'svelte';
  import '../../../bytelight.css';
  import CcPageHeader from '$lib/components/CcPageHeader.svelte';
  import ResEmpty from '$lib/components/ResEmpty.svelte';
  import ResSkeleton from '$lib/components/ResSkeleton.svelte';
  import { CC_API } from '$lib/utils/cc';

  let pets = $state<any[]>([]);
  let upcoming = $state<any[]>([]);
  let loading = $state(true);
  let showAdd = $state(false);
  let editingPet = $state<string | null>(null);
  let newName = $state(''); let newSpecies = $state(''); let newBreed = $state(''); let newBirthday = $state(''); let newWeight = $state(''); let newNotes = $state('');

  async function load() {
    try {
      const [pRes, uRes] = await Promise.all([apiFetch(`${CC_API}/pets`), apiFetch(`${CC_API}/pets/upcoming?days=14`)]);
      const pData = await pRes.json(); const uData = await uRes.json();
      pets = pData.pets || []; upcoming = uData.items || [];
    } catch { /* empty state handles */ }
    loading = false;
  }

  async function addPet() {
    if (!newName.trim()) return;
    await apiFetch(`${CC_API}/pets`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), species: newSpecies || undefined, breed: newBreed || undefined, birthday: newBirthday || undefined }) });
    newName = ''; newSpecies = ''; newBreed = ''; newBirthday = ''; showAdd = false; await load();
  }

  async function markGiven(item: any) {
    await apiFetch(`${CC_API}/pets/medications/given`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ med_name: item.name, pet_name: item.pet }) });
    await load();
  }

  function startEdit(pet: any) {
    editingPet = pet.id;
    newName = pet.name; newSpecies = pet.species || ''; newBreed = pet.breed || '';
    newBirthday = pet.birthday || ''; newWeight = pet.weight || ''; newNotes = pet.notes || '';
  }

  async function savePetEdit() {
    if (!editingPet || !newName.trim()) return;
    await apiFetch(`${CC_API}/pets/${editingPet}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), species: newSpecies || undefined, breed: newBreed || undefined, birthday: newBirthday || undefined, weight: newWeight || undefined, notes: newNotes || undefined }),
    });
    editingPet = null; newName = ''; newSpecies = ''; newBreed = ''; newBirthday = ''; newWeight = ''; newNotes = '';
    await load();
  }

  function cancelEdit() {
    editingPet = null; newName = ''; newSpecies = ''; newBreed = ''; newBirthday = ''; newWeight = ''; newNotes = '';
  }

  function petAge(birthday: string): string {
    if (!birthday) return '';
    const years = Math.floor((Date.now() - new Date(birthday).getTime()) / (365.25 * 86400000));
    return years > 0 ? `${years}y` : '<1y';
  }

  onMount(load);
</script>

<main class="res-page">
  <CcPageHeader title="Pets" />

  <div class="res-content">
    {#if loading}
      <ResSkeleton variant="list" rows={4} />
    {:else}
      {#if upcoming.length > 0}
        <div class="res-card" class:res-card--danger={upcoming.some(u => u.overdue)}>
          <span class="res-section-title">Upcoming care</span>
          {#each upcoming as item}
            <div class="care-row" class:overdue={item.overdue}>
              <div class="care-info">
                <strong>{item.pet}</strong>
                <span class="care-detail">{item.name} ({item.type === 'medication' ? item.frequency : item.event_type})</span>
                <span class="care-due" class:overdue={item.overdue}>{item.overdue ? 'Overdue' : item.isToday ? 'Today' : item.due}</span>
              </div>
              {#if item.type === 'medication'}
                <button class="res-btn res-btn--primary" style="padding: 0 var(--space-4);" onclick={() => markGiven(item)}>Done</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="res-section-header">
        <span class="res-section-title" style="margin: 0;">Pets</span>
        <button class="res-btn res-btn--icon" onclick={() => showAdd = !showAdd} aria-label="Add pet">+</button>
      </div>

      {#if showAdd}
        <form class="res-form" onsubmit={(e) => { e.preventDefault(); addPet(); }}>
          <input type="text" bind:value={newName} placeholder="Pet name" class="res-input" />
          <div class="res-form-row">
            <input type="text" bind:value={newSpecies} placeholder="Species" class="res-input" />
            <input type="text" bind:value={newBreed} placeholder="Breed" class="res-input" />
          </div>
          <div class="res-form-row">
            <input type="date" bind:value={newBirthday} class="res-input" />
            <button type="submit" class="res-btn res-btn--primary">Add</button>
          </div>
        </form>
      {/if}

      {#if pets.length === 0}
        <ResEmpty message="No pets added yet" actionLabel="Add a pet" onaction={() => showAdd = true} />
      {:else}
        {#each pets as pet}
          <div class="res-card">
            {#if editingPet === pet.id}
              <form class="res-form" onsubmit={(e) => { e.preventDefault(); savePetEdit(); }}>
                <input type="text" bind:value={newName} placeholder="Name" class="res-input" />
                <div class="res-form-row">
                  <input type="text" bind:value={newSpecies} placeholder="Species" class="res-input" />
                  <input type="text" bind:value={newBreed} placeholder="Breed" class="res-input" />
                </div>
                <div class="res-form-row">
                  <input type="date" bind:value={newBirthday} class="res-input" />
                  <input type="text" bind:value={newWeight} placeholder="Weight" class="res-input" />
                </div>
                <input type="text" bind:value={newNotes} placeholder="Notes" class="res-input" />
                <div class="res-form-row">
                  <button type="submit" class="res-btn res-btn--primary">Save</button>
                  <button type="button" class="res-btn res-btn--ghost" onclick={cancelEdit}>Cancel</button>
                </div>
              </form>
            {:else}
              <div class="res-row res-row--between">
                <div class="pet-header">
                  <span class="pet-name">{pet.name}</span>
                  {#if pet.birthday}<span class="pet-age">{petAge(pet.birthday)}</span>{/if}
                </div>
                <button class="res-btn res-btn--ghost" style="padding: 0 var(--space-3); min-height: 36px;" onclick={() => startEdit(pet)}>Edit</button>
              </div>
              {#if pet.species || pet.breed || pet.weight}
                <div class="pet-meta">
                  {[pet.species, pet.breed, pet.weight].filter(Boolean).join(' \u00B7 ')}
                </div>
              {/if}
              {#if pet.notes}<p class="pet-notes">{pet.notes}</p>{/if}
            {/if}
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</main>

<style>
  .care-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border);
  }
  .care-row:last-child { border-bottom: none; }
  .care-info { display: flex; flex-direction: column; gap: var(--space-1); }
  .care-detail { font-size: var(--text-sm); color: var(--text-secondary); }
  .care-due { font-size: var(--text-xs); color: var(--text-muted); }
  .care-due.overdue { color: var(--color-danger); font-weight: 600; }

  .pet-header { display: flex; align-items: baseline; gap: var(--space-2); }
  .pet-name { font-size: var(--text-lg); font-weight: 600; }
  .pet-age { font-size: var(--text-sm); color: var(--text-muted); }
  .pet-meta { font-size: var(--text-sm); color: var(--text-secondary); margin-top: var(--space-1); }
  .pet-notes { font-size: var(--text-sm); color: var(--text-muted); margin-top: var(--space-2); }
</style>
