"use client";

import { useState } from "react";
import DownloadPanel from "@/components/DownloadPanel";
import ModelManagerList from "@/components/ModelManagerList";

const STT_API_URL = process.env.NEXT_PUBLIC_FASTER_WHISPER_API_URL || "http://localhost:8002";
const LLM_API_URL = process.env.NEXT_PUBLIC_LLM_API_URL || "http://localhost:8000";

const STT_DOWNLOADABLE_MODELS: { model_id: string; label: string; extra: Record<string, string> }[] = [
  // {
  //   model_id: 'whisper-tiny-int8-ov',
  //   label: 'Whisper Tiny (INT8)',
  //   extra: { hf_model_id: 'OpenVINO/whisper-tiny-int8-ov' },
  // },
  // {
  //   model_id: 'whisper-base-int8-ov',
  //   label: 'Whisper Base (INT8)',
  //   extra: { hf_model_id: 'OpenVINO/whisper-base-int8-ov' },
  // },
  // {
  //   model_id: 'whisper-small-int8-ov',
  //   label: 'Whisper Small (INT8)',
  //   extra: { hf_model_id: 'OpenVINO/whisper-small-int8-ov' },
  // },
  // {
  //   model_id: 'whisper-medium-int8-ov',
  //   label: 'Whisper Medium (INT8)',
  //   extra: { hf_model_id: 'OpenVINO/whisper-medium-int8-ov' },
  // },
  // {
  //   model_id: 'whisper-large-v3-int8-ov',
  //   label: 'Whisper V3 Large (INT8)',
  //   extra: { hf_model_id: 'OpenVINO/whisper-large-v3-int8-ov' },
  // },
  // {
  //   model_id: 'whisper-large-v3-turbo-int8-ov',
  //   label: 'Whisper V3 Large (INT8) Turbo',
  //   extra: { hf_model_id: 'OpenVINO/whisper-large-v3-turbo-int8-ov' },
  // },
  // {
  //   model_id: 'bweng-whisper-large-v3-turbo-int8-ov',
  //   label: 'bweng\'s Whisper V3 Large (INT8) Turbo',
  //   extra: { hf_model_id: 'bweng/whisper-large-v3-turbo-int8-ov' },
  // },
];

export default function ModelManagementPage() {
  const [error, setError] = useState<string | null>(null);

  // Bumped after a download starts, to trigger each list to refresh.
  // (A model won't show as "ready" until the background download finishes —
  // click each list's own Refresh button once it's done.)
  const [llmRefreshSignal, setLlmRefreshSignal] = useState(0);
  const [sttRefreshSignal, setSttRefreshSignal] = useState(0);

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 font-sans">
      <h1 className="text-2xl font-semibold mb-6">Model Management</h1>

      {error && (
        <div className="mb-6 rounded-md bg-red-50 text-red-800 text-sm px-4 py-3">
          {error}
        </div>
      )}
      
      <div className="space-y-8 flex justify-between gap-5">
        {/* --- LLM --- */}
        <div className="space-y-3 flex flex-col gap-4 w-full">
          <h2 className="text-base font-semibold text-gray-200">LLM models</h2>
          <DownloadPanel
            title="Download an LLM"
            apiUrl={LLM_API_URL}
            mode="freeform"
            onDownloadStarted={() => setLlmRefreshSignal((n) => n + 1)}
            onError={setError}
          />
          <ModelManagerList
            title="Downloaded LLM models"
            apiUrl={LLM_API_URL}
            onError={setError}
            refreshSignal={llmRefreshSignal}
          />
        </div>

        {/* --- STT --- */}
        <div className="space-y-3 flex flex-col gap-4 w-full">
          <h2 className="text-base font-semibold text-gray-200">Speech-to-text models</h2>
          <DownloadPanel
            title="Download a speech-to-text model"
            apiUrl={STT_API_URL}
            mode="dropdown"
            options={STT_DOWNLOADABLE_MODELS}
            onDownloadStarted={() => setSttRefreshSignal((n) => n + 1)}
            onError={setError}
          />
          <ModelManagerList
            title="Downloaded STT models"
            apiUrl={STT_API_URL}
            onError={setError}
            refreshSignal={sttRefreshSignal}
          />
        </div>
      </div>
    </main>
  );
}
