'use strict';

/**
 * Noise Suppressor — send-side processing for local mic.
 * Chain: source → ScriptProcessor → GainNode → MediaStreamDestination
 * Handles RNNoise frameSize (480) vs ScriptProcessor buffer size mismatch
 * via input accumulation + output queue.
 */
class NoiseSuppressor {
  constructor() {
    this.audioContext = null;
    this.rnnoiseReady = false;
    this.rnnoiseInstance = null;
    this.frameSize = 0;
    this.initialized = false;
    this.enabled = true;
    this.source = null;
    this.processor = null;
    this.gainNode = null;
    this.destination = null;
    this.denoiseState = null;
  }

  async init(audioContext) {
    if (this.initialized) return true;

    this.audioContext = audioContext;
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (window.Rnnoise) {
      try {
        this.rnnoiseInstance = await window.Rnnoise.load();
        this.frameSize = this.rnnoiseInstance.frameSize;
        this.rnnoiseReady = true;
        console.log('[noise-suppressor] RNNoise WASM initialized, frameSize:', this.frameSize);
      } catch (e) {
        console.warn('[noise-suppressor] RNNoise init failed:', e);
      }
    }

    if (!this.rnnoiseReady) {
      try {
        await audioContext.audioWorklet.addModule('./noise-suppression.worklet.js');
        console.log('[noise-suppressor] AudioWorklet module loaded');
      } catch (e) {
        console.warn('[noise-suppressor] AudioWorklet not available:', e);
      }
    }

    this.initialized = true;
    return true;
  }

  async tryEnableRNNoise() {
    if (this.rnnoiseReady || !window.Rnnoise || !this.audioContext) return;
    try {
      this.rnnoiseInstance = await window.Rnnoise.load();
      this.frameSize = this.rnnoiseInstance.frameSize;
      this.rnnoiseReady = true;
      console.log('[noise-suppressor] RNNoise WASM enabled (late init)');
    } catch (e) {
      console.warn('[noise-suppressor] RNNoise late init failed:', e);
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    console.log('[noise-suppressor] setEnabled:', enabled);
  }

  setGain(value) {
    if (this.gainNode) {
      this.gainNode.gain.value = value;
    }
  }

  processStream(key, stream) {
    if (!this.initialized || !this.audioContext) {
      return stream;
    }

    if (!this.processor) {
      return this._buildGraph(stream);
    }

    this._swapSource(stream);
    return this.destination.stream;
  }

  _buildGraph(stream) {
    this.source = this.audioContext.createMediaStreamSource(stream);
    this.destination = this.audioContext.createMediaStreamDestination();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;

    if (this.rnnoiseReady && this.rnnoiseInstance) {
      this.denoiseState = this.rnnoiseInstance.createDenoiseState();
      const frameSize = this.frameSize;
      const nsRef = this;

      // Use buffer size 0 (Chrome default = power-of-2, typically 128)
      this.processor = this.audioContext.createScriptProcessor(0, 1, 1);

      // Input accumulation buffer
      const accumBuffer = new Float32Array(frameSize);
      let accumPos = 0;

      // Output queue: processed frames ready to play
      const outputQueue = [];
      let outputChunk = null;
      let outputPos = 0;

      let frameCount = 0;

      this.processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const output = e.outputBuffer.getChannelData(0);

        // Accumulate input into frame buffer
        for (let i = 0; i < input.length; i++) {
          accumBuffer[accumPos++] = input[i];

          if (accumPos >= frameSize) {
            if (nsRef.enabled) {
              // RNNoise processing
              const int16Frame = new Int16Array(frameSize);
              for (let j = 0; j < frameSize; j++) {
                const s = Math.max(-1, Math.min(1, accumBuffer[j]));
                int16Frame[j] = s < 0 ? s * 32768 : s * 32767;
              }
              nsRef.denoiseState.processFrame(int16Frame);
              const processed = new Float32Array(frameSize);
              for (let j = 0; j < frameSize; j++) {
                processed[j] = int16Frame[j] / 32768;
              }
              outputQueue.push(processed);
            } else {
              // Bypass — pass through
              outputQueue.push(new Float32Array(accumBuffer));
            }
            accumPos = 0;
            frameCount++;
            if (frameCount === 1 || frameCount % 500 === 0) {
              console.log('[noise-suppressor] frame', frameCount, 'enabled:', nsRef.enabled, 'input[0]:', input[0]?.toFixed(4), 'queue:', outputQueue.length);
            }
          }
        }

        // Fill output from queue
        let written = 0;
        while (written < output.length) {
          if (!outputChunk) {
            outputChunk = outputQueue.shift() || null;
            outputPos = 0;
          }
          if (!outputChunk) {
            output[written++] = 0;
          } else {
            const avail = outputChunk.length - outputPos;
            const need = output.length - written;
            const take = Math.min(avail, need);
            for (let j = 0; j < take; j++) {
              output[written++] = outputChunk[outputPos++];
            }
            if (outputPos >= outputChunk.length) {
              outputChunk = null;
            }
          }
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.gainNode);
      this.gainNode.connect(this.destination);
      console.log('[noise-suppressor] RNNoise+Gain graph built (frameSize:', frameSize, ')');
    } else if (this.audioContext.audioWorklet) {
      this.processor = new AudioWorkletNode(this.audioContext, 'noise-suppression');
      this.source.connect(this.processor);
      this.processor.connect(this.gainNode);
      this.gainNode.connect(this.destination);
      console.log('[noise-suppressor] AudioWorklet+Gain graph built');
    } else {
      return stream;
    }

    return this.destination.stream;
  }

  _swapSource(newStream) {
    try { this.source.disconnect(); } catch {}
    this.source = this.audioContext.createMediaStreamSource(newStream);
    this.source.connect(this.processor);
    console.log('[noise-suppressor] source swapped');
  }

  destroy() {
    this.initialized = false;
    try {
      if (this.source) this.source.disconnect();
      if (this.processor) this.processor.disconnect();
      if (this.gainNode) this.gainNode.disconnect();
      if (this.denoiseState) this.denoiseState.destroy();
    } catch {}
    this.source = null;
    this.processor = null;
    this.gainNode = null;
    this.destination = null;
    this.denoiseState = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.rnnoiseReady = false;
    this.rnnoiseInstance = null;
  }
}

window.NoiseSuppressor = NoiseSuppressor;
