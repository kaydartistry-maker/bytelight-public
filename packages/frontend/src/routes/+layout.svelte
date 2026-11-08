<script lang="ts">
  import '../app.css';
  import { checkAuth, isAuthenticated, isChecking, isAuthRequired, stopAuthPolling } from '$lib/stores/auth.svelte';
  import { initTheme } from '$lib/stores/theme.svelte';
  import { loadStickers } from '$lib/stores/stickers.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import Toast from '$lib/components/Toast.svelte';

  let { children } = $props();
  let currentPath = $derived($page.url.pathname);
  let isLoginPage = $derived(currentPath === `${base}/login`);

  // Show children only when:
  // - Auth check is done AND (authenticated OR on the login page OR auth not required)
  let showChildren = $derived(
    !isChecking() && (isAuthenticated() || isLoginPage || !isAuthRequired())
  );

  onMount(async () => {
// Restore saved theme before render — default Midnight, migrate legacy values
    const legacyMap: Record<string, string> = { dark: 'rose', light: 'petal' };
    const savedTheme = localStorage.getItem('bytelight-theme');
    const theme = legacyMap[savedTheme ?? ''] ?? savedTheme ?? 'rose';
    document.documentElement.setAttribute('data-theme', theme);
    if (theme !== savedTheme) localStorage.setItem('bytelight-theme', theme);
    const savedAccent = localStorage.getItem('bytelight-accent');
    if (savedAccent) {
      document.documentElement.setAttribute('data-accent', savedAccent);
    }

    await checkAuth();

    // If not authenticated and not on login page, redirect to login
    if (!isAuthenticated() && isAuthRequired() && !isLoginPage) {
      goto(`${base}/login`);
    }

    // Load stickers for picker and inline rendering
    if (isAuthenticated() || !isAuthRequired()) {
      loadStickers();
    }
  });

  onDestroy(() => {
    stopAuthPolling();
  });
</script>

{#if showChildren}
  {@render children()}
{:else}
  <div class="loading-screen">
    <div class="spinner"></div>
  </div>
{/if}

<Toast />

<style>
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background: var(--bg-primary);
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

</style>
