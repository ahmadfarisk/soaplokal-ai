"use client";

import { useRef, useState } from "react";

interface LiveTranscriptionPanelProps {
  apiUrl: string;
  loadedModelId: string | null;
  transcript: string;
  onTranscriptChange: (text: string) => void;
  onError: (message: string) => void;
}

const TRANSCRIBE_TIMEOUT = 60000

/**
 * Live mode alongside the file-upload TranscriptionPanel. Streams mic audio
 * to the backend over a WebSocket; the backend runs VAD + transcription and
 * sends back one "phrase" message per finalized chunk (see Phase 4). Phrases
 * are appended into the same `transcript` string the file-upload flow
 * produces, so the SOAP note step downstream needs no changes at all.
 */
export default function LiveTranscriptionPanel({
  apiUrl,
  loadedModelId,
  transcript,
  onTranscriptChange,
  onError,
}: LiveTranscriptionPanelProps) {
  const [recording, setRecording] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [status, setStatus] = useState("Not recording");

  const recordingStartRef = useRef<number | null>(null);
  const [lastMetrics, setLastMetrics] = useState<{ recordingSeconds: number; drainSeconds: number } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // Resolved when the backend's {"type": "done"} message arrives, so
  // stopRecording() can await it instead of closing the socket immediately.
  const doneResolverRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Ref, not state — handleAppendPhrase reads the latest transcript inside a
  // WebSocket callback, where state from the render that set up the socket
  // would otherwise be stale.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  async function startRecording() {
    if (!loadedModelId) {
      onError("Load a speech-to-text model before starting.");
      return;
    }

    try {
      const wsUrl =
        apiUrl.replace(/^http/, "ws") +
        `/ws/live-transcribe?model_id=${encodeURIComponent(loadedModelId)}`;

      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Could not connect to the live transcription socket."));
      });

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "phrase" && msg.text) {
            const next = transcriptRef.current
              ? `${transcriptRef.current} ${msg.text}`
              : msg.text;
            onTranscriptChange(next);
          } else if (msg.type === "done") {
            // Backend finished draining its queue and flushing trailing
            // audio — safe for stopRecording()'s wait to resolve now.
            doneResolverRef.current?.();
          }
        } catch {
          // Ignore anything that isn't valid JSON — not expected, but
          // shouldn't crash a live session if it happens.
        }
      };
      socket.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason, "clean:", event.wasClean);
        // If the socket closes while stopRecording() is still waiting for
        // "done" (e.g. server dropped the connection instead), don't leave
        // that wait hanging forever.
        doneResolverRef.current?.();
        setStatus("Not recording");
      };

      // const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule("/pcm-worklet-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-worklet-processor");
      workletNodeRef.current = workletNode;
      source.connect(workletNode); // not connected onward to destination — avoids echo

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };

      recordingStartRef.current = Date.now();
      setRecording(true);
      setStatus("Recording — speak naturally, phrases will appear below as you pause.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      stopRecording();
    }
  }

  async function stopRecording() {
    const stopClickedAt = Date.now();

    // Stop capturing NEW audio right away — we don't want anything spoken
    // after clicking Stop to still be recorded, even while we wait below
    // for the backend to finish with what was already sent.
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const socket = socketRef.current;

    if (socket && socket.readyState === WebSocket.OPEN) {
      setFinishing(true);
      setStatus("Finishing transcription…");

      socket.send(JSON.stringify({ type: "stop" }));

      // Wait for the backend's "done" message — it needs to drain whatever
      // audio was already queued and flush any trailing unfinalized speech
      // before there's nothing left to send. A timeout fallback guards
      // against the rare case "done" never arrives for some reason.
      await new Promise<void>((resolve) => {
        doneResolverRef.current = resolve;
        setTimeout(resolve, TRANSCRIBE_TIMEOUT);
      });
      doneResolverRef.current = null;

      const now = Date.now();
      setLastMetrics({
        recordingSeconds: recordingStartRef.current ? (stopClickedAt - recordingStartRef.current) / 1000 : 0,
        drainSeconds: (now - stopClickedAt) / 1000,
      });
    }

    socketRef.current?.close();
    socketRef.current = null;

    setFinishing(false);
    setRecording(false);
    setStatus("Not recording");
  }

  return (
    <section className="rounded-lg border border-gray-200 p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Live transcription</h2>

      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={recording ? stopRecording : startRecording}
          disabled={finishing || (!loadedModelId && !recording)}
          className={`rounded-md text-white text-sm px-4 py-2 disabled:opacity-40 ${
            recording ? "bg-red-700" : "bg-gray-900"
          }`}
        >
          {finishing ? "Finishing…" : recording ? "Stop" : "Start"}
        </button>
        <span className="p-2 text-xs text-gray-500">{status}</span>
        
      </div>

      {!loadedModelId && !recording && (
        <p className="mb-3 text-xs text-gray-400">Load a speech-to-text model above to enable this.</p>
      )}

      <textarea
        value={transcript}
        onChange={(e) => onTranscriptChange(e.target.value)}
        placeholder="Live transcript will build here as you speak. Editable afterward."
        rows={6}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm resize-none"
      />

      {lastMetrics && (
        <p className="text-xs text-gray-500 mt-1">
          Last session: {lastMetrics.recordingSeconds.toFixed(1)}s recorded,{" "}
          {lastMetrics.drainSeconds.toFixed(1)}s to finish transcribing after Stop
        </p>
      )}
    </section>
  );
}