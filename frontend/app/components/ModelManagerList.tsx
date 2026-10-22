"use client";

import { useEffect, useState } from "react";

interface ModelInfo {
  id: string;
  hf_model_id: string;
  repo_id: string;
  engine?: string;
  status: string;
  local_path: string | null;
  size_bytes?: number | null;
}

interface ModelManagerListProps {
  title: string;
  apiUrl: string;
  onError: (message: string) => void;
  /** Bumped by the parent after a download starts, to trigger a refresh. */
  refreshSignal?: number;
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Lists every model known to a service's registry, with a Delete button
 * per row. Deleting calls DELETE /models/{id} — the backend already
 * unloads the model first if it's currently loaded, so this is safe to
 * call regardless of load state.
 */
export default function ModelManagerList({ title, apiUrl, onError, refreshSignal }: ModelManagerListProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Refresh on mount, and whenever the parent bumps refreshSignal
  // (e.g. right after a download was started from a DownloadPanel above this list).
  // useEffect(() => {
  //   refreshModels();
  //   // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [refreshSignal]);

  async function handleDelete(modelId: string) {
    setDeletingId(modelId);
    try {
      const res = await fetch(`${apiUrl}/models/${modelId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        onError(data.detail || `Failed to delete model (${res.status})`);
        return;
      }
      setModels((prev) => prev.filter((m) => m.id !== modelId));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="rounded-lg border border-contain-border bg-main-bg p-4 w-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-dark">{title}</h2>
        <button
          disabled={busy}
          onClick={refreshModels}
          className="rounded-md border border-button-border text-xs px-3 py-1.5 disabled:opacity-40 bg-main-bg text-text-main"
        >
          Refresh
        </button>
      </div>

      {models.length === 0 ? (
        <p className="text-sm text-text-dark">
          {busy ? "Loading…" : "No models downloaded yet."}
        </p>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-md border border-button-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-text-main truncate">{ m.hf_model_id == null ? m.repo_id : m.hf_model_id }</p>
                <p className="text-xs text-text-dark truncate">
                  {m.engine ? `${m.engine} · ` : ""}
                  {m.status}
                  {m.size_bytes ? ` · ${formatSize(m.size_bytes)}` : ""}
                </p>
              </div>
              <button
                disabled={deletingId === m.id}
                onClick={() => handleDelete(m.id)}
                className="shrink-0 rounded-md border border-red-800 text-text-fail text-xs px-3 py-1.5 disabled:opacity-40 hover:bg-red-950"
              >
                {deletingId === m.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
