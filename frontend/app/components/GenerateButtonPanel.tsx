// "use client";

// interface GenerateButtonPanelProps {
//   apiURL: string;
//   transcript: string;
//   onGenerateStatus: (text: boolean) => void;
//   onSoapNoteChange: (text: string) => void;
//   onError: (message: string) => void;
// }

// function buildSoapPrompt(transcript: string): string {
//   return `Anda adalah seorang asisten dokumentasi medis profesional yang sangat objektif, teliti, dan berbasis fakta mutlak (strict evidence-based). Tugas Anda adalah mengubah transkrip percakapan antara dokter dan pasien di bawah ini menjadi catatan SOAP (Subjective, Objective, Assessment, Plan) dalam Bahasa Indonesia.

// Patuhi aturan ketat berikut tanpa pengecualian:

// 1. KONTROL FAKTA & LARANGAN HALUSINASI NUMERIK / MEDIS:
//    - HANYA tuliskan informasi yang secara eksplisit ada di dalam transkrip. 
//    - Dilarang keras mengarang, menebak, atau menambahkan prosedur medis, pemeriksaan penunjang (seperti tes darah, rontgen, biopsi, lab), maupun jenis obat yang TIDAK DISEBUTKAN secara eksplisit oleh dokter atau pasien di dalam transkrip.
//    - ATURAN KHUSUS BAGIAN OBJECTIVE (Tanda Vital & Pemeriksaan Fisik): Jika dokter atau pasien TIDAK MENYEBUTKAN nilai tanda vital tertentu (seperti tekanan darah, suhu tubuh, atau denyut nadi) di dalam transkrip, DILARANG KERAS MENGARANG ANGKA (contoh: jangan menulis 120/80 mmHg atau 36.5°C jika tidak disebut). Anda WAJIB menuliskan secara jujur: "Informasi tidak disebutkan dalam transkrip" atau "Data tanda vital tidak tersedia".
//    - CONTOH PENANGANAN DATA KOSONG:
//     * Suhu tubuh: Informasi tidak disebutkan.
//     * Tekanan darah: Informasi tidak disebutkan.
//    - Waspadai penyangkalan pasien: Jika pasien menyatakan tidak memiliki riwayat alergi atau tidak pernah mengalami sesuatu, catat sebagai tidak ada. Jangan memutarbalikkan pernyataan pasien.

// 2. ATURAN KETAT DESKRIPSI LESI / RUAM / FISIK:
//    - Bagian Objective HANYA boleh mencatat bentuk, lokasi, atau kondisi fisik yang secara lisan dideskripsikan langsung oleh pasien atau dokter di dalam transkrip (misalnya: jumlah, lokasi di tubuh, atau kondisi pecah karena digaruk).
//    - Dilarang keras berasumsi atau menambahkan deskripsi medis fiktif yang tidak diucapkan di transkrip, seperti berasumsi lesi "berisi nanah", "mengeluarkan cairan", atau memiliki warna tertentu (seperti "merah muda") jika kata-kata tersebut tidak keluar dari percakapan.

// 3. PROTEKSI KELOMPOK PENGANDAIAN & KEMUNGKINAN DOKTER:
//    - Waspadai kalimat pengandaian, antisipasi, atau kemungkinan yang diucapkan oleh dokter (contoh: "kalau ada keluhan lain seperti nyeri...", "jika nanti muncul demam..."). 
//    - Kalimat-kalimat bersyarat dari dokter BUKAN berarti pasien sedang mengalami gejala tersebut. Jangan pernah mencatat angan-angan atau skenario hipotesis dokter ke dalam bagian Subjective pasien.

// 4. KOREKSI KONSEPTUAL ASR TYPO:
//    - Terjemahkan kesalahan ketik otomatis (typo dari speech-to-text) secara masuk akal, dan frasa keliru mengenai lokasi pemeriksaan dipahami secara logis sesuai konteks percakapan medis, bukan ditelan secara harfiah. 
//    CONTOH MENANGANI KATA-KATA KESALAHAN TRANSKRIP YANG TIDAK MASUK AKAL: 
//    * "meriam" dipahami sebagai "meriang". 
//    * "getel" dipahami sebagai "gatal". 
//    * "demam pudara hidupu" dipahami sebagai "demam berdarah". 
//    * "demang" dipahami sebagai "demam". 
//    * "begal" dipahami sebagai "pegal". 

