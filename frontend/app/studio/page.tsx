"use client";

import { useRef, useState } from "react";
import StatusPill, { Phase, StatusSteps } from "@/components/studio/StatusPill";
import ModelCard, { DownloadOption } from "@/components/studio/ModelCard";
import AudioInput from "@/components/studio/AudioInput";
import TranscriptCard from "@/components/studio/TranscriptCard";
import SoapNoteCard from "@/components/studio/SoapNoteCard";
import { GEN_PARAMS, SOAP_SYSTEM_PROMPT, StatItem, errorMessage } from "@/lib/studio";

const LLM_API_URL = process.env.NEXT_PUBLIC_LLM_API_URL || "http://localhost:8000";
const STT_API_URL = process.env.NEXT_PUBLIC_STT_API_URL || "http://localhost:8001";

// Models offered in the speech-to-text "Download a model" box. Fill in the ones you
// want people to be able to pick, for example:
//   { model_id: "whisper-small-int8-ov", label: "Whisper Small (INT8)",
//     extra: { hf_model_id: "OpenVINO/whisper-small-int8-ov" } },
const STT_DOWNLOAD_OPTIONS: { model_id: string; label: string; extra: Record<string, string> }[] = [
  {
    model_id: 'faster-whisper-small',
    label: 'Faster Whisper Small',
    extra: { hf_model_id: 'Systran/faster-whisper-small' },
  },
  {
    model_id: 'faster-whisper-medium',
    label: 'Faster Whisper Medium',
    extra: { hf_model_id: 'Systran/faster-whisper-medium' },
  },
  {
    model_id: 'faster-whisper-medium-id',
    label: 'jerichosiahaya\'s Faster Whisper Medium ID',
    extra: { hf_model_id: 'jerichosiahaya/faster-whisper-medium-id' },
  },
  {
    model_id: 'faster-whisper-large-v3-turbo-ct2',
    label: 'deepdml\'s Faster Whisper Large Turbo',
    extra: { hf_model_id: 'deepdml/faster-whisper-large-v3-turbo-ct2' },
  },
  {
    model_id: 'faster-whisper-large-v3',
    label: 'Faster Whisper Large',
    extra: { hf_model_id: 'Systran/faster-whisper-large-v3' },
  },
  
];

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  metrics?: {
    total_seconds?: number;
    completion_tokens?: number | null;
    tokens_per_second?: number | null;
  };
}

function llmStats(metrics: ChatResponse["metrics"]): StatItem[] {
  const stats: StatItem[] = [];
  if (!metrics) return stats;
  if (typeof metrics.total_seconds === "number") {
    stats.push({ label: "Written in", value: `${metrics.total_seconds.toFixed(1)} s` });
  }
  if (typeof metrics.completion_tokens === "number") {
    stats.push({ label: "Output", value: `${metrics.completion_tokens} tokens` });
  }
  if (typeof metrics.tokens_per_second === "number") {
    stats.push({ label: "Speed", value: `${metrics.tokens_per_second.toFixed(1)} tok/s` });
  }
  return stats;
}

