"use client";


import Link from "next/link";
import { useState } from "react";
import DownloadPanel from "@/components/DownloadPanel";
// import ModelManagerList from "@/components/ModelManagerList";
import ModelPanel from "./components/ModelPanel";
// import TranscriptionPanel from "./components/TranscriptionPanel";
// import LiveTranscriptionPanel from "./components/LiveTranscriptionPanel";
import GenerationParamsPanelPopUp, {
  DEFAULT_GENERATION_PARAMS,
  GenerationParams,
} from "@/components/GenerationParamsPanelPopUp";
import MetricsDisplay from "@/components/MetricsDisplay";
import { LlmMetrics, llmMetricItems } from "@/components/MetricsDisplay";
import CombinedTranscriptionPanel from "./components/CombinedTranscriptionPanel";
import SoapNoteResult from "./components/SoapNoteResult";


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


function buildSoapPrompt(transcript: string): string {
  return `Anda adalah seorang asisten dokumentasi medis profesional yang sangat objektif, teliti, dan berbasis fakta mutlak (strict evidence-based). Tugas Anda adalah mengubah transkrip percakapan antara dokter dan pasien di bawah ini menjadi catatan SOAP (Subjective, Objective, Assessment, Plan) dalam Bahasa Indonesia.

Patuhi aturan ketat berikut tanpa pengecualian:

1. KONTROL FAKTA & LARANGAN HALUSINASI NUMERIK / MEDIS:
   - HANYA tuliskan informasi yang secara eksplisit ada di dalam transkrip. 
   - Dilarang keras mengarang, menebak, atau menambahkan prosedur medis, pemeriksaan penunjang (seperti tes darah, rontgen, biopsi, lab), maupun jenis obat yang TIDAK DISEBUTKAN secara eksplisit oleh dokter atau pasien di dalam transkrip.
   - ATURAN KHUSUS BAGIAN OBJECTIVE (Tanda Vital & Pemeriksaan Fisik): Jika dokter atau pasien TIDAK MENYEBUTKAN nilai tanda vital tertentu (seperti tekanan darah, suhu tubuh, atau denyut nadi) di dalam transkrip, DILARANG KERAS MENGARANG ANGKA (contoh: jangan menulis 120/80 mmHg atau 36.5°C jika tidak disebut). Anda WAJIB menuliskan secara jujur: "Informasi tidak disebutkan dalam transkrip" atau "Data tanda vital tidak tersedia".
   - CONTOH PENANGANAN DATA KOSONG:
    * Suhu tubuh: Informasi tidak disebutkan.
    * Tekanan darah: Informasi tidak disebutkan.
   - Waspadai penyangkalan pasien: Jika pasien menyatakan tidak memiliki riwayat alergi atau tidak pernah mengalami sesuatu, catat sebagai tidak ada. Jangan memutarbalikkan pernyataan pasien.

2. ATURAN KETAT DESKRIPSI LESI / RUAM / FISIK:
   - Bagian Objective HANYA boleh mencatat bentuk, lokasi, atau kondisi fisik yang secara lisan dideskripsikan langsung oleh pasien atau dokter di dalam transkrip (misalnya: jumlah, lokasi di tubuh, atau kondisi pecah karena digaruk).
   - Dilarang keras berasumsi atau menambahkan deskripsi medis fiktif yang tidak diucapkan di transkrip, seperti berasumsi lesi "berisi nanah", "mengeluarkan cairan", atau memiliki warna tertentu (seperti "merah muda") jika kata-kata tersebut tidak keluar dari percakapan.

3. PROTEKSI KELOMPOK PENGANDAIAN & KEMUNGKINAN DOKTER:
   - Waspadai kalimat pengandaian, antisipasi, atau kemungkinan yang diucapkan oleh dokter (contoh: "kalau ada keluhan lain seperti nyeri...", "jika nanti muncul demam..."). 
   - Kalimat-kalimat bersyarat dari dokter BUKAN berarti pasien sedang mengalami gejala tersebut. Jangan pernah mencatat angan-angan atau skenario hipotesis dokter ke dalam bagian Subjective pasien.

4. KOREKSI KONSEPTUAL ASR TYPO:
   - Terjemahkan kesalahan ketik otomatis (typo dari speech-to-text) secara masuk akal, dan frasa keliru mengenai lokasi pemeriksaan dipahami secara logis sesuai konteks percakapan medis, bukan ditelan secara harfiah. 
   CONTOH MENANGANI KATA-KATA KESALAHAN TRANSKRIP YANG TIDAK MASUK AKAL: 
   * "meriam" dipahami sebagai "meriang". 
   * "getel" dipahami sebagai "gatal". 
   * "demam pudara hidupu" dipahami sebagai "demam berdarah". 
   * "demang" dipahami sebagai "demam". 
   * "begal" dipahami sebagai "pegal". 

5. KETENTUAN SUDUT PANDANG (Clinical Third-Person Perspective):
   - Catatan SOAP WAJIB ditulis dari sudut pandang objektif pihak ketiga (sudut pandang tenaga medis/perekam medis profesional). 
   - DILARANG KERAS menggunakan sudut pandang orang pertama ("Saya", "Aku", "Dokter", atau "Pasien" yang berbicara langsung seperti narasi dialog). 
   - Gunakan format pelaporan klinis.
   Contoh BENAR:
   * Pasien mengeluhkan...
   * Riwayat pengobatan mandiri...
   * Dokter menginstruksikan...

6. ATURAN KETAT BAGIAN PLAN (No Generic Plan Hallucination):
   - Jika dokter di transkrip hanya meminta pemeriksaan fisik umum atau mengajak ke kasur pemeriksaan tanpa merinci tes lab, maka Plan HANYA mencatat pemeriksaan fisik lanjutan/umum sesuai transkrip.

7. PEMISAHAN BAGIAN YANG KETAT:
   - Subjective: HANYA berisi keluhan utama, durasi, karakteristik gejala, riwayat pengobatan mandiri, riwayat alergi, dan riwayat kontak yang dikatakan oleh pasien. Dilarang memasukkan hasil pengamatan fisik di sini.
   - Objective: HANYA berisi temuan fisik, deskripsi lesi/ruam/luka yang tampak atau didiskusikan secara nyata saat pemeriksaan, serta tanda vital (atau nyatakan tidak ada jika transkrip tidak menyebutkannya). Dilarang keras memasukkan kembali keluhan subjektif ke dalam bagian ini.
   - Assessment: Berisi kesimpulan klinis sementara atau pernyataan dokter bahwa diagnosis belum pasti dan memerlukan pemeriksaan lebih lanjut.
   - Plan: HANYA berisi rencana tindakan, obat, atau edukasi yang secara eksplisit diucapkan kata per kata oleh dokter di akhir transkrip. Jangan menambah-nambahkan kata-kata yang tidak disebutkan, seperti menuliskan "tes darah", "rontgen", atau jenis tindakan spesifik lain yang tidak disebut. 


Format Output:
Gunakan tepat empat judul bagian ini, masing-masing pada baris tersendiri, dalam urutan berikut tanpa tambahan kata pengantar atau komentar di luar format:

Subjective:
Objective:
Assessment:
Plan:

Berikut adalah transkrip percakapan yang harus Anda ubah:
${transcript}`;
}



