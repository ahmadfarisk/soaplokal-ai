"use client";


import Link from "next/link";
import { useState } from "react";
import DownloadPanel from "@/components/DownloadPanel";
// import ModelManagerList from "@/components/ModelManagerList";
import ModelPanel from "./components/ModelPanel";
import TranscriptionPanel from "./components/TranscriptionPanel";
import LiveTranscriptionPanel from "./components/LiveTranscriptionPanel";

const STT_API_URL = process.env.NEXT_PUBLIC_FASTER_WHISPER_API_URL || "http://localhost:8001";
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

  const [sttModelId, setSttModelId] = useState<string | null>(null);
  const [llmModelId, setLlmModelId] = useState<string | null>(null);

  const [transcript, setTranscript] = useState("");

  function resetError() {
    setError(null)
  }

  return (
    <main className="flex flex-col items-center justify-start bg-gray-600 w-full min-h-screen h-fit pt-20">
      {/* Header */}
      <div className="flex justify-start items-center gap-8 w-full h-fit px-4 py-3 bg-white shadow text-lg tracking-wide text-gray-700 text- absolute top-0">
        <Link href={"/"}>🩺🤖</Link>
        <Link href={"/"}>Home</Link>
        <Link href={"/model_manage"}>Kelola Model</Link>
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex justify-between w-[90%] rounded-md bg-red-50 text-red-800 text-sm px-4 py-3 absolute bottom-20 mx-auto text-wrap">
          {error}
          <button
            className="cursor-pointer"
            onClick={resetError}
          >
            X
          </button>
        </div>
      )}

      <div className="flex flex-col gap-10 w-full h-fit items-center justify-start">

        <div className="flex flex-col justify-center items-center w-[80%] bg-gray-200 rounded-2xl shadow-2xl p-5">
          <p className="text-gray-950 text-2xl mb-5">
            Download dan Aktifasi model
          </p>

          <div className="flex gap-4 w-full theme-alt-light">
          
            {/* STT */}
            <div className="flex flex-col gap-4 w-full">
              <DownloadPanel
                title="Download a speech-to-text model"
                apiUrl={STT_API_URL}
                mode="dropdown"
                options={STT_DOWNLOADABLE_MODELS}
                onError={setError}
              />

              <ModelPanel
                title="Select speech-to-text model"
                apiUrl={STT_API_URL}
                loadedModelId={sttModelId}
                onLoadedChange={setSttModelId}
                onError={setError}
              />
            </div>

            {/* LLM */}
            <div className="flex flex-col gap-4 w-full">
              <DownloadPanel
                title="Download a LLM model"
                apiUrl={LLM_API_URL}
                mode="freeform"
                onError={setError}
              />

              <ModelPanel
                title="Select LLM model"
                apiUrl={LLM_API_URL}
                loadedModelId={llmModelId}
                onLoadedChange={setLlmModelId}
                onError={setError}
              />
            </div>

          </div>
        </div>

        <div className="flex flex-col justify-center items-center w-[80%] bg-gray-200 rounded-2xl shadow-2xl p-5 theme-alt-light">
          <p className="text-gray-950 text-2xl mb-5">
            Generasi catatan SOAP dari transkripsi percakapan
          </p>

          <div className="flex gap-10 w-full">
            <TranscriptionPanel
              apiUrl={STT_API_URL}
              loadedModelId={sttModelId}
              transcript={transcript}
              onTranscriptChange={setTranscript}
              onError={setError}
            />

            <LiveTranscriptionPanel
              apiUrl={STT_API_URL}
              loadedModelId={sttModelId}
              transcript={transcript}
              onTranscriptChange={setTranscript}
              onError={setError}
            />
          </div>
          

        </div>
      </div>
      
    </main>
  );
};