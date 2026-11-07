/**
 * Source for the audio-thread ticker that wakes the speech detector.
 *
 * It is carried as a string and handed to the audio engine as a blob at
 * runtime, rather than shipped as its own file. A worklet module has to be
 * fetched from a same-origin URL, and a bundler is free to inline a small file
 * as a data URL — which some engines refuse to load. A blob is same-origin by
 * construction and there is nothing left to go wrong at delivery.
 *
 * The processor declares NO OUTPUTS on purpose. A node with outputs has to be
 * wired through to the speakers before it will run at all, and opening an
 * output path while the microphone is capturing lets echo cancellation scrub
 * the incoming audio to silence — which is exactly what it did. With no
 * outputs it is a sink: processed without being connected to anything
 * downstream, so none of her audio is ever routed to a speaker.
 */
export const VAD_WORKLET_SOURCE = `
class BytelightVadTick extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samplesSinceTick = 0;
    // ~20ms: a little faster than the screen clock managed, and slow enough
    // that the main thread is never flooded.
    this.samplesPerTick = Math.max(128, Math.round(sampleRate * 0.02));
  }

  process() {
    this.samplesSinceTick += 128;
    if (this.samplesSinceTick >= this.samplesPerTick) {
      this.samplesSinceTick = 0;
      this.port.postMessage(0);
    }
    // Keep running across silence; the detector decides what silence means.
    return true;
  }
}

registerProcessor('bytelight-vad-tick', BytelightVadTick);
`;
