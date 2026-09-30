// pcm-worklet-processor.js
// Runs on the audio rendering thread, not the main thread — this is why it
// can't just be a function inside page.tsx. It receives 128 raw Float32
// samples per call from the mic, buffers them up to BLOCK_SIZE, converts to
// 16-bit PCM (what webrtcvad and Whisper both expect), and posts the block
// back to the main thread as a transferable ArrayBuffer.

class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~30ms at 48kHz, matching the VAD frame size from the plan.
    this.BLOCK_SIZE = 1440;
    this.buffer = new Float32Array(this.BLOCK_SIZE);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true; // keep processor alive even with no input yet

    const channelData = input[0]; // mono — just the first channel

    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      if (this.bufferIndex >= this.BLOCK_SIZE) {
        this._flush();
      }
    }

    return true; // returning false would permanently stop this processor
  }

  _flush() {
    // Float32 (-1.0 to 1.0) -> Int16 (-32768 to 32767), the format both
    // webrtcvad and Whisper expect.
    const int16 = new Int16Array(this.BLOCK_SIZE);
    for (let i = 0; i < this.BLOCK_SIZE; i++) {
      const clamped = Math.max(-1, Math.min(1, this.buffer[i]));
      int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    // Transfer ownership of the underlying buffer instead of copying it —
    // cheaper, and safe since we allocate a fresh Float32Array right after.
    this.port.postMessage(int16.buffer, [int16.buffer]);

    this.buffer = new Float32Array(this.BLOCK_SIZE);
    this.bufferIndex = 0;
  }
}

registerProcessor("pcm-worklet-processor", PCMWorkletProcessor);
