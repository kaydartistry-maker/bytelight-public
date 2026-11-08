<script lang="ts">
  import { login, checkAuth, isAuthenticated, isAuthRequired } from '$lib/stores/auth.svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { onMount } from 'svelte';

  let password = $state('');
  let error = $state('');
  let loading = $state(false);

  onMount(async () => {
    
    if (isAuthenticated() || !isAuthRequired()) {
      goto(`${base}/chat`);
    }
  });

  function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('bytelight-theme', next);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = '';
    loading = true;

    const result = await login(password);

    if (result.success) {
      goto(`${base}/chat`);
    } else {
      error = result.error || 'Login failed';
      password = '';
    }

    loading = false;
  }
</script>

<div class="login-page">
  <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light/dark mode" title="Toggle theme">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
    </svg>
  </button>
  <div class="login-space">
    <h1 class="name">byte-light</h1>

    <form onsubmit={handleSubmit}>
      <input
        id="password"
        type="password"
        bind:value={password}
        placeholder=""
        disabled={loading}
        autocomplete="current-password"
        aria-label="Password"
      />

      {#if error}
        <div class="error-message" role="alert">
          {error}
        </div>
      {/if}

      <button type="submit" class="enter-button" disabled={loading || !password}>
        {loading ? '...' : 'Enter'}
      </button>
    </form>
  </div>
</div>

<style>
  .login-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background: var(--bg-primary);
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1rem calc(env(safe-area-inset-bottom, 0px) + 1rem);
    position: relative;
  }

  .theme-toggle {
    position: absolute;
    top: calc(env(safe-area-inset-top, 0px) + 1rem);
    right: 1rem;
    padding: 0.5rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
    z-index: 2;
  }

  .theme-toggle:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  /* Subtle radial warmth — candlelight from center */
  .login-page::before {
    content: '';
    position: absolute;
    top: 40%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 600px;
    height: 400px;
    background: radial-gradient(ellipse, var(--gold-ember) 0%, transparent 70%);
    pointer-events: none;
  }

  .login-space {
    width: 100%;
    max-width: 20rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2.5rem;
    position: relative;
    z-index: 1;
  }

  .name {
    font-family: var(--font-heading);
    font-size: 2.5rem;
    font-weight: 400;
    color: var(--gold);
    letter-spacing: 0.08em;
    text-align: center;
  }

  form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  input {
    width: 100%;
    padding: 0.875rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 1rem;
    text-align: center;
    letter-spacing: 0.15em;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  input:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px var(--gold-ember);
  }

  input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .error-message {
    background: var(--color-danger-muted);
    border: 1px solid color-mix(in oklch, var(--color-danger) 22%, transparent);
    color: var(--color-danger);
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    text-align: center;
  }

  .enter-button {
    width: 100%;
    padding: 0.875rem;
    background: transparent;
    color: var(--gold);
    font-family: var(--font-heading);
    font-size: 0.875rem;
    font-weight: 500;
    letter-spacing: 0.15em;
    border: 1px solid var(--gold-dim);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    cursor: pointer;
  }

  .enter-button:hover:not(:disabled) {
    background: var(--gold-ember);
    border-color: var(--gold);
  }

  .enter-button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
</style>
