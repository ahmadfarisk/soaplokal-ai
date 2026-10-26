"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage, ui } from "@/lib/studio";

interface ModelInfo {
  id: string;
  engine?: string;
  status: string;
}

export interface DownloadOption {
  model_id: string;
  label: string;
  /** Extra request fields for this model, e.g. { hf_model_id: "..." } */
  extra: Record<string, string>;
}

interface ModelCardProps {
  title: string;
  description: string;
  apiUrl: string;
  loadedModelId: string | null;
  onLoadedChange: (modelId: string | null) => void;
  onError: (message: string) => void;
  /** "dropdown": pick from a fixed list. "freeform": type in the details yourself. */
  downloadMode: "dropdown" | "freeform";
  downloadOptions?: DownloadOption[];
  /** Disable load/unload while the pipeline is busy. */
  locked?: boolean;
}

export default function ModelCard({
  title,
  description,
  apiUrl,
  loadedModelId,
  onLoadedChange,
  onError,
  downloadMode,
  downloadOptions = [],
  locked = false,
}: ModelCardProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [working, setWorking] = useState<"load" | "unload" | null>(null);
  const [loadSeconds, setLoadSeconds] = useState<number | null>(null);
  const [useGpu, setUseGpu] = useState<boolean>(true);

  // Download form
  const [dlBusy, setDlBusy] = useState(false);
  const [dlStatus, setDlStatus] = useState<string | null>(null);
  const [dlChoice, setDlChoice] = useState("");
  const [dlEngine, setDlEngine] = useState<"llama_cpp" | "openvino">("llama_cpp");
  const [dlModelId, setDlModelId] = useState("");
  const [dlRepoId, setDlRepoId] = useState("");
  const [dlFilename, setDlFilename] = useState("");
  const [dlHfId, setDlHfId] = useState("");

  const refreshModels = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/models`);
      setReachable(true);
      if (!res.ok) return;
      const data: unknown = await res.json();
      const list = Array.isArray(data) ? (data as ModelInfo[]) : [];
      setModels(list);
      setSelectedId((current) => {
        if (current && list.some((m) => m.id === current)) return current;
        const firstReady = list.find((m) => m.status === "ready");
        return firstReady ? firstReady.id : "";
      });
    } catch {
      setReachable(false);
    }
  }, [apiUrl]);

  // On first render: load the model list, and pick up a model the backend
  // already has loaded (e.g. after refreshing the page).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshModels();
      try {
        const res = await fetch(`${apiUrl}/models/loaded`);
        if (!res.ok || cancelled) return;
        const data: unknown = await res.json();
        if (!data || typeof data !== "object") return;
        const ids = Object.keys(data as Record<string, unknown>);
        if (ids.length > 0 && !cancelled) {
          setSelectedId(ids[0]);
          onLoadedChange(ids[0]);
        }
      } catch {
        // Backend unreachable: the "reachable" flag already tells the user.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  // While anything is downloading, refresh the list every few seconds.
  const hasDownloading = models.some((m) => m.status === "downloading");
  useEffect(() => {
    if (!hasDownloading) return;
    const timer = window.setInterval(refreshModels, 3000);
    return () => window.clearInterval(timer);
  }, [hasDownloading, refreshModels]);

  async function post(path: string): Promise<{ ok: boolean; data: unknown; status: number }> {
    const res = await fetch(`${apiUrl}${path}`, { method: "POST" });
    const data: unknown = await res.json().catch(() => ({}));
    return { ok: res.ok, data, status: res.status };
  }

  async function handleLoad() {
    if (!selectedId) return;
    setWorking("load");
    try {
      // Free the previously loaded model first, so two models never sit in memory at once.
      if (loadedModelId && loadedModelId !== selectedId) {
        await post(`/models/${encodeURIComponent(loadedModelId)}/unload`);
        onLoadedChange(null);
      }
      // Loading
      // const query = `?use_gpu=${useGpu}`;
      // const { ok, data, status } = await post(`/models/${encodeURIComponent(selectedId)}/load${query}`);
      // if (!ok) {
      //   onError(errorMessage(data, status));
      //   return;
      // }
      // const seconds = (data as { load_seconds?: unknown }).load_seconds;
      // setLoadSeconds(typeof seconds === "number" ? seconds : null);
      // onLoadedChange(selectedId);
      const query = `?use_gpu=${useGpu}`;
      const res = await fetch(`${apiUrl}/models/${encodeURIComponent(selectedId)}/load${query}`, { method: "POST" });
      const data = await res.json()
      if (!res.ok) {
        onError(errorMessage(data, res.status));
        return;
      }
      const seconds = (data as { load_seconds?: unknown }).load_seconds;
      setLoadSeconds(typeof seconds === "number" ? seconds : null);
      onLoadedChange(selectedId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  }

  async function handleUnload() {
    if (!loadedModelId) return;
    setWorking("unload");
    try {
      await post(`/models/${encodeURIComponent(loadedModelId)}/unload`);
      setLoadSeconds(null);
      onLoadedChange(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  }

  async function startDownload(body: Record<string, string>) {
    setDlBusy(true);
    setDlStatus(null);
    try {
      const res = await fetch(`${apiUrl}/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(errorMessage(data, res.status));
        return;
      }
      const status = (data as { status?: string }).status;
      setDlStatus(
        status === "already_downloaded"
          ? "That model is already downloaded."
          : "Download started. It will show up in the list above when it is ready."
      );
      await refreshModels();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDlBusy(false);
    }
  }

  function submitDownload() {
    if (downloadMode === "dropdown") {
      const option = downloadOptions.find((o) => o.model_id === dlChoice);
      if (!option) {
        onError("Choose a model to download first.");
        return;
      }
      void startDownload({ model_id: option.model_id, ...option.extra });
      return;
    }

    if (!dlModelId.trim()) {
      onError("Give the model a short ID first.");
      return;
    }
    if (dlEngine === "llama_cpp") {
      if (!dlRepoId.trim() || !dlFilename.trim()) {
        onError("Fill in both the Hugging Face repo and the file name.");
        return;
      }
      void startDownload({
        model_id: dlModelId.trim(),
        engine: "llama_cpp",
        repo_id: dlRepoId.trim(),
        filename: dlFilename.trim(),
      });
    } else {
      if (!dlHfId.trim()) {
        onError("Fill in the Hugging Face model ID.");
        return;
      }
      void startDownload({ model_id: dlModelId.trim(), engine: "openvino", hf_model_id: dlHfId.trim() });
    }
  }

  const isLoaded = loadedModelId !== null;
  const busy = working !== null || locked;

  return (
    <section className={ui.card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className={ui.cardTitle}>{title}</h2>
          <p className={`${ui.muted} mt-0.5`}>{description}</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
            isLoaded
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-100 text-slate-600"
          }`}
        >
          {isLoaded ? "Loaded" : "Not loaded"}
        </span>
      </div>

      {reachable === false && (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Can&apos;t reach this service at {apiUrl}. Is it running?
        </p>
      )}

      <div className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-slate-700" htmlFor={`model-${title}`}>
          Model
        </label>
        <select
          id={`model-${title}`}
          className={ui.input}
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={busy}
        >
          <option value="">{models.length === 0 ? "No models downloaded yet" : "Choose a model"}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id} disabled={m.status !== "ready"}>
              {m.id}
              {m.engine ? ` (${m.engine})` : ""}
              {m.status !== "ready" ? ` - ${m.status}` : ""}
            </option>
          ))}
        </select>

        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <button className={ui.primaryButton} onClick={handleLoad} disabled={busy || !selectedId}>
              {working === "load" && <span className={ui.spinner} />}
              {working === "load" ? "Loading..." : isLoaded && loadedModelId !== selectedId ? "Switch to this model" : "Load"}
            </button>
            <button className={ui.secondaryButton} onClick={handleUnload} disabled={busy || !isLoaded}>
              {working === "unload" ? "Unloading..." : "Unload"}
            </button>
            <button className={ui.secondaryButton} onClick={refreshModels} disabled={working !== null}>
              Refresh
            </button>
          </div>
          
          <label className="flex items-center gap-2 text-xs text-text-dark mx-1">
            <input type="checkbox" checked={useGpu} onChange={(e) => setUseGpu(e.target.checked)} />
            Use GPU
          </label>
          
        </div>

        {isLoaded && (
          <p className="text-sm text-slate-600">
            Using <span className="font-medium text-slate-800">{loadedModelId}</span>
            {loadSeconds !== null && ` (loaded in ${loadSeconds.toFixed(1)} s)`}
          </p>
        )}
      </div>

      <details className="group mt-5 rounded-2xl border border-slate-200 bg-slate-50">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-slate-700">
          Unduh model
          <span className="text-xs font-normal text-slate-600">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </summary>

        <div className="space-y-3 border-t border-slate-200 px-4 py-4">
          {downloadMode === "dropdown" ? (
            downloadOptions.length === 0 ? (
              <p className="text-sm text-slate-600">No downloadable models are configured yet.</p>
            ) : (
              <select className={ui.input} value={dlChoice} onChange={(e) => setDlChoice(e.target.value)}>
                <option value="">Choose a model</option>
                {downloadOptions.map((o) => (
                  <option key={o.model_id} value={o.model_id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )
          ) : (
            <>
              <select
                className={ui.input}
                value={dlEngine}
                onChange={(e) => setDlEngine(e.target.value as "llama_cpp" | "openvino")}
              >
                <option value="llama_cpp">llama.cpp (GGUF file)</option>
                <option value="openvino">OpenVINO (pre-converted)</option>
              </select>
              {dlEngine === "llama_cpp" ? (
                <>
                  <input
                    className={ui.input}
                    placeholder="Short ID for this model (e.g. Qwen3-4B-Instruct-2507-Q4_K_M)"
                    value={dlModelId}
                    onChange={(e) => setDlModelId(e.target.value)}
                  />
                  <input
                    className={ui.input}
                    placeholder="Hugging Face repo (e.g. lmstudio-community/Qwen3-4B-Instruct-2507-GGUF)"
                    value={dlRepoId}
                    onChange={(e) => setDlRepoId(e.target.value)}
                  />
                  <input
                    className={ui.input}
                    placeholder="File name (e.g. Qwen3-4B-Instruct-2507-Q4_K_M.gguf)"
                    value={dlFilename}
                    onChange={(e) => setDlFilename(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <input
                    className={ui.input}
                    placeholder="Short ID for this model (e.g. Qwen2.5-1.5B-Instruct-int8-ov)"
                    value={dlModelId}
                    onChange={(e) => setDlModelId(e.target.value)}
                  />
                  <input
                    className={ui.input}
                    placeholder="Hugging Face model ID (e.g. OpenVINO/Qwen2.5-1.5B-Instruct-int8-ov)"
                    value={dlHfId}
                    onChange={(e) => setDlHfId(e.target.value)}
                  />
                </>
                
              )}
            </>
          )}

          {(downloadMode === "freeform" || downloadOptions.length > 0) && (
            <button className={ui.primaryButton} onClick={submitDownload} disabled={dlBusy}>
              {dlBusy && <span className={ui.spinner} />}
              {dlBusy ? "Starting..." : "Download"}
            </button>
          )}
          {dlStatus && <p className="text-sm text-slate-600">{dlStatus}</p>}
          {hasDownloading && (
            <p className="flex items-center gap-2 text-sm text-amber-800">
              <span className={ui.spinner} />
              A download is in progress. This list updates by itself.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}