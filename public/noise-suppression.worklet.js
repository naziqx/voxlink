/**
 * Noise Suppression AudioWorklet Processor
 * Improved noise gate with adaptive threshold
 */
class NoiseSuppressionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 128;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this.noiseFloor = 0.005;
    this.adaptiveThreshold = 0.02;
    this.hangover = 0;
    this.maxHangover = 8;
    this.port.onmessage = (e) => {
      if (e.data.type === 'setThreshold') {
        this.adaptiveThreshold = e.data.value;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const inputChannel = input[0];
    const outputChannel = output[0];
    
    for (let i = 0; i < inputChannel.length; i++) {
      outputChannel[i] = inputChannel[i];
    }

    // Calculate RMS for this block
    let sum = 0;
    for (let i = 0; i < inputChannel.length; i++) {
      sum += inputChannel[i] * inputChannel[i];
    }
    const rms = Math.sqrt(sum / inputChannel.length);

    // Adaptive noise floor
    if (rms < this.noiseFloor * 2) {
      this.noiseFloor = this.noiseFloor * 0.99 + rms * 0.01;
    }

    // Noise gate with hangover
    const threshold = this.noiseFloor * 4;
    if (rms < threshold) {
      if (this.hangover > 0) {
        this.hangover--;
      } else {
        // Apply noise reduction
        const reduction = Math.max(0.05, rms / threshold);
        for (let i = 0; i < outputChannel.length; i++) {
          outputChannel[i] *= reduction;
        }
      }
    } else {
      this.hangover = this.maxHangover;
    }

    return true;
  }
}

registerProcessor('noise-suppression', NoiseSuppressionProcessor);
