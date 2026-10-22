"use client";

import { useState } from "react";

interface DownloadableModel {
  model_id: string;
  label: string;
  // Dropdown mode sends this extra field (e.g. hf_model_id) alongside model_id.
  // Keyed generically so this component doesn't need to know the field name.
  extra: Record<string, string>;
}

interface DownloadPanelProps {
  title: string;
  apiUrl: string;
  /** "dropdown": pick from a fixed list. "freeform": type in the details yourself. */
  mode: "dropdown" | "freeform";
  /** Required when mode="dropdown". */
  options?: DownloadableModel[];
  onDownloadStarted?: () => void;
  onError: (message: string) => void;
}

/**
 * Collapsed by default (native <details>, no extra JS needed for the toggle)
 * so this doesn't compete for attention with the main workflow above it.
 * Two modes cover both services as they currently work:
 *   - "dropdown": STT-style — pick from a fixed, pre-approved list of models
 *   - "freeform": LLM-style — type in model_id / repo_id / filename yourself
 */
export default function DownloadPanel({
  title,
  apiUrl,
  mode,
  options = [],
  onDownloadStarted,
  onError,
}: DownloadPanelProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Dropdown mode state
  const [selectedOption, setSelectedOption] = useState("");

  // Freeform mode state
  const [freeEngine, setFreeEngine] = useState<"llama_cpp" | "openvino">("llama_cpp");
  const [freeModelId, setFreeModelId] = useState("");
  const [freeRepoId, setFreeRepoId] = useState("");
  const [freeFilename, setFreeFilename] = useState("");
  const [freeHfModelId, setFreeHfModelId] = useState("");

  async function startDownload(body: Record<string, unknown>) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`${apiUrl}/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        onError(data.detail || `Download failed to start (${res.status})`);
        return;
      }
      setStatus(
        data.status === "already_downloaded"
          ? "Already downloaded."
          : "Download started — check the model list once it's ready."
      );
      onDownloadStarted?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleDropdownDownload() {
    const choice = options.find((o) => o.model_id === selectedOption);
    if (!choice) {
      onError("Select a model to download.");
      return;
    }
    startDownload({ model_id: choice.model_id, ...choice.extra });
  }

  function handleFreeformDownload() {
    if (!freeModelId) {
      onError("Fill in a Model ID before downloading.");
      return;
    }

    if (freeEngine === "llama_cpp") {
      if (!freeRepoId || !freeFilename) {
        onError("Fill in Repo ID and Filename before downloading.");
        return;
      }
      startDownload({
        model_id: freeModelId,
        engine: "llama_cpp",
        repo_id: freeRepoId,
        filename: freeFilename,
      });
    } else {
      if (!freeHfModelId) {
        onError("Fill in the Hugging Face model ID before downloading.");
        return;
      }
      startDownload({
        model_id: freeModelId,
        engine: "openvino",
        hf_model_id: freeHfModelId,
      });
    }
  }

  return (
    <details className="rounded-lg border border-contain-border bg-main-bg group w-full">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-text-dark flex items-center justify-between">
        {title}
        <span className="text-text-dark text-xs group-open:rotate-180 transition-transform">▾</span>
      </summary>

      <div className="px-4 pb-4 pt-1">
        {mode === "dropdown" ? (
          // STT Download
          <div className="flex gap-2">
            <select
              className="flex-1 rounded-md border border-button-border px-3 py-2 text-sm text-text-main bg-main-bg"
              value={selectedOption}
              onChange={(e) => setSelectedOption(e.target.value)}
            >
              <option value="">-- select a model --</option>
              {options.map((o) => (
                <option key={o.model_id} value={o.model_id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              disabled={busy || !selectedOption}
              onClick={handleDropdownDownload}
              className="rounded-md bg-bg-2 text-text-2 text-sm px-4 py-2 disabled:opacity-40 cursor-pointer disabled:cursor-default"
            >
              Download
            </button>
          </div>
        ) : (
          // LLM Download
          <div className="flex flex-col gap-2 text-text-main">
            <select
              className="rounded-md border border-button-border px-3 py-2 text-sm text-text-main bg-main-bg"
              value={freeEngine}
              onChange={(e) => setFreeEngine(e.target.value as "llama_cpp" | "openvino")}
            >
              <option value="llama_cpp">llama.cpp (GGUF)</option>
              <option value="openvino">OpenVINO (pre-converted)</option>
            </select>

            {freeEngine === "llama_cpp" ? (
              <>
                <input
                  className="rounded-md border border-button-border px-3 py-2 text-sm placeholder-text-dark-2"
                  placeholder="Model ID (e.g. Qwen3-4B-Instruct-2507-Q4_K_M)"
                  value={freeModelId}
                  onChange={(e) => setFreeModelId(e.target.value)}
                />
                <input
                  className="rounded-md border border-button-border px-3 py-2 text-sm placeholder-text-dark-2"
                  placeholder="Repo ID (e.g. lmstudio-community/Qwen3-4B-Instruct-2507-GGUF)"
                  value={freeRepoId}
                  onChange={(e) => setFreeRepoId(e.target.value)}
                />
                <input
                  className="rounded-md border border-button-border px-3 py-2 text-sm placeholder-text-dark-2"
                  placeholder="Filename (e.g. Qwen3-4B-Instruct-2507-Q4_K_M.gguf)"
                  value={freeFilename}
                  onChange={(e) => setFreeFilename(e.target.value)}
                />
              </>
            ) : (
              <>
                <input
                  className="rounded-md border border-button-border px-3 py-2 text-sm placeholder-text-dark-2"
                  placeholder="Model ID (e.g. Qwen2.5-1.5B-Instruct-openvino-8bit)"
                  value={freeModelId}
                  onChange={(e) => setFreeModelId(e.target.value)}
                />
                <input
                  className="rounded-md border border-button-border px-3 py-2 text-sm placeholder-text-dark-2"
                  placeholder="Hugging Face model ID (e.g. hsuwill000/Qwen2.5-1.5B-Instruct-openvino-8bit)"
                  value={freeHfModelId}
                  onChange={(e) => setFreeHfModelId(e.target.value)}
                />
              </>
            )}

            <button
              disabled={busy}
              onClick={handleFreeformDownload}
              className="self-start rounded-md bg-bg-2 text-text-2 text-sm px-4 py-2 disabled:opacity-40 cursor-pointer disabled:cursor-default"
            >
              Download
            </button>
          </div>
        )}

        {status && <p className="mt-2 text-xs text-text-dark">{status}</p>}
      </div>
    </details>
  );
}