"use client";

import { useState } from "react";

interface TranscriptionPanelProps {
  apiUrl: string;
  loadedModelId: string | null;
  transcript: string;
  onTranscriptChange: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * Handles getting text out of audio: upload a file, transcribe it via the
 * STT backend, and show the result in an editable textarea — editable
 * because Whisper transcripts often need a quick manual fix before being
 * fed into the LLM for SOAP note generation.
 */
export default function TranscriptionPanel({
  apiUrl,
  loadedModelId,
  transcript,
  onTranscriptChange,
  onError,
}: TranscriptionPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeTime, setTranscribeTime] = useState(0.0);

  async function handleTranscribe() {
    if (!file || !loadedModelId) return;
    setTranscribing(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(
        `${apiUrl}/transcribe?model_id=${encodeURIComponent(loadedModelId)}`,
        { method: "POST", body: formData }
      );
      const data = await res.json();
      if (!res.ok) {
        onError(data.detail || `Transcription failed (${res.status})`);
      } else {
        onTranscriptChange(data.text);
        setTranscribeTime(data.metrics.processing_seconds);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <section className="rounded-lg border border-contain-border bg-main-bg p-4 w-full">
      <h2 className="text-sm font-medium text-text-dark mb-3">Audio transcript</h2>

      <div className="flex gap-2 mb-3">
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="flex-1 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm text-text-main file:bg-bg-2 file:text-text-2"
        />
        <button
          disabled={!file || !loadedModelId || transcribing}
          onClick={handleTranscribe}
          className="rounded-md bg-bg-2 text-text-2 text-sm px-4 py-2 disabled:opacity-40 whitespace-nowrap"
        >
          {transcribing ? "Transcribing…" : "Transcribe"}
        </button>
      </div>
      {!loadedModelId ? (
        <p className="mb-3 text-xs text-text-dark">Load an STT model above before transcribing.</p>
      ):(
        <p className="mb-3 text-xs text-text-dark">Transcribe time: {transcribeTime}</p>
      )}

      <textarea
        value={transcript}
        onChange={(e) => onTranscriptChange(e.target.value)}
        placeholder="Transcript will appear here — feel free to edit it before generating the SOAP note."
        rows={6}
        className="w-full rounded-md border border-button-border text-text-main px-3 py-2 text-sm resize-none"
      />
    </section>
  );
}