export default function StudioPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [sttModelId, setSttModelId] = useState<string | null>(null);
  const [llmModelId, setLlmModelId] = useState<string | null>(null);

  const [transcript, setTranscript] = useState("");
  const [transcriptStats, setTranscriptStats] = useState<StatItem[]>([]);
  const [soapNote, setSoapNote] = useState("");
  const [soapStats, setSoapStats] = useState<StatItem[]>([]);
  const [noteHint, setNoteHint] = useState<string | null>(null);
  const [autoGenerate, setAutoGenerate] = useState(true);

  // A ref (not state) so two triggers in the same moment can never start two requests.
  const generatingRef = useRef(false);

  // ----- SOAP note generation ---------------------------------------------

  async function generateSoap(text: string) {
    if (!text.trim() || generatingRef.current) return;

    if (!llmModelId) {
      setNoteHint("The note was not written because no language model is loaded. Load one above, then press Generate.");
      setPhase("idle");
      return;
    }

    generatingRef.current = true;
    setPhase("generating");
    setNoteHint(null);
    setSoapNote("");
    setSoapStats([]);

    try {
      const res = await fetch(`${LLM_API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: llmModelId,
          message: `Transkrip:\n${text}`,
          history: [{ role: "system", content: SOAP_SYSTEM_PROMPT }],
          ...GEN_PARAMS,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(errorMessage(data, res.status));
        setPhase("idle");
        return;
      }

      const result = data as ChatResponse;
      const reply = result.choices?.[0]?.message?.content ?? "";
      if (!reply.trim()) {
        setError("The model returned an empty note. Try generating again.");
        setPhase("idle");
        return;
      }

      setSoapNote(reply);
      setSoapStats(llmStats(result.metrics));
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    } finally {
      generatingRef.current = false;
    }
  }

  // ----- Audio input callbacks --------------------------------------------

  // A new recording or upload starts a fresh session.
  function handleCaptureStart() {
    setTranscript("");
    setTranscriptStats([]);
    setSoapNote("");
    setSoapStats([]);
    setNoteHint(null);
    setError(null);
  }

  function handleTranscriptReady(text: string, stats: StatItem[]) {
    setTranscript(text);
    setTranscriptStats(stats);

    if (!text.trim()) {
      setError("No speech was found in that audio.");
      setPhase("idle");
      return;
    }

    if (autoGenerate) {
      void generateSoap(text);
    } else {
      setPhase("idle");
    }
  }

  function handleClear() {
    setTranscript("");
    setTranscriptStats([]);
    setSoapNote("");
    setSoapStats([]);
    setNoteHint(null);
    setPhase("idle");
  }

  // ----- Derived state ----------------------------------------------------

  const capturing = phase === "recording" || phase === "transcribing";
  const generating = phase === "generating";
  const hasTranscript = transcript.trim().length > 0;
  const canGenerate = hasTranscript && Boolean(llmModelId) && !capturing && !generating;

  let disabledReason: string | null = null;
  if (!hasTranscript) disabledReason = "Add a transcript first.";
  else if (capturing) disabledReason = "Wait for the transcription to finish.";
  else if (!llmModelId) disabledReason = "Load a language model to write notes.";

  // Don't let a model be swapped out from under a running job.
  const modelsLocked = phase === "recording" || phase === "transcribing" || phase === "generating";

  return (
    // Explicit light colours on the root, so the page looks the same whatever the OS theme is.
    <div className="min-h-screen bg-slate-100 text-slate-800" style={{ colorScheme: "light" }}>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-sky-700">Local AI Studio</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">Generasi catatan SOAP</h1>
            <p className="mt-2 max-w-xl text-slate-600">
              Rekam atau unggah hasil konsultasi dan dapatkan draf catatan SOAP.
            </p>
          </div>
          <div className="">
            <StatusPill phase={phase} />
          </div>
          
        </header>

        <div className="mt-5">
          <StatusSteps phase={phase} />
        </div>

        {error && (
          <div
            role="alert"
            className="mt-5 flex items-start justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="shrink-0 rounded-lg px-2 py-0.5 font-medium text-rose-800 hover:bg-rose-100"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <ModelCard
            title="Speech-to-text"
            description="Mengubah audio menjadi transkrip."
            apiUrl={STT_API_URL}
            loadedModelId={sttModelId}
            onLoadedChange={setSttModelId}
            onError={setError}
            downloadMode="dropdown"
            downloadOptions={STT_DOWNLOAD_OPTIONS}
            locked={modelsLocked}
          />
          <ModelCard
            title="Penulis catatan SOAP"
            description="Menulis catatan SOAP berdasarkan transkrip."
            apiUrl={LLM_API_URL}
            loadedModelId={llmModelId}
            onLoadedChange={setLlmModelId}
            onError={setError}
            downloadMode="freeform"
            locked={modelsLocked}
          />
        </div>

        <div className="mt-5">
          <AudioInput
            apiUrl={STT_API_URL}
            modelId={sttModelId}
            locked={generating}
            onStart={handleCaptureStart}
            onPhase={setPhase}
            onTranscriptUpdate={setTranscript}
            onTranscriptReady={handleTranscriptReady}
            onError={setError}
          />
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <TranscriptCard
            transcript={transcript}
            onChange={setTranscript}
            readOnly={capturing}
            stats={transcriptStats}
            onClear={handleClear}
          />
          <SoapNoteCard
            rawNote={soapNote}
            generating={generating}
            canGenerate={canGenerate}
            disabledReason={disabledReason}
            hint={noteHint}
            autoGenerate={autoGenerate}
            onAutoGenerateChange={setAutoGenerate}
            onGenerate={() => void generateSoap(transcript)}
            stats={soapStats}
          />
        </div>

        <footer className="mt-8 text-center text-xs text-slate-600">
          Tidak ada data yang keluar dari komputer ini: proses transkripsi dan penulisan catatan dilakukan secara lokal.
        </footer>
      </div>
    </div>
  );
}