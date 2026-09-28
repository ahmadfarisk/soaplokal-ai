"use client";

import { useState } from "react";

interface ModelInfo {
  id: string;
  status: string;
  engine?: string;  // optional so it doesn't break when used for STT models (no engine field there)
}

interface ModelPanelProps {
  title: string;
  apiUrl: string;
  loadedModelId: string | null;
  onLoadedChange: (modelId: string | null) => void;
  onError: (message: string) => void;
}

/**
 * Generic "pick a downloaded model, load it, unload it" panel.
 * Used once for the STT service and once for the LLM service —
 * both expose the same GET /models, POST /models/{id}/load,
 * POST /models/{id}/unload shape, so one component covers both.
 */
export default function ModelPanel({
  title,
  apiUrl,
  loadedModelId,
  onLoadedChange,
  onError,
}: ModelPanelProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshModels() {
    setBusy(true);
    try {
      const res = await fetch(`${apiUrl}/models`);
      const data = await res.json();
      if (!res.ok) {
        onError(data.detail || `Failed to list models (${res.status})`);
        return;
      }
      setModels(data);
      if (data.length > 0 && !data.some((m: ModelInfo) => m.id === selectedModelId)) {
        setSelectedModelId(data[0].id);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoad() {
    if (!selectedModelId) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiUrl}/models/${selectedModelId}/load`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        onError(data.detail || `Failed to load model (${res.status})`);
        return;
      }
      onLoadedChange(selectedModelId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnload() {
    if (!loadedModelId) return;
    setBusy(true);
    try {
      await fetch(`${apiUrl}/models/${loadedModelId}/unload`, { method: "POST" });
      onLoadedChange(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 p-4">
      <h2 className="text-sm font-medium text-gray-400 mb-3">{title}</h2>

      <div className="flex gap-2 mb-3">
        <select
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm text-white bg-black"
          value={selectedModelId}
          onChange={(e) => setSelectedModelId(e.target.value)}
        >
          <option value="">-- no model selected --</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} {m.engine ? `— ${m.engine} ` : ""}({m.status})
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
  );
}
