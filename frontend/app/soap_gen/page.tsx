"use client";

import { useState } from "react";
import ModelPanel from "@/components/ModelPanel";
import DownloadPanel from "@/components/DownloadPanel";
import TranscriptionPanel from "@/components/TranscriptionPanel";
import SoapNoteResult from "@/components/SoapNoteResult";

const STT_API_URL = process.env.NEXT_PUBLIC_STT_API_URL || "http://localhost:8001";
const LLM_API_URL = process.env.NEXT_PUBLIC_LLM_API_URL || "http://localhost:8000";

const STT_DOWNLOADABLE_MODELS: { model_id: string; label: string; extra: Record<string, string> }[] = [
  {
    model_id: 'whisper-tiny-int8-ov',
    label: 'Whisper Tiny (INT8)',
    extra: { hf_model_id: 'OpenVINO/whisper-tiny-int8-ov' },
  },
  {
    model_id: 'whisper-base-int8-ov',
    label: 'Whisper Base (INT8)',
    extra: { hf_model_id: 'OpenVINO/whisper-base-int8-ov' },
  },
  {
    model_id: 'whisper-small-int8-ov',
    label: 'Whisper Small (INT8)',
    extra: { hf_model_id: 'OpenVINO/whisper-small-int8-ov' },
  },
  {
    model_id: 'whisper-medium-int8-ov',
    label: 'Whisper Medium (INT8)',
    extra: { hf_model_id: 'OpenVINO/whisper-medium-int8-ov' },
  },
];

// function buildSoapPrompt(transcript: string): string {
//   return `You are a documentation assistant. Convert the following conversation transcript into a SOAP note.

// Use exactly these four section headers, each on its own line, in this order: "Subjective:", "Objective:", "Assessment:", "Plan:". Write only the SOAP note itself — no preamble, no extra commentary.

// Transcript:
// ${transcript}`;
// }

function buildSoapPrompt(transcript: string): string {
  return `Anda adalah asisten dokumentasi. Ubah transkrip percakapan berikut ini menjadi catatan SOAP.

Gunakan tepat empat judul bagian ini, masing-masing pada baris tersendiri, dalam urutan berikut: "Subjective:", "Objective:", "Assessment:", "Plan:". Tuliskan hanya catatan SOAP itu sendiri — tanpa kata pengantar, tanpa komentar tambahan.

Transkrip:
${transcript}`;
}

export default function SoapNotePage() {
  const [error, setError] = useState<string | null>(null);

  const [sttModelId, setSttModelId] = useState<string | null>(null);
  const [llmModelId, setLlmModelId] = useState<string | null>(null);

  const [transcript, setTranscript] = useState("");
  const [soapNote, setSoapNote] = useState("");
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    if (!transcript.trim() || !llmModelId) return;
    setGenerating(true);
    setError(null);
    setSoapNote("");

    try {
      const res = await fetch(`${LLM_API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: llmModelId,
          message: buildSoapPrompt(transcript),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || `SOAP note generation failed (${res.status})`);
        return;
      }
      const reply = data.choices?.[0]?.message?.content ?? "";
      setSoapNote(reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="w-full px-4 py-10 font-sans bg-black">
      <h1 className="w-fit mx-auto text-2xl font-semibold mb-6">SOAP Note Generator</h1>

      <div className="mx-auto w-5xl flex flex-col gap-5">

        {/* Error Message */}
        {error && (
          <div className="mb-6 rounded-md bg-red-50 text-red-800 text-sm px-4 py-3">
            {error}
          </div>
        )}

        <div className="flex gap-10">
          {/* STT */}
          <div className="w-full flex flex-col gap-5">
            <DownloadPanel
              title="Download a speech-to-text model"
              apiUrl={STT_API_URL}
              mode="dropdown"
              options={STT_DOWNLOADABLE_MODELS}
              onError={setError}
            />

            <ModelPanel
              title="Speech-to-text model"
              apiUrl={STT_API_URL}
              loadedModelId={sttModelId}
              onLoadedChange={setSttModelId}
              onError={setError}
            />

            <TranscriptionPanel
              apiUrl={STT_API_URL}
              loadedModelId={sttModelId}
              transcript={transcript}
              onTranscriptChange={setTranscript}
              onError={setError}
            />
          </div>
          
          {/* LLM */}
          <div className="w-full flex flex-col gap-5">
            <DownloadPanel
              title="Download an LLM"
              apiUrl={LLM_API_URL}
              mode="freeform"
              onError={setError}
            />

            <ModelPanel
              title="LLM (for SOAP note generation)"
              apiUrl={LLM_API_URL}
              loadedModelId={llmModelId}
              onLoadedChange={setLlmModelId}
              onError={setError}
            />

            <section className="rounded-lg border border-gray-200 p-4">
              <button
                disabled={!transcript.trim() || !llmModelId || generating}
                onClick={handleGenerate}
                className="w-full rounded-md bg-gray-900 text-white text-sm px-4 py-2 disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate SOAP Note"}
              </button>
              {(!transcript.trim() || !llmModelId) && (
                <p className="mt-2 text-xs text-gray-400">
                  Requires a transcript and a loaded LLM model.
                </p>
              )}
            </section>
          </div>
        </div>

        <SoapNoteResult rawText={soapNote} />
      </div>
    </main>
  );
}
