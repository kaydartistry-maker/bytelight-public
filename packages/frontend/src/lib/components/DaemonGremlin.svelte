<script lang="ts">
  import type { PresenceStatus } from '@bytelight/shared';

  let { status, size = 48 }: { status: PresenceStatus; size?: number } = $props();

  // Map presence to gremlin state
  const gremlinState = $derived(() => {
    switch (status) {
      case 'active':
        return { mood: 'awake', eyes: '◉ ◉', mouth: '▿', bodyClass: 'bounce', label: 'Awake & chaotic' };
      case 'waking':
        return { mood: 'waking', eyes: '◎ ◎', mouth: '○', bodyClass: 'stretch', label: 'Waking up...' };
      case 'dormant':
        return { mood: 'sleeping', eyes: '– –', mouth: '‿', bodyClass: 'breathe', label: 'Sleeping' };
      case 'offline':
        return { mood: 'offline', eyes: '✕ ✕', mouth: '︵', bodyClass: 'flop', label: 'Offline' };
      default:
        return { mood: 'sleeping', eyes: '– –', mouth: '‿', bodyClass: 'breathe', label: 'Sleeping' };
    }
  });
</script>

<div
  class="gremlin-container"
  style:--size="{size}px"
  title={gremlinState().label}
  role="img"
  aria-label={`Daemon gremlin: ${gremlinState().label}`}
>
  <div class="gremlin {gremlinState().bodyClass}" data-mood={gremlinState().mood}>
    <!-- Ears -->
    <div class="ear ear-left"></div>
    <div class="ear ear-right"></div>

    <!-- Body -->
    <div class="body">
      <!-- Fuzz texture -->
      <div class="fuzz"></div>

      <!-- Face -->
      <div class="face">
        <div class="eyes">{gremlinState().eyes}</div>
        <div class="mouth">{gremlinState().mouth}</div>
      </div>

      <!-- Little arms -->
      <div class="arm arm-left"></div>
      <div class="arm arm-right"></div>
    </div>

    <!-- Feet -->
    <div class="feet">
      <div class="foot foot-left"></div>
      <div class="foot foot-right"></div>
    </div>
  </div>
</div>

<style>
  .gremlin-container {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--size);
    height: var(--size);
    position: relative;
    cursor: default;
    user-select: none;
  }

  .gremlin {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    transform-origin: bottom center;
  }

  /* --- Ears --- */
  .ear {
    position: absolute;
    width: 22%;
    height: 28%;
    background: var(--gold-ember, #d4a574);
    border-radius: 50% 50% 30% 30%;
    top: -12%;
    z-index: 1;
  }
  .ear-left {
    left: 12%;
    transform: rotate(-20deg);
  }
  .ear-right {
    right: 12%;
    transform: rotate(20deg);
  }

  /* --- Body --- */
  .body {
    position: relative;
    width: calc(var(--size) * 0.6);
    height: calc(var(--size) * 0.55);
    background: var(--surface-2, #2a2a3e);
    border-radius: 45% 45% 40% 40%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border: 1.5px solid var(--border, rgba(255,255,255,0.08));
  }

  .fuzz {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      circle at 30% 40%,
      rgba(255,255,255,0.04) 0%,
      transparent 50%
    );
    pointer-events: none;
  }

  /* --- Face --- */
  .face {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    z-index: 2;
  }

  .eyes {
    font-size: calc(var(--size) * 0.2);
    line-height: 1;
    letter-spacing: 2px;
    color: var(--gold-ember, #d4a574);
    transition: all 0.4s ease;
    font-family: monospace;
  }

  .mouth {
    font-size: calc(var(--size) * 0.15);
    line-height: 1;
    color: var(--gold-ember, #d4a574);
    opacity: 0.7;
    transition: all 0.4s ease;
    font-family: monospace;
  }

  /* --- Arms --- */
  .arm {
    position: absolute;
    width: 16%;
    height: 30%;
    background: var(--surface-2, #2a2a3e);
    border-radius: 40%;
    bottom: 15%;
    border: 1.5px solid var(--border, rgba(255,255,255,0.08));
  }
  .arm-left {
    left: -10%;
    transform: rotate(15deg);
  }
  .arm-right {
    right: -10%;
    transform: rotate(-15deg);
  }

  /* --- Feet --- */
  .feet {
    display: flex;
    gap: 20%;
    margin-top: -2px;
  }
  .foot {
    width: calc(var(--size) * 0.14);
    height: calc(var(--size) * 0.08);
    background: var(--surface-2, #2a2a3e);
    border-radius: 50% 50% 40% 40%;
    border: 1.5px solid var(--border, rgba(255,255,255,0.08));
    border-top: none;
  }

  /* ===== ANIMATIONS ===== */

  /* Active: bouncy little chaos creature */
  .bounce {
    animation: gremlin-bounce 1.8s ease-in-out infinite;
  }
  .bounce .arm-left {
    animation: wave-left 2.4s ease-in-out infinite;
  }
  .bounce .arm-right {
    animation: wave-right 2.4s ease-in-out infinite 0.3s;
  }

  @keyframes gremlin-bounce {
    0%, 100% { transform: translateY(0); }
    30% { transform: translateY(-8%); }
    50% { transform: translateY(-4%) rotate(2deg); }
    70% { transform: translateY(-8%); }
  }

  @keyframes wave-left {
    0%, 100% { transform: rotate(15deg); }
    50% { transform: rotate(-10deg); }
  }
  @keyframes wave-right {
    0%, 100% { transform: rotate(-15deg); }
    50% { transform: rotate(10deg); }
  }

  /* Waking: stretching awake */
  .stretch {
    animation: gremlin-stretch 2.5s ease-in-out infinite;
  }
  @keyframes gremlin-stretch {
    0%, 100% { transform: scaleY(1) scaleX(1); }
    40% { transform: scaleY(1.08) scaleX(0.95); }
    60% { transform: scaleY(0.96) scaleX(1.04); }
  }

  /* Dormant: slow breathing */
  .breathe {
    animation: gremlin-breathe 4s ease-in-out infinite;
  }
  .breathe .eyes {
    opacity: 0.5;
  }
  @keyframes gremlin-breathe {
    0%, 100% { transform: scaleY(1); }
    50% { transform: scaleY(0.96); }
  }

  /* Offline: flopped over */
  .flop {
    transform: rotate(15deg) translateY(4px);
    opacity: 0.5;
  }
  .flop .eyes {
    opacity: 0.4;
  }
  .flop .arm-left {
    transform: rotate(40deg);
  }
  .flop .arm-right {
    transform: rotate(-40deg);
  }
</style>
