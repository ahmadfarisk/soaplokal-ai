"use client";

import { useRef, useState } from "react";

interface CombinedTranscriptionPanelProps {
  apiUrl: string;
  loadedModelId: string | null;
  transcript: string;
  onTranscriptChange: (text: string) => void;
  onError: (message: string) => void;
}

// How long Stop waits for the backend to finish the queued phrases before giving up.
const TRANSCRIBE_TIMEOUT = 600000; // 10 minutes

/**
 * FastAPI returns `detail` as a string for our own errors, but as a LIST of
 * objects for validation errors. Rendering that list crashes React, so
 * always turn it into a plain string first.
 */
function detailMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : ""))
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return fallback;
}

/**
 * Two ways to get text into ONE transcript box:
 *   - choose an audio file and click Transcribe (replaces the transcript), or
 *   - click Record and speak (phrases are appended as you pause).
 * Only one of the two can run at a time.
 */
export default function CombinedTranscriptionPanel({
  apiUrl,
  loadedModelId,
  transcript,
  onTranscriptChange,
  onError,
}: CombinedTranscriptionPanelProps) {
  // File upload
  const [file, setFile] = useState<File | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  // Live recording
  const [recording, setRecording] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const [status, setStatus] = useState("Idle");
  const [statsText, setStatsText] = useState<string | null>(null);

  const recordingRef = useRef(false);
  const recordingStartRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  // Resolved when the backend's {"type": "done"} message arrives, so
  // stopRecording() can await it instead of closing the socket immediately.
  const doneResolverRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Ref, not state: the WebSocket callback below runs long after the render
  // that created it, so it needs the latest transcript, not a stale copy.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  const busy = transcribing || recording || finishing;

  // ----- File upload ------------------------------------------------------

  async function handleTranscribeFile() {
    if (!file || !loadedModelId) return;
    setTranscribing(true);
    setStatus("Transcribing audio file…");
    setStatsText(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${apiUrl}/transcribe?model_id=${encodeURIComponent(loadedModelId)}`, {
        method: "POST",
        body: formData,
      });
      const data: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        onError(detailMessage(data, `Transcription failed (${res.status})`));
      } else {
        const result = data as { text?: string; metrics?: { processing_seconds?: number } };
        onTranscriptChange(result.text ?? "");
        const seconds = result.metrics?.processing_seconds;
        if (typeof seconds === "number") setStatsText(`File transcribed in ${seconds.toFixed(1)}s`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
      setStatus("Idle");
    }
  }

  // ----- Live recording ---------------------------------------------------

  function releaseAudio() {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  async function startRecording() {
    if (!loadedModelId) {
      onError("Load a speech-to-text model before starting.");
      return;
    }

    try {
      const wsUrl =
        apiUrl.replace(/^http/, "ws") + `/ws/live-transcribe?model_id=${encodeURIComponent(loadedModelId)}`;

      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Could not connect to the live transcription socket."));
      });

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type?: string; text?: string };
          if (msg.type === "phrase" && msg.text) {
            const next = transcriptRef.current ? `${transcriptRef.current} ${msg.text}` : msg.text;
            onTranscriptChange(next);
          } else if (msg.type === "done") {
            // Backend finished draining its queue and flushing trailing
            // audio, so stopRecording()'s wait can resolve now.
            doneResolverRef.current?.();
          }
        } catch {
          // Ignore anything that isn't valid JSON; it shouldn't crash a live session.
        }
      };

      socket.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason, "clean:", event.wasClean);
        // If this happens while stopRecording() is waiting for "done",
        // don't leave that wait hanging.
        doneResolverRef.current?.();

        // The server dropped us while we were still recording: stop the
        // microphone and say so, instead of looking like it's still listening.
        if (recordingRef.current) {
          recordingRef.current = false;
          releaseAudio();
          setRecording(false);
          setStatus("Idle");
          onError("The live transcription connection was lost.");
        }
      };

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
      source.connect(workletNode); // not connected onward to the speakers, so there's no echo

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };

      recordingStartRef.current = Date.now();
      recordingRef.current = true;
      setStatsText(null);
      setRecording(true);
      setStatus("Recording — speak naturally, phrases will appear below as you pause.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      stopRecording();
    }
  }

  async function stopRecording() {
    const stopClickedAt = Date.now();
    const wasRecording = recordingRef.current;
    recordingRef.current = false;

    // Stop capturing NEW audio right away: nothing spoken after clicking
    // Stop should be recorded, even while we wait for what was already sent.
    releaseAudio();

    const socket = socketRef.current;

    if (socket && socket.readyState === WebSocket.OPEN) {
      setFinishing(true);
      setStatus("Finishing transcription…");

      socket.send(JSON.stringify({ type: "stop" }));

      // Wait for the backend's "done" message. A timeout guards against it never arriving.
      await new Promise<void>((resolve) => {
        doneResolverRef.current = resolve;
        setTimeout(resolve, TRANSCRIBE_TIMEOUT);
      });
      doneResolverRef.current = null;

      if (wasRecording) {
        const recordedSeconds = recordingStartRef.current ? (stopClickedAt - recordingStartRef.current) / 1000 : 0;
        const drainSeconds = (Date.now() - stopClickedAt) / 1000;
        setStatsText(
          `Last session: ${recordedSeconds.toFixed(1)}s recorded, ${drainSeconds.toFixed(1)}s to finish transcribing after Stop`
        );
      }
    }

    const toClose = socketRef.current;
    socketRef.current = null;
    toClose?.close();

    setFinishing(false);
    setRecording(false);
    setStatus("Idle");
  }

  // ----- Render -----------------------------------------------------------

  return (
    <section className="rounded-lg border border-contain-border bg-main-bg p-4 w-full border-amber-600">
      {/* <h2 className="text-sm font-medium text-text-dark mb-3">Transcription</h2> */}

      <div className="flex w-full h-full justify-center items-center gap-10">

        <div className="flex flex-wrap flex-col items-start justify-between gap-3 h-full">
          {/* Option 1: an audio file */}
          <div className="flex min-w-0 flex-col items-start gap-2">
            <p className="text-sm font-medium text-text-dark"> Transkripsi berkas suara </p>
            <input
              type="file"
              accept="audio/*"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="min-w-0 flex-1 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm text-text-main file:bg-bg-2 file:text-text-2 disabled:opacity-40"
            />
            <button
              disabled={!file || !loadedModelId || busy}
              onClick={handleTranscribeFile}
              className="rounded-md bg-bg-2 text-text-2 text-sm px-4 py-2 disabled:opacity-40 whitespace-nowrap"
            >
              {transcribing ? "Transcribing…" : "Transcribe"}
            </button>
          </div>

          {/* <span className="text-xs text-text-dark-2">or</span> */}

          {/* Option 2: record live */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-text-dark"> Transkripsi rekaman </p>
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={finishing || transcribing || (!loadedModelId && !recording)}
              className={`rounded-md text-sm px-4 py-2 disabled:opacity-40 whitespace-nowrap ${
                recording ? "bg-red-700 text-white" : "bg-bg-2 text-text-2"
              }`}
            >
              {finishing ? "Finishing…" : recording ? "Stop recording" : "Record"}
            </button>
          </div>
          

        </div>

        <div className="w-full h-full flex flex-col gap-2">
          <div>
            <p className="text-xs text-text-dark-2">
              Status: {!loadedModelId && !busy ? "Load a speech-to-text model above to enable transcription." : status}
            </p>

            {statsText ? <p className="text-xs text-text-dark-2 mt-1">{statsText}</p> : <p className="text-xs text-text-dark-2 mt-1"></p>}
          </div>

          <textarea
            value={transcript}
            onChange={(e) => onTranscriptChange(e.target.value)}
            placeholder="The transcript will appear here, from an audio file or a live recording. Feel free to edit it before generating the SOAP note."
            rows={6}
            className="w-full h-full rounded-md border border-button-border text-text-main px-3 py-2 text-sm resize-none"
          />
        </div>
      </div>
    </section>
  );
}