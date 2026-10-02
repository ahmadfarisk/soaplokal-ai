"use client";

import { useRef, useState } from "react";

interface LiveTranscriptionPanelProps {
  apiUrl: string;
  loadedModelId: string | null;
  transcript: string;
  onTranscriptChange: (text: string) => void;
  onError: (message: string) => void;
}

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
  const [status, setStatus] = useState("Not recording");

  const socketRef = useRef<WebSocket | null>(null);
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
          }
        } catch {
          // Ignore anything that isn't valid JSON — not expected, but
          // shouldn't crash a live session if it happens.
        }
      };
      socket.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason, "clean:", event.wasClean);
        setStatus("Not recording");
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // const stream = await navigator.mediaDevices.getUserMedia({
      //   audio: {
      //     echoCancellation: false,
      //     noiseSuppression: false,
      //     autoGainControl: false,
      //     channelCount: 1,
      //   },
      // });
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

      setRecording(true);
      setStatus("Recording — speak naturally, phrases will appear below as you pause.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
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
    setStatus("Not recording");
  }

  return (
    <section className="rounded-lg border border-gray-200 p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">Live transcription</h2>

      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={recording ? stopRecording : startRecording}
          disabled={!loadedModelId && !recording}
          className={`rounded-md text-white text-sm px-4 py-2 disabled:opacity-40 ${
            recording ? "bg-red-700" : "bg-gray-900"
          }`}
        >
          {recording ? "Stop" : "Start"}
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
    </section>
  );
}
