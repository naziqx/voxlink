'use strict';

/**
 * Noise Suppressor - Uses RNNoise WASM when available, falls back to AudioWorklet
 * Works on both Linux and Windows
 */
class NoiseSuppressor {
  constructor() {
    this.audioContext = null;
    this.workletNode = null;
    this.rnnoiseReady = false;
    this.rnnoiseInstance = null;
    this.denoiseState = null;
    this.frameSize = 0;
    this.inputBuffer = null;
    this.inputBufferIndex = 0;
    this.initialized = false;
  }

  async init(audioContext) {
    if (this.initialized) return true;

    this.audioContext = audioContext;

    // Try to initialize RNNoise WASM (may not be loaded yet as module)
    if (window.Rnnoise) {
      try {
        this.rnnoiseInstance = await window.Rnnoise.load();
        this.denoiseState = this.rnnoiseInstance.createDenoiseState();
        this.frameSize = this.rnnoiseInstance.frameSize;
        this.inputBuffer = new Float32Array(this.frameSize);
        this.rnnoiseReady = true;
        console.log('[noise-suppressor] RNNoise WASM initialized, frameSize:', this.frameSize);
      } catch (e) {
        console.warn('[noise-suppressor] RNNoise init failed:', e);
      }
    }

    // Try AudioWorklet as fallback
    if (!this.rnnoiseReady) {
      try {
        await audioContext.audioWorklet.addModule('./noise-suppression.worklet.js');
        this.workletNode = new AudioWorkletNode(audioContext, 'noise-suppression');
        console.log('[noise-suppressor] AudioWorklet initialized');
      } catch (e) {
        console.warn('[noise-suppressor] AudioWorklet not available:', e);
      }
    }

    this.initialized = true;
    return true;
  }

  // Reinitialize if RNNoise becomes available after init
  async tryEnableRNNoise() {
    if (this.rnnoiseReady || !window.Rnnoise || !this.audioContext) return;

    try {
      this.rnnoiseInstance = await window.Rnnoise.load();
      this.denoiseState = this.rnnoiseInstance.createDenoiseState();
      this.frameSize = this.rnnoiseInstance.frameSize;
      this.inputBuffer = new Float32Array(this.frameSize);
      this.rnnoiseReady = true;
      console.log('[noise-suppressor] RNNoise WASM enabled (late init), frameSize:', this.frameSize);
    } catch (e) {
      console.warn('[noise-suppressor] RNNoise late init failed:', e);
    }
  }

  process(stream, options = {}) {
    if (!this.initialized || !this.audioContext) {
      return stream;
    }

    const source = this.audioContext.createMediaStreamSource(stream);
    const destination = this.audioContext.createMediaStreamDestination();

    if (this.rnnoiseReady && this.denoiseState) {
      // Use RNNoise WASM via ScriptProcessorNode
      const bufferSize = 480;
      const processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      const frameSize = this.frameSize;
      const denoiseState = this.denoiseState;
      const inputBuffer = this.inputBuffer;
      let inputBufferIndex = 0;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const output = e.outputBuffer.getChannelData(0);

        for (let i = 0; i < input.length; i++) {
          inputBuffer[inputBufferIndex] = input[i];
          inputBufferIndex++;

          if (inputBufferIndex >= frameSize) {
            // Convert float32 to int16 for RNNoise
            const int16Frame = new Int16Array(frameSize);
            for (let j = 0; j < frameSize; j++) {
              const s = Math.max(-1, Math.min(1, inputBuffer[j]));
              int16Frame[j] = s < 0 ? s * 32768 : s * 32767;
            }
            // Process with RNNoise
            denoiseState.processFrame(int16Frame);
            // Convert back to float32
            for (let j = 0; j < frameSize; j++) {
              inputBuffer[j] = int16Frame[j] / 32768;
            }
            inputBufferIndex = 0;
          }
        }

        output.set(input);
      };

      source.connect(processor);
      processor.connect(destination);
      console.log('[noise-suppressor] RNNoise WASM processing active');
    } else if (this.workletNode) {
      // Use AudioWorklet fallback
      source.connect(this.workletNode);
      this.workletNode.connect(destination);
      console.log('[noise-suppressor] AudioWorklet processing active');
    } else {
      // Basic noise gate fallback
      const analyser = this.audioContext.createAnalyser();
      const gainNode = this.audioContext.createGain();

      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(destination);

      const threshold = options.threshold || 0.01;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkVolume = () => {
        if (!this.initialized) return;
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        gainNode.gain.value = average > threshold * 255 ? 1.0 : 0.1;
        requestAnimationFrame(checkVolume);
      };
      checkVolume();
      console.log('[noise-suppressor] Basic noise gate active');
    }

    return destination.stream;
  }

  destroy() {
    this.initialized = false;
    if (this.denoiseState) {
      this.denoiseState.destroy();
      this.denoiseState = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.rnnoiseReady = false;
    this.rnnoiseInstance = null;
  }
}

window.NoiseSuppressor = NoiseSuppressor;
