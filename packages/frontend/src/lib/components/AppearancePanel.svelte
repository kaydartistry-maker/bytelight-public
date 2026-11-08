<script lang="ts">
  import {
    ACCENT_PALETTES,
    FONT_OPTIONS,
    TYPOGRAPHY_PRESETS,
    THEME_SKINS,
    setMode,
    setSkin,
    setAccent,
    setCustomAccent,
    setCustomBackground,
    setCustomTextColor,
    setCustomBubble,
    setCustomFont,
    setFontPreset,
    setLineHeight,
    setLetterSpacing,
    setFontSize,
    setBorderRadius,
    setAuraIntensity,
    setGlowIntensity,
    setMotionIntensity,
    resetCustomTheme,
    getMode,
    getSkin,
    getAccentName,
    getCustom,
    type ThemeMode,
    type ThemeSkin,
  } from '$lib/stores/theme.svelte';
  import ThemePreviewCard from './ThemePreviewCard.svelte';

  let currentMode = $derived(getMode());
  let currentSkin = $derived(getSkin());
  let currentAccent = $derived(getAccentName());
  let custom = $derived(getCustom());

  function handleMode(m: ThemeMode) {
    setMode(m);
  }

  function handleSkin(s: ThemeSkin) {
    setSkin(s);
  }

  function clearBackgrounds() {
    setCustomBackground('bgPrimary', null);
    setCustomBackground('bgSecondary', null);
    setCustomBackground('bgSurface', null);
  }

  let activePreset = $derived(
    TYPOGRAPHY_PRESETS.find(
      (p) => p.heading === custom.fontHeading && p.body === custom.fontBody && p.mono === custom.fontMono
    )?.name ?? null
  );

  function handleAccent(name: string) {
    setCustomAccent(null); // Clear custom, use palette
    setAccent(name);
  }

  function handleCustomAccent(e: Event) {
    const input = e.target as HTMLInputElement;
    setCustomAccent(input.value);
  }

  function handleClearCustomAccent() {
    setCustomAccent(null);
  }
</script>

