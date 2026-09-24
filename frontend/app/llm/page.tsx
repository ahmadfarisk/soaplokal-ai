"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_LLM_API_URL || "http://localhost:8000";

interface ModelInfo {
  id: string;
  repo_id: string;
  filename: string;
  status: string;
  local_path: string | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function StudioPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fields for downloading a NEW model
  const [newModelId, setNewModelId] = useState("");
  const [newRepoId, setNewRepoId] = useState("");
  const [newFilename, setNewFilename] = useState("");

  // Known models + which one is selected
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [loadedModelId, setLoadedModelId] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);

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
    if (!newModelId || !newRepoId || !newFilename) {
      setError("Fill in Model ID, Repo ID, and Filename before downloading.");
      return;
    }
    await callApi("/models/download", "POST", {
      model_id: newModelId,
      repo_id: newRepoId,
      filename: newFilename,
    });
    await refreshModels();
  }

  async function handleLoad() {
    if (!selectedModelId) return;
    const result = await callApi(`/models/${selectedModelId}/load`, "POST");
    if (result) {
      setLoadedModelId(selectedModelId);
      setMessages([]); // fresh conversation whenever a (possibly different) model loads
    }
  }

  async function handleUnload() {
    if (!loadedModelId) return;
    await callApi(`/models/${loadedModelId}/unload`, "POST");
    setLoadedModelId(null);
  }

  async function handleSend() {
    const text = chatInput.trim();
    if (!text || !loadedModelId || sending) return;

    const userMessage: ChatMessage = { role: "user", content: text };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setChatInput("");
    setSending(true);
    setError(null);

    const result = await callApi("/chat", "POST", {
      model_id: loadedModelId,
      message: text,
      history: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    if (result) {
      const reply = result.choices?.[0]?.message?.content ?? "(no response content)";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: 8,
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 4,
  };

  return (
    <main className="w-300 mx-auto my-10 font-sans px-4">
      <h1>Mini Local LLM Studio</h1>

      {error && (
        <div style={{ padding: 10, marginBottom: 16, background: "#fdecea", color: "#611a15", borderRadius: 6 }}>
          {error}
        </div>
      )}
      <div className="flex justify-between gap-2 wrap">
        {/* --- Download a new model --- */}
        <section className="w-full" style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Download a new model from Hugging Face</h3>
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

        {/* --- Pick and load a model --- */}
        <section className="w-full" style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Select a model</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <select
              className="text-white bg-black"
              style={{ ...inputStyle, flex: 1 }}
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
            <button className="hover:text-green-500" disabled={busy} onClick={refreshModels}>
              Refresh List
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="hover:text-green-500" disabled={busy || !selectedModelId} onClick={handleLoad}>
              Load Model
            </button>
            <button className="hover:text-green-500" disabled={busy || !loadedModelId} onClick={handleUnload}>
              Unload Model
            </button>
            <span style={{ fontSize: 13, color: loadedModelId ? "#1a7d1a" : "#888" }}>
              {loadedModelId ? `Loaded: ${loadedModelId}` : "No model loaded"}
            </span>
          </div>
        </section>
      </div>


      {/* --- Chat --- */}
      <section className="p-4 border border-gray-200 rounded-lg w-full">
        <h3 style={{ marginTop: 0 }}>Chat</h3>

        <div
          style={{
            height: 350,
            overflowY: "auto",
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {messages.length === 0 && (
            <p style={{ color: "#999", margin: 0 }}>
              {loadedModelId ? "Say something to get started." : "Load a model to begin chatting."}
            </p>
          )}
          {messages.map((m, i) => (
            <div
              className="text-white border border-white bg-black"
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          ))}
          {sending && <p style={{ color: "#999", margin: 0 }}>Thinking…</p>}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <textarea
            style={{ ...inputStyle, flex: 1, resize: "none" }}
            rows={2}
            placeholder={loadedModelId ? "Type a message... (Enter to send)" : "Load a model first"}
            value={chatInput}
            disabled={!loadedModelId || sending}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="hover:text-green-500"
            disabled={!loadedModelId || sending || !chatInput.trim()}
            onClick={handleSend}
            style={{ alignSelf: "flex-end" }}
          >
            Send
          </button>
        </div>
      </section>
    </main>
  );
}
