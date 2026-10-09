"use client";

import { useState } from "react";
import ModelPanel from "@/components/ModelPanel";
import DownloadPanel from "@/components/DownloadPanel";
import TranscriptionPanel from "@/components/TranscriptionPanel";
import SoapNoteResult from "@/components/SoapNoteResult";
import GenerationParamsPanel, {
  DEFAULT_GENERATION_PARAMS,
  GenerationParams,
} from "@/components/GenerationParamsPanel";
import LiveTranscriptionPanel from "@/components/LiveTranscriptionPanel";
import MetricsDisplay from "@/components/MetricsDisplay";
import { LlmMetrics, llmMetricItems } from "@/components/MetricsDisplay";

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

// function buildSoapPrompt(transcript: string): string {
//   return `You are a documentation assistant. Convert the following conversation transcript into a SOAP note.

// Use exactly these four section headers, each on its own line, in this order: "Subjective:", "Objective:", "Assessment:", "Plan:". Write only the SOAP note itself — no preamble, no extra commentary.

// Transcript:
// ${transcript}`;
// }

// function buildSoapPrompt(transcript: string): string {
//   return `Anda adalah asisten dokumentasi medis. Ubah transkrip percakapan berikut ini menjadi catatan SOAP dalam Bahasa Indonesia. 

// Gunakan tepat empat judul bagian ini, masing-masing pada baris tersendiri, dalam urutan berikut: "Subjective:", "Objective:", "Assessment:", "Plan:". Tuliskan hanya catatan SOAP itu sendiri — tanpa kata pengantar, tanpa komentar tambahan. Jangan menambahkan informasi yang tidak ada pada transkrip untuk bagian Objective.

// Transkrip:
// ${transcript}`;
// }
function buildSoapPrompt(transcript: string): string {
  return `Anda adalah seorang asisten dokumentasi medis profesional yang sangat objektif, teliti, dan berbasis fakta mutlak (strict evidence-based). Tugas Anda adalah mengubah transkrip percakapan antara dokter dan pasien di bawah ini menjadi catatan SOAP (Subjective, Objective, Assessment, Plan) dalam Bahasa Indonesia.

Patuhi aturan ketat berikut tanpa pengecualian:

1. KONTROL FAKTA & LARANGAN HALUSINASI NUMERIK:
   - HANYA tuliskan informasi yang secara eksplisit ada di dalam transkrip. 
   - Dilarang keras mengarang, menebak, atau menambahkan prosedur medis, pemeriksaan penunjang (seperti tes darah, rontgen, biopsi), maupun jenis obat yang TIDAK DISEBUTKAN oleh dokter atau pasien di dalam transkrip.
   - ATURAN KHUSUS BAGIAN OBJECTIVE (Tanda Vital & Pemeriksaan Fisik): Jika dokter atau pasien TIDAK MENYEBUTKAN nilai tanda vital tertentu (seperti tekanan darah, suhu tubuh, atau denyut nadi) di dalam transkrip, **DILARANG KERAS MENGARANG ANGKA** (contoh: jangan menulis 120/80 mmHg atau 36.5°C jika tidak disebut). Anda **WAJIB** menuliskan secara jujur: "Informasi tidak disebutkan dalam transkrip" atau "Data tanda vital tidak tersedia".
   - CONTOH PENANGANAN DATA KOSONG:
    * Suhu tubuh: Informasi tidak disebutkan.*
    * Tekanan darah: Informasi tidak disebutkan.*
   - Waspadai penyangkalan pasien: Jika pasien menyatakan tidak memiliki riwayat alergi atau tidak pernah mengalami sesuatu, catat sebagai tidak ada. Jangan memutarbalikkan pernyataan pasien.

2. PROTEKSI KELOMPOK PENGANDAIAN & KEMUNGKINAN DOKTER (Conditional Statement Guard):
   - Waspadai kalimat pengandaian, antisipasi, atau kemungkinan yang diucapkan oleh dokter (contoh: "kalau ada keluhan lain seperti nyeri...", "jika nanti muncul demam..."). 
   - Kalimat-kalimat bersyarat dari dokter **BUKAN** berarti pasien sedang mengalami gejala tersebut. Jangan pernah mencatat angan-angan atau skenario hipotesis dokter ke dalam bagian Subjective pasien.
   - CONTOH PENANGANAN KALIMAT PENGANDAIAN:
    * Keluhan pasien: Hanya batuk (tidak ada keluhan nyeri yang disebutkan dialami pasien).*

3. KOREKSI KONTEKSTUAL ASR TYPO:
   - Terjemahkan kesalahan ketik otomatis (typo dari speech-to-text) secara masuk akal, dan frasa keliru mengenai lokasi pemeriksaan dipahami secara logis sesuai konteks percakapan medis, bukan ditelan secara harfiah.. 
   CONTOH MENANGANI KATA-KATA KESALAHAN TRANSKRIP YANG TIDAK MASUK AKAL: 
    * "meriam" dipahami sebagai "meriang". *
    * "getel" dipahami sebagai "gatal". *
    * "gatal-gatil" dipahami sebagai "gatal-gatal". *
    * "bentol-bentel" dipahami sebagai "bentol-bentol". *
    * "demam pudara hidupu" dipahami sebagau "demam berdarah". *

4. KETENTUAN SUDUT PANDANG (Clinical Third-Person Perspective):
   - Catatan SOAP WAJIB ditulis dari sudut pandang objektif pihak ketiga (sudut pandang tenaga medis/perekam medis profesional). 
   - DILARANG KERAS menggunakan sudut pandang orang pertama ("Saya", "Aku", "Dokter", atau "Pasien" yang berbicara langsung seperti narasi dialog). 
   - Gunakan format pelaporan klinis (contoh: "Pasien mengeluhkan...", "Riwayat pengobatan mandiri...", "Dokter menginstruksikan...").

5. ATURAN KETAT BAGIAN PLAN (No Generic Plan Hallucination):
   - Bagian Plan HANYA boleh berisi tindakan, obat, atau edukasi yang **secara eksplisit diucapkan kata per kata** oleh dokter di akhir transkrip.
   - Dilarang keras berasumsi atau menambahkan kalimat generik standar medis yang *tidak diucapkan* oleh dokter di dalam transkrip (seperti menuliskan "akan memberikan resep jika diperlukan" atau "mengikuti aturan perawatan rumah" jika dokter tidak mengatakannya). Jika dokter di transkrip hanya meminta pemeriksaan lanjutan dan melarang menggaruk, maka Plan HANYA berisi hal tersebut.

6. PEMISAHAN BAGIAN YANG KETAT:
   - **Subjective:** HANYA berisi keluhan utama, durasi, karakteristik gejala, riwayat pengobatan mandiri, riwayat alergi, dan riwayat kontak yang *dikatakan oleh pasien*. Dilarang memasukkan hasil pengamatan fisik di sini.
   - **Objective:** HANYA berisi temuan fisik, deskripsi lesi/ruam/luka yang tampak atau didiskusikan saat pemeriksaan, serta tanda vital (atau nyatakan tidak ada jika transkrip tidak menyebutkannya). *Dilarang keras* memasukkan kembali keluhan subjektif ke dalam bagian ini.
   - **Assessment:** Berisi kesimpulan klinis sementara atau pernyataan dokter bahwa diagnosis belum pasti dan memerlukan pemeriksaan lebih lanjut.
   - **Plan:** HANYA berisi rencana tindakan atau edukasi yang *benar-benar diucapkan secara nyata* oleh dokter dalam transkrip. Jika dokter tidak menyebutkan resep obat atau tindakan spesifik, tuliskan bahwa tindakan tersebut belum diinstruksikan dalam transkrip.


Format Output:
Gunakan tepat empat judul bagian ini, masing-masing pada baris tersendiri, dalam urutan berikut tanpa tambahan kata pengantar atau komentar di luar format:

Subjective:
Objective:
Assessment:
Plan:

Berikut adalah transkrip percakapan yang harus Anda ubah:
${transcript}`;
}

