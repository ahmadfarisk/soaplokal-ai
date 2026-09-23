"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface ModelInfo {
  id: string;
  repo_id: string;
  filename: string;
  status: string;
  local_path: string | null;
}

export default function StudioPage() {
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Fields for downloading a NEW model
  const [newModelId, setNewModelId] = useState("");
  const [newRepoId, setNewRepoId] = useState("");
  const [newFilename, setNewFilename] = useState("");

  // Known models (populated by "List Models" / "Refresh List") + which one
  // is selected for status/load/unload/delete actions
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");

  function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
  }

  async function callApi(
    label: string,
    path: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: object
  ): Promise<any | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    setBusy(true);
    log(`→ ${label}: ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        log(`✗ ${label} failed (${res.status}): ${JSON.stringify(data)}`);
        return null;
      }
      log(`✓ ${label} succeeded: ${JSON.stringify(data)}`);
      return data;
    } catch (err) {
      log(`✗ ${label} error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshModels() {
    const data = await callApi("List models", "/models");
    if (data) {
      setModels(data);
      // If nothing selected yet, or the selected one no longer exists, pick the first
      if (data.length > 0 && !data.some((m: ModelInfo) => m.id === selectedModelId)) {
        setSelectedModelId(data[0].id);
      }
    }
  }

  async function handleDownload() {
    if (!newModelId || !newRepoId || !newFilename) {
      log("✗ Fill in Model ID, Repo ID, and Filename before downloading.");
      return;
    }
    await callApi("Download model", "/models/download", "POST", {
      model_id: newModelId,
      repo_id: newRepoId,
      filename: newFilename,
    });
    await refreshModels();
  }

  async function handleDelete() {
    if (!selectedModelId) return;
    await callApi("Delete model", `/models/${selectedModelId}`, "DELETE");
    setSelectedModelId("");
    await refreshModels();
  }

  const inputStyle: React.CSSProperties = {
    padding: 8,
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 4,
  };

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", fontFamily: "sans-serif", padding: "0 16px" }}>
      <h1>Mini Edge AI Studio</h1>

      {/* --- Download a new model --- */}
      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Download a new model</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 480 }}>
          <input
            style={inputStyle}
            placeholder="Model ID (e.g. qwen2.5-1.5b-q4)"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
          />
          <input
            style={inputStyle}
            placeholder="Repo ID (e.g. bartowski/Qwen2.5-1.5B-Instruct-GGUF)"
            value={newRepoId}
            onChange={(e) => setNewRepoId(e.target.value)}
          />
          <input
            style={inputStyle}
            placeholder="Filename (e.g. Qwen2.5-1.5B-Instruct-Q4_K_M.gguf)"
            value={newFilename}
            onChange={(e) => setNewFilename(e.target.value)}
          />
          <button className="hover:text-green-500" disabled={busy} onClick={handleDownload} style={{ alignSelf: "flex-start" }}>
            Download
          </button>
        </div>
      </section>

      
      <section style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        {/* Model Select */}
        <h3 style={{ marginTop: 0 }}>Select a model</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <select
            style={{ ...inputStyle, flex: 1 }}
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            className="text-gray-200 bg-black"
          >
            <option value="">-- no model selected --</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} ({m.status})
              </option>
            ))}
          </select>
          <button className="hover:text-green-500" disabled={busy} onClick={refreshModels}>
            Refresh List
          </button>
        </div>
        
        {/* Buttons */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            className="hover:text-green-500"
            disabled={busy || !selectedModelId}
            onClick={() => callApi("Check status", `/models/${selectedModelId}/status`)}
          >
            Check Status
          </button>
          <button
            className="hover:text-green-500"
            disabled={busy || !selectedModelId}
            onClick={() => callApi("Load model", `/models/${selectedModelId}/load`, "POST")}
          >
            Load Model
          </button>
          <button
            className="hover:text-green-500"
            disabled={busy || !selectedModelId}
            onClick={() => callApi("Unload model", `/models/${selectedModelId}/unload`, "POST")}
          >
            Unload Model
          </button>
          <button className="hover:text-green-500" disabled={busy} onClick={() => callApi("List loaded", "/models/loaded")}>
            List Loaded
          </button>
          <button className="hover:text-green-500" disabled={busy || !selectedModelId} onClick={handleDelete}>
            Delete Model
          </button>
        </div>
      </section>

      {/* --- Logs --- */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {/* <h3>Logs</h3> */}
        <div></div>
        <button className="hover:text-green-500" onClick={() => setLogs([])}>Clear Logs</button>
      </div>
      <textarea
        readOnly
        value={logs.join("\n")}
        placeholder="Logs will appear here..."
        style={{
          width: "100%",
          height: 350,
          fontFamily: "monospace",
          fontSize: 13,
          padding: 12,
          boxSizing: "border-box",
          backgroundColor: "#111",
          color: "#0f0",
          resize: "vertical",
        }}
      />
    </main>
  );
}
