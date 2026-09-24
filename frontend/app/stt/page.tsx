"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_STT_API_URL || "http://localhost:8001";

// Fill this in with the Whisper variants you want users to be able to download.
// Shape: { model_id: <your internal id>, hf_model_id: <HF repo>, label: <shown in dropdown> }
const DOWNLOADABLE_MODELS: { model_id: string; hf_model_id: string; label: string }[] = [
  {
    model_id: 'whisper-tiny-int8-ov',
    hf_model_id: 'OpenVINO/whisper-tiny-int8-ov',
    label: 'Whisper Tiny (INT8)'
  },
  {
    model_id: 'whisper-base-int8-ov',
    hf_model_id: 'OpenVINO/whisper-base-int8-ov',
    label: 'Whisper Base (INT8)'
  },
  {
    model_id: 'whisper-small-int8-ov',
    hf_model_id: 'OpenVINO/whisper-small-int8-ov',
    label: 'Whisper Small (INT8)'
  },
  {
    model_id: 'whisper-medium-int8-ov',
    hf_model_id: 'OpenVINO/whisper-medium-int8-ov',
    label: 'Whisper Medium (INT8)'
  },
];


interface ModelInfo {
  id: string;
  hf_model_id: string;
  status: string;
  local_path: string | null;
}

export default function STTStudioPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Section 1: download a new model
  const [downloadChoice, setDownloadChoice] = useState("");

  // Section 2: select + load/unload an existing model
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [loadedModelId, setLoadedModelId] = useState<string | null>(null);

  // Section 3/4: transcription
  const [file, setFile] = useState<File | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [resultText, setResultText] = useState("");

  async function callApi(
    path: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || `Request failed (${res.status})`);
        return null;
      }
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshModels() {
    const data = await callApi("/models");
    if (data) {
      setModels(data);
      if (data.length > 0 && !data.some((m: ModelInfo) => m.id === selectedModelId)) {
        setSelectedModelId(data[0].id);
      }
    }
  }

  async function handleDownload() {
    const choice = DOWNLOADABLE_MODELS.find((m) => m.model_id === downloadChoice);
    if (!choice) {
      setError("Select a model to download.");
      return;
    }
    await callApi("/models/download", "POST", {
      model_id: choice.model_id,
      hf_model_id: choice.hf_model_id,
    });
    await refreshModels();
  }

  async function handleLoad() {
    if (!selectedModelId) return;
    const result = await callApi(`/models/${selectedModelId}/load`, "POST");
    if (result) setLoadedModelId(selectedModelId);
  }

  async function handleUnload() {
    if (!loadedModelId) return;
    await callApi(`/models/${loadedModelId}/unload`, "POST");
    setLoadedModelId(null);
  }

  async function handleTranscribe() {
    if (!file || !loadedModelId) return;
    setTranscribing(true);
    setError(null);
    setResultText("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(
        `${API_URL}/transcribe?model_id=${encodeURIComponent(loadedModelId)}`,
        { method: "POST", body: formData }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || `Transcription failed (${res.status})`);
      } else {
        setResultText(data.text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 font-sans">
      <h1 className="text-2xl font-semibold mb-6">Mini Local AI Studio — STT</h1>

      {error && (
        <div className="mb-6 rounded-md bg-red-50 text-red-800 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {/* 1. Download a model */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-700 mb-3">Download a model</h2>
        <div className="flex gap-2">
          <select
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm bg-black text-white"
            value={downloadChoice}
            onChange={(e) => setDownloadChoice(e.target.value)}
          >
            <option value="">-- select a model --</option>
            {DOWNLOADABLE_MODELS.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !downloadChoice}
            onClick={handleDownload}
            className="rounded-md bg-gray-900 text-white text-sm px-4 py-2 disabled:opacity-40"
          >
            Download
          </button>
        </div>
      </section>

      {/* 2. Select / load / unload a model */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-700 mb-3">Select a model</h2>
        <div className="flex gap-2 mb-3">
          <select
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm bg-black text-white"
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
          >
            <option value="">-- no model selected --</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} ({m.status})
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={refreshModels}
            className="rounded-md border border-gray-300 text-sm px-4 py-2 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={busy || !selectedModelId}
            onClick={handleLoad}
            className="rounded-md bg-gray-900 text-white text-sm px-4 py-2 disabled:opacity-40"
          >
            Load
          </button>
          <button
            disabled={busy || !loadedModelId}
            onClick={handleUnload}
            className="rounded-md border border-gray-300 text-sm px-4 py-2 disabled:opacity-40"
          >
            Unload
          </button>
          <span className={`text-xs ${loadedModelId ? "text-green-700" : "text-gray-400"}`}>
            {loadedModelId ? `Loaded: ${loadedModelId}` : "No model loaded"}
          </span>
        </div>
      </section>

      {/* 3. Upload audio + transcribe */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-700 mb-3">Upload audio</h2>
        <div className="flex gap-2">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="flex-1 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm"
          />
          <button
            disabled={!file || !loadedModelId || transcribing}
            onClick={handleTranscribe}
            className="rounded-md bg-gray-900 text-white text-sm px-4 py-2 disabled:opacity-40"
          >
            {transcribing ? "Transcribing…" : "Transcribe"}
          </button>
        </div>
        {!loadedModelId && (
          <p className="mt-2 text-xs text-gray-400">Load a model above before transcribing.</p>
        )}
      </section>

      {/* 4. Result */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-medium text-gray-700 mb-3">Result</h2>
        <textarea
          readOnly
          value={resultText}
          placeholder="Transcribed text will appear here..."
          rows={6}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm resize-none"
        />
      </section>

      {/* 5. Placeholder: record audio directly */}
      <section className="rounded-lg border border-dashed border-gray-300 p-4">
        <h2 className="text-sm font-medium text-gray-400 mb-1">Record audio (coming soon)</h2>
        <p className="text-xs text-gray-400">
          This section will let you record directly from your microphone instead of
          uploading a file.
        </p>
      </section>
    </main>
  );
}