export default function SoapNotePage() {
  const [error, setError] = useState<string | null>(null);

  const [sttModelId, setSttModelId] = useState<string | null>(null);
  const [llmModelId, setLlmModelId] = useState<string | null>(null);

  const [transcript, setTranscript] = useState("");
  const [soapNote, setSoapNote] = useState("");
  const [generating, setGenerating] = useState(false);

  const [genParams, setGenParams] = useState<GenerationParams>(DEFAULT_GENERATION_PARAMS);

  const [llmMetrics, setLlmMetrics] = useState<LlmMetrics | null>(null);
  const [llmTime, setLLMTime] = useState(0.0);

  function resetError() {
    setError(null)
  }

  async function handleGenerate() {
    if (!transcript.trim() || !llmModelId) return;
    console.log("Generating with", genParams)

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
          ...genParams,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || `SOAP note generation failed (${res.status})`);
        return;
      }
      const reply = data.choices?.[0]?.message?.content ?? "";
      console.log(data)
      setSoapNote(reply);

      // Result Metrics
      setLLMTime(data.metrics.processing_time);
      setLlmMetrics(data.metrics ?? null);
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
          <div className="mb-6 rounded-md bg-red-50 text-red-800 text-sm px-4 py-3 flex justify-between">
            {error}
            <button
              className="cursor-pointer"
              onClick={resetError}
            >
              X
            </button>
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

            <LiveTranscriptionPanel
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

            <GenerationParamsPanel params={genParams} onChange={setGenParams} />

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
              {(llmTime > 0) && (
                <p className="mt-2 text-xs text-gray-400">
                  SOAP Generated in: {llmTime}
                </p>
              )}
            </section>

          </div>
        </div>

        <SoapNoteResult rawText={soapNote} />

        <MetricsDisplay items={llmMetrics ? llmMetricItems(llmMetrics) : null} />
      </div>
    </main>
  );
}