<div class="appearance-panel">
  <!-- Live preview — mirrors every setting below (pinned while you scroll) -->
  <div class="preview-wrap">
    <ThemePreviewCard />
  </div>

  <!-- Mode Toggle -->
  <section class="section">
    <h3 class="section-label">Appearance</h3>
    <div class="mode-toggle">
      <button
        class="mode-btn"
        class:active={currentMode === 'light'}
        onclick={() => handleMode('light')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        Daylight
      </button>
      <button
        class="mode-btn"
        class:active={currentMode === 'dark'}
        onclick={() => handleMode('dark')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
        </svg>
        Midnight
      </button>
    </div>
  </section>

  <!-- Skin / Vibe -->
  <section class="section">
    <h3 class="section-label">Skin</h3>
    <div class="skin-grid">
      {#each THEME_SKINS as s}
        <button
          class="skin-btn"
          class:active={currentSkin === s.id}
          onclick={() => handleSkin(s.id)}
        >
          {s.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- Accent Color -->
  <section class="section">
    <h3 class="section-label">Accent Color</h3>
    <div class="color-row">
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.accentColor || '#5eaba5'}
          oninput={handleCustomAccent}
        />
        <span class="color-preview" style="background: {custom.accentColor || 'var(--gold)'}"></span>
        Custom
      </label>
      {#if custom.accentColor}
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={handleClearCustomAccent}>Use palette</button>
      {/if}
    </div>
    <div class="palette-grid">
      {#each ACCENT_PALETTES as palette}
        {@const colors = currentMode === 'dark' ? palette.dark : palette.light}
        <button
          class="swatch-btn"
          class:selected={!custom.accentColor && currentAccent === palette.name}
          onclick={() => handleAccent(palette.name)}
          title={palette.name}
        >
          <div class="swatch" style="background: {colors.main}">
            {#if !custom.accentColor && currentAccent === palette.name}
              <svg class="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            {/if}
          </div>
          <span class="swatch-label">{palette.name}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Background Colors -->
  <section class="section">
    <div class="section-head">
      <h3 class="section-label">Backgrounds</h3>
      {#if custom.bgPrimary || custom.bgSecondary || custom.bgSurface}
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={clearBackgrounds}>Use theme default</button>
      {/if}
    </div>
    <div class="color-grid">
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.bgPrimary || '#09090b'}
          oninput={(e) => setCustomBackground('bgPrimary', (e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.bgPrimary || 'var(--bg-primary)'}"></span>
        Primary
      </label>
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.bgSecondary || '#111113'}
          oninput={(e) => setCustomBackground('bgSecondary', (e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.bgSecondary || 'var(--bg-secondary)'}"></span>
        Secondary
      </label>
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.bgSurface || '#1f1f23'}
          oninput={(e) => setCustomBackground('bgSurface', (e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.bgSurface || 'var(--bg-surface)'}"></span>
        Surface
      </label>
    </div>
  </section>

  <!-- Text Color -->
  <section class="section">
    <div class="section-head">
      <h3 class="section-label">Text</h3>
      {#if custom.textColor}
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={() => setCustomTextColor(null)}>Use theme default</button>
      {/if}
    </div>
    <div class="color-grid">
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.textColor || (currentMode === 'dark' ? '#e4e4e7' : '#1c1a17')}
          oninput={(e) => setCustomTextColor((e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.textColor || 'var(--text-primary)'}"></span>
        Text color
      </label>
    </div>
  </section>

  <!-- Message Bubbles -->
  <section class="section">
    <h3 class="section-label">Message Bubbles</h3>
    <div class="color-grid">
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.userBubble || '#1f1f23'}
          oninput={(e) => setCustomBubble('userBubble', (e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.userBubble || 'var(--user-bg, var(--bg-surface))'}"></span>
        Your messages
      </label>
      <label class="color-picker-label">
        <input
          type="color"
          class="color-input"
          value={custom.companionBubble || '#09090b'}
          oninput={(e) => setCustomBubble('companionBubble', (e.target as HTMLInputElement).value)}
        />
        <span class="color-preview" style="background: {custom.companionBubble || 'var(--companion-bg, transparent)'}"></span>
        Companion
      </label>
    </div>
  </section>

  <!-- Typography -->
  <section class="section">
    <h3 class="section-label">Typography</h3>
    <div class="skin-grid preset-grid">
      {#each TYPOGRAPHY_PRESETS as preset}
        <button
          class="skin-btn"
          class:active={activePreset === preset.name}
          onclick={() => setFontPreset(preset)}
        >
          {preset.name}
        </button>
      {/each}
    </div>
    <div class="font-grid">
      <label class="select-label">
        Headings
        <select
          class="font-select"
          value={custom.fontHeading}
          onchange={(e) => setCustomFont('fontHeading', (e.target as HTMLSelectElement).value)}
        >
          {#each FONT_OPTIONS.heading as font}
            <option value={font}>{font}</option>
          {/each}
        </select>
      </label>
      <label class="select-label">
        Body
        <select
          class="font-select"
          value={custom.fontBody}
          onchange={(e) => setCustomFont('fontBody', (e.target as HTMLSelectElement).value)}
        >
          {#each FONT_OPTIONS.body as font}
            <option value={font}>{font}</option>
          {/each}
        </select>
      </label>
      <label class="select-label">
        Code
        <select
          class="font-select"
          value={custom.fontMono}
          onchange={(e) => setCustomFont('fontMono', (e.target as HTMLSelectElement).value)}
        >
          {#each FONT_OPTIONS.mono as font}
            <option value={font}>{font}</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="slider-row">
      <label class="slider-label">
        <span>Font Size</span>
        <span class="slider-value">{Math.round(custom.fontSize * 100)}%</span>
      </label>
      <input
        type="range"
        class="slider"
        min="0.85"
        max="1.15"
        step="0.01"
        value={custom.fontSize}
        oninput={(e) => setFontSize(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>

    <div class="slider-row">
      <label class="slider-label">
        <span>Line Height</span>
        <span class="slider-value">{custom.lineHeight.toFixed(2)}</span>
      </label>
      <input
        type="range"
        class="slider"
        min="1.3"
        max="1.9"
        step="0.05"
        value={custom.lineHeight}
        oninput={(e) => setLineHeight(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>

    <div class="slider-row">
      <label class="slider-label">
        <span>Letter Spacing</span>
        <span class="slider-value">{custom.letterSpacing === 0 ? 'Normal' : `${custom.letterSpacing > 0 ? '+' : ''}${custom.letterSpacing.toFixed(3)}em`}</span>
      </label>
      <input
        type="range"
        class="slider"
        min="-0.02"
        max="0.06"
        step="0.005"
        value={custom.letterSpacing}
        oninput={(e) => setLetterSpacing(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
  </section>

  <!-- Layout -->
  <section class="section">
    <h3 class="section-label">Layout</h3>
    <div class="slider-row">
      <label class="slider-label">
        <span>Roundness</span>
        <span class="slider-value">{custom.borderRadius === 0 ? 'Sharp' : custom.borderRadius >= 1.25 ? 'Pill' : 'Soft'}</span>
      </label>
      <input
        type="range"
        class="slider"
        min="0"
        max="1.5"
        step="0.125"
        value={custom.borderRadius}
        oninput={(e) => setBorderRadius(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
  </section>

  <!-- Effects -->
  <section class="section">
    <h3 class="section-label">Effects</h3>
    <p class="section-hint">Aura &amp; Glow shape the Cosmos skin. 100% = default.</p>
    <div class="slider-row">
      <label class="slider-label">
        <span>Aura</span>
        <span class="slider-value">{Math.round(custom.auraIntensity * 100)}%</span>
      </label>
      <input
        type="range"
        class="slider"
        min="0"
        max="1.5"
        step="0.05"
        value={custom.auraIntensity}
        oninput={(e) => setAuraIntensity(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
    <div class="slider-row">
      <label class="slider-label">
        <span>Glow</span>
        <span class="slider-value">{Math.round(custom.glowIntensity * 100)}%</span>
      </label>
      <input
        type="range"
        class="slider"
        min="0"
        max="1.5"
        step="0.05"
        value={custom.glowIntensity}
        oninput={(e) => setGlowIntensity(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
    <div class="slider-row">
      <label class="slider-label">
        <span>Motion</span>
        <span class="slider-value">{custom.motionIntensity === 0 ? 'Off' : `${Math.round(custom.motionIntensity * 100)}%`}</span>
      </label>
      <input
        type="range"
        class="slider"
        min="0"
        max="1.5"
        step="0.05"
        value={custom.motionIntensity}
        oninput={(e) => setMotionIntensity(parseFloat((e.target as HTMLInputElement).value))}
      />
    </div>
  </section>

  <!-- Reset -->
  <section class="section section-reset">
    <button class="res-btn res-btn--danger res-btn--sm" onclick={resetCustomTheme}>
      Reset to defaults
    </button>
  </section>
</div>

<style>
  .appearance-panel {
    max-width: 540px;
  }

  /* Live preview pinned to the top of the panel while you scroll the controls */
  .preview-wrap {
    position: sticky;
    top: 0;
    z-index: 5;
    margin-bottom: 1.25rem;
    padding: 0.5rem 0 0.75rem;
    background: var(--bg-primary);
  }

  .section-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: -0.4rem 0 0.75rem;
  }

  .section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .section:last-child {
    border-bottom: none;
  }

  .section-reset {
    padding-top: 0.5rem;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .section-head .section-label {
    margin-bottom: 0;
  }

  .section-label {
    font-family: var(--font-heading);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin: 0 0 0.75rem;
  }

  .mode-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .mode-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-family: var(--font-body);
    font-weight: 500;
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 2rem;
    cursor: pointer;
    transition: all var(--transition);
  }

  .mode-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border-hover);
  }

  .mode-btn.active {
    color: var(--text-primary);
    background: var(--bg-active);
    border-color: var(--accent);
  }

  .skin-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .skin-btn {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-family: var(--font-body);
    font-weight: 500;
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 2rem;
    cursor: pointer;
    transition: all var(--transition);
  }

  .skin-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border-hover);
  }

  .skin-btn.active {
    color: var(--text-primary);
    background: var(--bg-active);
    border-color: var(--accent);
  }

  .preset-grid {
    margin-bottom: 0.875rem;
  }

  .palette-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 0.5rem;
  }

  .swatch-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
  }

  .swatch {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--transition);
    border: 2px solid transparent;
  }

  .swatch-btn:hover .swatch {
    transform: scale(1.15);
  }

  .swatch-btn.selected .swatch {
    border-color: var(--text-primary);
  }

  .check {
    stroke: white;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
  }

  .swatch-label {
    font-size: 0.5rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    display: none;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .color-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .color-picker-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .color-input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }

  .color-preview {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--border);
    transition: transform var(--transition);
  }

  .color-picker-label:hover .color-preview {
    transform: scale(1.1);
    border-color: var(--accent);
  }


  .font-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .select-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .font-select {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    color: var(--text-primary);
    padding: 0.375rem 0.5rem;
    font-size: 0.8125rem;
    min-width: 9rem;
    cursor: pointer;
  }

  .font-select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .slider-row {
    margin-top: 0.75rem;
  }

  .slider-label {
    display: flex;
    justify-content: space-between;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
  }

  .slider-value {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .slider {
    width: 100%;
    height: 0.375rem;
    border-radius: 0.25rem;
    background: var(--bg-surface);
    appearance: none;
    cursor: pointer;
  }

  .slider::-webkit-slider-thumb {
    appearance: none;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    transition: transform var(--transition);
  }

  .slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
  }

  @media (max-width: 480px) {
    .palette-grid {
      grid-template-columns: repeat(4, 1fr);
      gap: 0.75rem;
    }

    .swatch {
      width: 2.5rem;
      height: 2.5rem;
    }

    .swatch-label {
      display: block;
      font-size: 0.5625rem;
    }

    .color-grid {
      flex-direction: column;
      gap: 0.75rem;
    }

    .font-grid {
      flex-direction: column;
    }

    .font-select {
      width: 100%;
    }
  }
</style>
