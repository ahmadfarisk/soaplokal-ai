"use client";

import { useEffect, useRef, useState } from "react";
import { StatItem, errorMessage, formatBytes, formatClock, ui } from "@/lib/studio";

// How long Stop waits for the backend to finish the queued phrases before giving up.
const FINISH_TIMEOUT_MS = 60000;

interface AudioInputProps {
  apiUrl: string;
  modelId: string | null;
  /** True while a SOAP note is being written, so a new capture can't start mid-way. */
  locked: boolean;
  /** Called when a new capture begins, so the page can clear the previous session. */
  onStart: () => void;
  onPhase: (phase: "recording" | "transcribing" | "idle") => void;
  /** Live text so far (called for every new phrase). */
  onTranscriptUpdate: (text: string) => void;
  /** Called once with the finished transcript. */
  onTranscriptReady: (text: string, stats: StatItem[]) => void;
  onError: (message: string) => void;
}

interface TranscribeResponse {
  text?: string;
  metrics?: {
    processing_seconds?: number;
    audio_seconds?: number | null;
    real_time_factor?: number | null;
  };
}

interface LiveMessage {
  type?: string;
  text?: string;
}

export default function AudioInput(props: AudioInputProps) {
  const { apiUrl, modelId, locked } = props;

  // Callbacks are read through a ref so long-lived WebSocket handlers never call stale versions.
  const cb = useRef(props);
  useEffect(() => {
    cb.current = props;
  });

  const [mode, setMode] = useState<"upload" | "live">("upload");

  // Upload mode
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Live mode
  const [recording, setRecording] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recordingRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const doneResolverRef = useRef<(() => void) | null>(null);
  const liveTextRef = useRef("");
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  function releaseAudio() {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function closeSocket() {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null; // we are closing on purpose; don't treat it as a lost connection
      socket.close();
    }
  }

  // Release the microphone and socket if the page is left mid-recording.
  useEffect(() => {
    return () => {
      recordingRef.current = false;
      releaseAudio();
      closeSocket();
    };
  }, []);

  // ----- Upload -----------------------------------------------------------

  function pickFile(candidate: File | undefined) {
    if (!candidate) return;
    const looksLikeAudio =
      candidate.type.startsWith("audio/") || /\.(wav|mp3|m4a|flac|ogg|aac|webm)$/i.test(candidate.name);
    if (!looksLikeAudio) {
      cb.current.onError("That doesn't look like an audio file.");
      return;
    }
    setFile(candidate);
  }

  async function transcribeFile() {
    if (!file || !modelId) return;
    cb.current.onStart();
    cb.current.onPhase("transcribing");
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${apiUrl}/transcribe?model_id=${encodeURIComponent(modelId)}`, {
        method: "POST",
        body: formData,
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        cb.current.onError(errorMessage(data, res.status));
        cb.current.onPhase("idle");
        return;
      }

      const result = data as TranscribeResponse;
      const text = (result.text ?? "").trim();
      const m = result.metrics;
      const stats: StatItem[] = [];
      if (m?.processing_seconds != null) stats.push({ label: "Processing", value: `${m.processing_seconds.toFixed(1)} s` });
      if (m?.audio_seconds != null) stats.push({ label: "Audio length", value: `${m.audio_seconds.toFixed(1)} s` });
      if (m?.real_time_factor != null) stats.push({ label: "Speed", value: `${m.real_time_factor.toFixed(2)}x real time` });

      cb.current.onTranscriptUpdate(text);
      cb.current.onTranscriptReady(text, stats);
    } catch (err) {
      cb.current.onError(err instanceof Error ? err.message : String(err));
      cb.current.onPhase("idle");
    } finally {
      setUploading(false);
    }
  }

  // ----- Live recording ---------------------------------------------------

  async function startRecording() {
    if (!modelId) {
      cb.current.onError("Load a speech-to-text model first.");
      return;
    }
    cb.current.onStart();
    liveTextRef.current = "";

    try {
      const wsUrl =
        apiUrl.replace(/^http/, "ws") + `/ws/live-transcribe?model_id=${encodeURIComponent(modelId)}`;
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Could not connect to the live transcription service."));
      });

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as LiveMessage;
          if (msg.type === "phrase" && msg.text) {
            // Kept in a ref, not read back from React state, so rapid phrases never overwrite each other.
            liveTextRef.current = liveTextRef.current ? `${liveTextRef.current} ${msg.text}` : msg.text;
            cb.current.onTranscriptUpdate(liveTextRef.current);
          } else if (msg.type === "done") {
            doneResolverRef.current?.();
          }
        } catch {
          // Ignore anything that isn't valid JSON; it shouldn't break a live session.
        }
      };

      socket.onclose = () => {
        doneResolverRef.current?.();
        if (recordingRef.current) {
          recordingRef.current = false;
          releaseAudio();
          setRecording(false);
          cb.current.onError("The live transcription connection was lost.");
          cb.current.onPhase("idle");
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule("/pcm-worklet-processor.js");

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-worklet-processor");
      workletNodeRef.current = workletNode;
      source.connect(workletNode); // not connected onward to the speakers, so there's no echo

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
      };

      startedAtRef.current = Date.now();
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 500);

      recordingRef.current = true;
      setRecording(true);
      cb.current.onPhase("recording");
    } catch (err) {
      recordingRef.current = false;
      releaseAudio();
      closeSocket();
      setRecording(false);
      cb.current.onError(err instanceof Error ? err.message : String(err));
      cb.current.onPhase("idle");
    }
  }

  async function stopRecording() {
    if (!recordingRef.current) return;
    const stopClickedAt = Date.now();
    recordingRef.current = false;
    setRecording(false);

    // Stop capturing new audio right away; only the already-sent audio still needs finishing.
    releaseAudio();

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      setFinishing(true);
      cb.current.onPhase("transcribing");
      socket.send(JSON.stringify({ type: "stop" }));

      // Wait for the backend to finish the queued phrases and send "done".
      await new Promise<void>((resolve) => {
        doneResolverRef.current = resolve;
        window.setTimeout(resolve, FINISH_TIMEOUT_MS);
      });
      doneResolverRef.current = null;
    }
    closeSocket();
    setFinishing(false);

    const text = liveTextRef.current.trim();
    if (!text) {
      cb.current.onError("No speech was picked up. Try again, a little closer to the microphone.");
      cb.current.onPhase("idle");
      return;
    }

    cb.current.onTranscriptReady(text, [
      { label: "Recorded", value: formatClock((stopClickedAt - startedAtRef.current) / 1000) },
      { label: "Finishing took", value: `${((Date.now() - stopClickedAt) / 1000).toFixed(1)} s` },
    ]);
  }

  // ----- Render -----------------------------------------------------------

  const captureBusy = uploading || recording || finishing;
  const noModel = !modelId;

  const liveHint = noModel
    ? "Load a speech-to-text model first."
    : finishing
    ? "Finishing the last phrases..."
    : recording
    ? "Listening. Text appears as you pause between sentences."
    : "Press Start and speak. Text appears as you pause between sentences.";

  return (
    <section className={ui.card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={ui.cardTitle}>Audio</h2>
          <p className={`${ui.muted} mt-0.5`}>Upload a recording, or record the consultation live.</p>
        </div>

        <div className="inline-flex rounded-full bg-slate-100 p-1" role="tablist" aria-label="Audio source">
          {(["upload", "live"] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={mode === tab}
              disabled={captureBusy}
              onClick={() => setMode(tab)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${
                mode === tab ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900 disabled:hover:text-slate-600"
              }`}
            >
              {tab === "upload" ? "Upload file" : "Record live"}
            </button>
          ))}
        </div>
      </div>

      {mode === "upload" ? (
        <div className="mt-5">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!captureBusy && !locked) pickFile(e.dataTransfer.files?.[0]);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
              dragOver
                ? "border-sky-400 bg-sky-50"
                : "border-slate-300 bg-slate-50 hover:border-sky-300 hover:bg-sky-50"
            } ${captureBusy || locked ? "pointer-events-none opacity-60" : ""}`}
          >
            <input
              type="file"
              accept="audio/*"
              className="sr-only"
              disabled={captureBusy || locked}
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
            <span className="text-sm font-medium text-slate-800">
              {file ? file.name : "Drop an audio file here, or click to browse"}
            </span>
            <span className="text-xs text-slate-600">
              {file ? formatBytes(file.size) : "WAV, MP3, M4A and other common audio formats"}
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              className={ui.primaryButton}
              onClick={transcribeFile}
              disabled={!file || noModel || captureBusy || locked}
            >
              {uploading && <span className={ui.spinner} />}
              {uploading ? "Transcribing..." : "Transcribe"}
            </button>
            {noModel && <span className="text-sm text-slate-600">Load a speech-to-text model first.</span>}
          </div>
        </div>
      ) : (
        <div className="mt-5 flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-6 py-8">
          <div className="relative flex h-24 w-24 items-center justify-center">
            {recording && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-300 opacity-60" />
            )}
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={finishing || locked || uploading || (noModel && !recording)}
              className={`relative h-20 w-20 rounded-full text-sm font-semibold text-white shadow-md focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:shadow-none ${
                recording
                  ? "bg-rose-600 hover:bg-rose-700 focus:ring-rose-200"
                  : "bg-sky-600 hover:bg-sky-700 focus:ring-sky-200"
              }`}
            >
              {finishing ? "..." : recording ? "Stop" : "Start"}
            </button>
          </div>
          <p className="text-3xl font-semibold tabular-nums text-slate-800">{formatClock(elapsed)}</p>
          <p className="text-center text-sm text-slate-600">{liveHint}</p>
        </div>
      )}
    </section>
  );
}