// 5. KETENTUAN SUDUT PANDANG (Clinical Third-Person Perspective):
//    - Catatan SOAP WAJIB ditulis dari sudut pandang objektif pihak ketiga (sudut pandang tenaga medis/perekam medis profesional). 
//    - DILARANG KERAS menggunakan sudut pandang orang pertama ("Saya", "Aku", "Dokter", atau "Pasien" yang berbicara langsung seperti narasi dialog). 
//    - Gunakan format pelaporan klinis.
//    Contoh BENAR:
//    * Pasien mengeluhkan...
//    * Riwayat pengobatan mandiri...
//    * Dokter menginstruksikan...

// 6. ATURAN KETAT BAGIAN PLAN (No Generic Plan Hallucination):
//    - Jika dokter di transkrip hanya meminta pemeriksaan fisik umum atau mengajak ke kasur pemeriksaan tanpa merinci tes lab, maka Plan HANYA mencatat pemeriksaan fisik lanjutan/umum sesuai transkrip.

// 7. PEMISAHAN BAGIAN YANG KETAT:
//    - Subjective: HANYA berisi keluhan utama, durasi, karakteristik gejala, riwayat pengobatan mandiri, riwayat alergi, dan riwayat kontak yang dikatakan oleh pasien. Dilarang memasukkan hasil pengamatan fisik di sini.
//    - Objective: HANYA berisi temuan fisik, deskripsi lesi/ruam/luka yang tampak atau didiskusikan secara nyata saat pemeriksaan, serta tanda vital (atau nyatakan tidak ada jika transkrip tidak menyebutkannya). Dilarang keras memasukkan kembali keluhan subjektif ke dalam bagian ini.
//    - Assessment: Berisi kesimpulan klinis sementara atau pernyataan dokter bahwa diagnosis belum pasti dan memerlukan pemeriksaan lebih lanjut.
//    - Plan: HANYA berisi rencana tindakan, obat, atau edukasi yang secara eksplisit diucapkan kata per kata oleh dokter di akhir transkrip. Jangan menambah-nambahkan kata-kata yang tidak disebutkan, seperti menuliskan "tes darah", "rontgen", atau jenis tindakan spesifik lain yang tidak disebut. 


// Format Output:
// Gunakan tepat empat judul bagian ini, masing-masing pada baris tersendiri, dalam urutan berikut tanpa tambahan kata pengantar atau komentar di luar format:

// Subjective:
// Objective:
// Assessment:
// Plan:

// Berikut adalah transkrip percakapan yang harus Anda ubah:
// ${transcript}`;
// }

// export default function GenerateButtonPanel({
//   apiURL,
//   transcript,
//   onGenerateStatus,
//   onSoapNoteChange,
//   onError,
// }: GenerateButtonPanelProps) {

//   async function handleGenerate() {
//     if (!transcript.trim() || !llmModelId) return;
//     console.log("Generating with", genParams)

//     onGenerateStatus(true);
//     onError(null);
//     onSoapNoteChange("");

//     try {
//       const res = await fetch(`${LLM_API_URL}/chat`, {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           model_id: llmModelId,
//           message: buildSoapPrompt(transcript),
//           ...genParams,
//         }),
//       });
//       const data = await res.json();
//       if (!res.ok) {
//         setError(data.detail || `SOAP note generation failed (${res.status})`);
//         return;
//       }
//       const reply = data.choices?.[0]?.message?.content ?? "";
//       console.log(data)
//       setSoapNote(reply);

//       // Result Metrics
//       setLLMTime(data.metrics.processing_time);
//       setLlmMetrics(data.metrics ?? null);
//     } catch (err) {
//       setError(err instanceof Error ? err.message : String(err));
//     } finally {
//       setGenerating(false);
//     }
//   }

//   return (
    // <div className="rounded-lg border border-gray-200 p-4">
    //   <button
    //     disabled={!transcript.trim() || !llmModelId || generating}
    //     onClick={handleGenerate}
    //     className="w-full rounded-md bg-gray-900 text-white text-sm px-4 py-2 disabled:opacity-40"
    //   >
    //     {generating ? "Generating…" : "Generate SOAP Note"}
    //   </button>
    //   {(!transcript.trim() || !llmModelId) && (
    //     <p className="mt-2 text-xs text-gray-400">
    //       Requires a transcript and a loaded LLM model.
    //     </p>
    //   )}
    //   {(llmTime > 0) && (
    //     <p className="mt-2 text-xs text-gray-400">
    //       SOAP Generated in: {llmTime}
    //     </p>
    //   )}
    // </div>
//   );
// }