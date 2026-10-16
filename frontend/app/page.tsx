"use client";


import Link from "next/link";
import { useState } from "react";
import DownloadPanel from "@/components/DownloadPanel";
import ModelManagerList from "@/components/ModelManagerList";

const STT_API_URL = process.env.NEXT_PUBLIC_FASTER_WHISPER_API_URL || "http://localhost:8002";
const LLM_API_URL = process.env.NEXT_PUBLIC_LLM_API_URL || "http://localhost:8000";

const STT_DOWNLOADABLE_MODELS: { model_id: string; label: string; extra: Record<string, string> }[] = [
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


export default function HomePage() {
  const [error, setError] = useState<string | null>(null);

  function resetError() {
    setError(null)
  }

  const [llmRefreshSignal, setLlmRefreshSignal] = useState(0);
  const [sttRefreshSignal, setSttRefreshSignal] = useState(0);

  return (
    <main className="flex w-full flex-col items-center justify-start bg-zinc-50 px-6 py-4 mt-10 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50 gap-5">
      

      <section className="flex flex-col items-center justify-start gap-4 mb-20 w-full">
        <h2 className="text-2xl font-semibold mb-2">Home</h2>
        <div className="flex gap-6 justify-center items-center w-full">
          {/* <Link className="hover:text-green-500 border p-3 rounded-lg" href="/model_manage">Manage models</Link> */}
          <Link className="hover:text-green-500 border p-3 rounded-lg" href="/soap_gen">SOAP Note Generator</Link>
          {/* <Link className="hover:text-green-500 border p-3 rounded-lg" href="/llm">LLM</Link> */}
          {/* <Link className="hover:text-green-500 border p-3 rounded-lg" href="/llm_test">LLM Test</Link> */}
          {/* <Link className="hover:text-green-500 border p-3 rounded-lg" href="/stt">STT Test</Link> */}
        </div>
      </section>
      

      {/* Error Message */}
      {error && (
        <div className="rounded-md bg-red-50 text-red-800 text-sm px-4 py-3 flex justify-between gap-5">
          {error}
          <button
            className="cursor-pointer"
            onClick={resetError}
          >
            X
          </button>
        </div>
      )}

      <section className="w-5xl min-w-2xl font-sans flex flex-col justify-start items-center">
        <h2 className="text-2xl font-semibold mb-2">Model Management</h2>
        
        <div className="space-y-8 flex justify-between gap-5 w-full">
          {/* --- LLM --- */}
          <div className="space-y-3 flex flex-col gap-3 w-full">
            <h2 className="text-base font-semibold text-gray-200 w-full text-center">LLM models</h2>

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
          <div className="space-y-3 flex flex-col gap-3 w-full">
            <h2 className="text-base font-semibold text-gray-200 w-full text-center">Speech-to-text models</h2>
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
      </section>

    </main>
  );
}