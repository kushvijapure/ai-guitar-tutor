/**
 * AudioWorklet capture stage.
 *
 * Plain JavaScript with no imports on purpose: this is loaded directly by
 * `audioWorklet.addModule()` and runs on the real-time audio thread, so it must
 * not depend on the bundler transforming it.
 *
 * All it does is reblock the audio thread's 128-sample render quanta into
 * hop-sized chunks and hand them off. No FFT, no pitch detection, nothing that
 * could overrun the render deadline and glitch the input — that work happens in
 * a Worker, one thread further away from the audio callback.
 *
 * It also reports RMS per hop, computed here because it is a single pass over
 * data already in cache, and because it lets the consumer decide "this is
 * silence" without any further work.
 */

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const hopSize = options?.processorOptions?.hopSize;
    this.hopSize = typeof hopSize === 'number' && hopSize > 0 ? hopSize : 2048;
    this.buffer = new Float32Array(this.hopSize);
    this.filled = 0;
    this.running = true;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    // Returning false lets the browser tear this node down; it is how the
    // worklet stops cleanly rather than being left running after a session ends.
    if (!this.running) return false;

    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];

      if (this.filled === this.hopSize) {
        let sum = 0;
        for (let j = 0; j < this.hopSize; j++) sum += this.buffer[j] * this.buffer[j];

        // A fresh array so it can be transferred rather than copied. One 8 KB
        // allocation per hop (~21/s) is well inside what the audio thread can
        // absorb, and it avoids a structured-clone copy on every message.
        const samples = new Float32Array(this.buffer);
        this.port.postMessage(
          {
            samples,
            rms: Math.sqrt(sum / this.hopSize),
            // currentTime is the AudioContext clock, in seconds.
            time: currentTime * 1000,
          },
          [samples.buffer],
        );

        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
