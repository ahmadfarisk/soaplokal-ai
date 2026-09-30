"use client";

import { useRef, useState } from "react";

const STT_API_URL = process.env.NEXT_PUBLIC_STT_API_URL || "http://localhost:8001";
// The backend's HTTP URL, converted to a WebSocket URL (http -> ws, https -> wss).
const STT_WS_URL = STT_API_URL.replace(/^http/, "ws") + "/ws/live-transcribe";

export default function LiveTranscribeTestPage() {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [bytesSent, setBytesSent] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);

  // Refs, not state — these are mutable handles to live objects, not
  // values the UI re-renders on. Re-rendering on every audio block would
  // be wasteful and isn't needed here.
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  function appendLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, `[${timestamp}] ${message}`]);
  }

  async function startRecording() {
    setBytesSent(0);
    setChunkCount(0);
    setLog([]);
    setStatus("Requesting microphone access…");

    try {
      // 1. Open the WebSocket first, so it's ready before audio starts flowing.
      const socket = new WebSocket(STT_WS_URL);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket failed to connect."));
      });
      appendLog(`Connected to ${STT_WS_URL}`);

      socket.onmessage = (event) => {
        // Phase 2's backend sends a JSON message every time VAD finalizes a
        // phrase and saves it as a .wav file — no audio comes back over the
        // socket yet, just a notification that a chunk was detected.
        // (Phase 3+ will add the actual transcribed text here.)
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "phrase_boundary") {
            setChunkCount(msg.chunk);
            appendLog(`Phrase ${msg.chunk} detected — saved as chunk_${String(msg.chunk).padStart(3, "0")}.wav`);
          } else {
            appendLog(`Received: ${event.data}`);
          }
        } catch {
          appendLog(`Received (non-JSON): ${event.data}`);
        }
      };
      socket.onclose = () => appendLog("WebSocket closed.");

      // 2. Get the microphone stream.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 3. Set up the AudioContext + worklet. Browsers default to 48000Hz,
      // which is what the worklet and VAD (in a later phase) expect.
      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule("/pcm-worklet-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-worklet-processor");
      workletNodeRef.current = workletNode;

      // Deliberately NOT connecting workletNode to audioContext.destination —
      // doing so would play the mic input back out the speakers (feedback/echo).
      // We only need the worklet's postMessage output, not an audio graph output.
      source.connect(workletNode);

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const pcmBuffer = event.data;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(pcmBuffer);
          setBytesSent((prev) => prev + pcmBuffer.byteLength);
        }
      };

      setRecording(true);
      setStatus("Recording — speak into the mic and watch bytes sent climb below.");
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      stopRecording();
    }
  }

  function stopRecording() {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    socketRef.current?.close();
    socketRef.current = null;

    setRecording(false);
    setStatus("Idle");
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 font-sans">
      <h1 className="text-2xl font-semibold mb-2">Live Transcription — Phase 2 Test</h1>
      <p className="text-sm text-gray-400 mb-6">
        No transcription yet — this tests VAD phrase-boundary detection. Speak a
        few sentences with clear pauses, then check <code>vad_test_chunks/</code>{" "}
        in the STT backend folder and listen to each saved .wav file to confirm
        the cuts land where you actually paused.
      </p>

      <section className="rounded-lg border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={recording ? stopRecording : startRecording}
            className={`rounded-md text-white text-sm px-4 py-2 ${
              recording ? "bg-red-700" : "bg-gray-900"
            }`}
          >
            {recording ? "Stop" : "Start"}
          </button>
          <span className="text-sm text-gray-400">{status}</span>
        </div>

        <p className="text-sm text-gray-200">
          Bytes sent: <span className="font-mono">{bytesSent.toLocaleString()}</span>
        </p>
        <p className="text-sm text-gray-200">
          Phrases detected: <span className="font-mono">{chunkCount}</span>
        </p>
      </section>

      <section className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-2">Log</h2>
        <div className="text-xs font-mono text-gray-400 space-y-1 max-h-64 overflow-y-auto">
          {log.length === 0 ? <p>Nothing yet.</p> : log.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      </section>
    </main>
  );
}