export default function HomePage() {
  const [error, setError] = useState<string | null>(null);

  // STT
  const [sttModelId, setSttModelId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  // LLM
  const [llmModelId, setLlmModelId] = useState<string | null>(null);
  const [genParams, setGenParams] = useState<GenerationParams>(DEFAULT_GENERATION_PARAMS);
  const [soapNote, setSoapNote] = useState("");
  const [generating, setGenerating] = useState(false);

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
    <main className="flex flex-col items-center justify-start bg-gray-400 w-full min-h-screen h-fit pt-20 pb-30">
      {/* Header */}
      <div className="flex items-center gap-8 w-full h-fit px-4 py-3 bg-white shadow text-lg tracking-wide text-gray-700 text- absolute top-0">
        <Link href={"/"}>🩺🤖</Link>
        <Link href={"/"}>Home</Link>
        <Link href={"/model_manage"}>Kelola Model</Link>
      </div>

      {/* Error Message */}
      {error && (
        <div className="flex justify-between min-w-4xl rounded-md shadow-2xl bg-red-50 text-red-800 text-sm px-4 py-3 fixed bottom-20 mx-auto text-wrap z-10">
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

        <section className="flex flex-col justify-center items-center w-[80%] bg-gray-200 rounded-2xl shadow-2xl p-5">
          <p className="text-gray-950 text-2xl mb-5">
            Unduh dan Muat Model
          </p>

          <div className="flex gap-4 w-full theme-alt-light">
          
            {/* STT */}
            <div className="flex flex-col gap-4 w-full">
              <DownloadPanel
                title="Download model speech-to-text"
                apiUrl={STT_API_URL}
                mode="dropdown"
                options={STT_DOWNLOADABLE_MODELS}
                onError={setError}
              />

              <ModelPanel
                title="Pilih model speech-to-text"
                apiUrl={STT_API_URL}
                loadedModelId={sttModelId}
                onLoadedChange={setSttModelId}
                onError={setError}
              />
            </div>

            {/* LLM */}
            <div className="flex flex-col gap-4 w-full">
              <DownloadPanel
                title="Download model LLM"
                apiUrl={LLM_API_URL}
                mode="freeform"
                onError={setError}
              />

              <ModelPanel
                title="Pilih model LLM"
                apiUrl={LLM_API_URL}
                loadedModelId={llmModelId}
                onLoadedChange={setLlmModelId}
                onError={setError}
              />
            </div>

          </div>
        </section>

        <section className="flex flex-col justify-center items-center w-[60%] bg-gray-200 rounded-2xl shadow-2xl p-5 theme-alt-light">
          <p className="text-gray-950 text-2xl mb-5">
            Transkripsi Percakapan
          </p>

          <div className="flex gap-10 w-full min-h-60">
            <CombinedTranscriptionPanel
              apiUrl={STT_API_URL}
              loadedModelId={sttModelId}
              transcript={transcript}
              onTranscriptChange={setTranscript}
              onError={setError}
            />

          </div>
          
        </section>
        <section className="flex flex-col justify-center items-center w-[80%] bg-gray-200 rounded-2xl shadow-2xl p-5 theme-alt-light">
          <p className="text-gray-950 text-2xl mb-5">
            Generasi Catatan SOAP
          </p>


          <div className="mb-6 w-full flex flex-col items-center">

            <div className="flex gap-2 w-[60%] items-center">

              {/* Generate button */}
              <button
                disabled={!transcript.trim() || !llmModelId || generating}
                onClick={handleGenerate}
                className="w-full h-full flex-2 rounded-md bg-bg-2 border-bg-2 text-text-2 text-sm px-4 py-2 disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate SOAP Note"}
              </button>
                
              {/* Param button */}
              <div className="h-full flex-1">
                <GenerationParamsPanelPopUp params={genParams} onChange={setGenParams} />
              </div>
              
            </div>

            {(!transcript.trim() || !llmModelId) && (
              <p className="mt-2 text-xs text-text-dark">
                Requires a transcript and a loaded LLM model.
              </p>
            )}
            {(llmTime > 0) && (
              <p className="mt-2 text-xs text-text-dark">
                SOAP Generated in: {llmTime}
              </p>
            )}

          </div>

          <SoapNoteResult
            rawText={soapNote}
          />
          
        </section>





      </div>
      
    </main>
  );
};