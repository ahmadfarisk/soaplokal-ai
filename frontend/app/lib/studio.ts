// Shared helpers for the studio page (app/studio/page.tsx and components/studio/*).

export interface StatItem {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * FastAPI returns `detail` as a string for our own errors, but as a LIST of
 * objects for request-validation errors. Rendering that list directly crashes
 * React ("Objects are not valid as a React child"), so always go through this.
 */
export function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) =>
          item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : ""
        )
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return `Request failed (${status})`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 83 -> "01:23" */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// SOAP note generation settings
// ---------------------------------------------------------------------------

// Conservative sampling: a SOAP note is a faithful summary, not creative writing.
// (The backend must accept these fields in its chat request; unknown fields are ignored.)
export const GEN_PARAMS = {
  temperature: 0.4,
  top_p: 0.2,
  top_k: 40,
  repetition_penalty: 1.1,
  max_tokens: 2048,
};

// Sent as the system message. The section headers stay in English so parseSoap()
// can find them, while the note itself is written in Indonesian.
// export const SOAP_SYSTEM_PROMPT = `You are a clinical documentation assistant. You will receive an automatic speech-recognition (ASR) transcript of a doctor-patient consultation in Indonesian. Speakers are NOT labeled, and the transcript may contain misheard or garbled words.

// Write a SOAP note in Indonesian, in the third person and a formal clinical style. Refer to the patient as "Pasien". Never use "saya", "aku" or "Anda".

// Rules:
// 1. Use ONLY information stated in the transcript. Never add symptoms, measurements, diagnoses, medications, doses or advice that were not said.
// 2. If a section has no information in the transcript, write exactly: "Tidak disebutkan dalam percakapan."
// 3. Subjective: what the patient reports (complaints, history, duration). Objective: only measurements or examination findings explicitly stated. Assessment: only a diagnosis or impression the doctor explicitly stated. Plan: only treatments, medications, tests or follow-up the doctor explicitly stated.
// 4. If a word looks like a transcription error, correct it only when the intended word is obvious from the surrounding context. If unsure, keep the word as written and add [?]. Do not guess.
// 5. Output exactly these four headers in English, each on its own line: Subjective:, Objective:, Assessment:, Plan:. No preamble, no commentary.`;
export const SOAP_SYSTEM_PROMPT = `Anda adalah seorang asisten dokumentasi medis profesional yang sangat objektif, teliti, dan berbasis fakta mutlak (strict evidence-based). Tugas Anda adalah mengubah transkrip percakapan antara dokter dan pasien di bawah ini menjadi catatan SOAP (Subjective, Objective, Assessment, Plan) dalam Bahasa Indonesia.

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
Plan:`;


// ---------------------------------------------------------------------------
// SOAP parsing
// ---------------------------------------------------------------------------

export interface SoapSections {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

/** Removes <think>...</think> blocks that "reasoning" models put before their answer. */
export function stripThinking(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/<think>[\s\S]*$/i, ""); // unclosed block: the model was cut off mid-thought
  return text.trim();
}

// A header line: optional markdown (#, **, __), one of the four words, then a colon.
// Requiring the colon means ordinary text like "plan to ..." is not mistaken for a header.
const HEADER_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(Subjective|Objective|Assessment|Plan)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;

export function parseSoap(raw: string): SoapSections {
  const buckets: Record<keyof SoapSections, string[]> = {
    subjective: [],
    objective: [],
    assessment: [],
    plan: [],
  };
  // Text before any header lands in "subjective" so nothing silently disappears.
  let current: keyof SoapSections = "subjective";

  for (const line of stripThinking(raw).split(/\r?\n/)) {
    const match = line.match(HEADER_RE);
    if (match) {
      current = match[1].toLowerCase() as keyof SoapSections;
      if (match[2].trim()) buckets[current].push(match[2].trim());
    } else {
      buckets[current].push(line);
    }
  }

  const join = (lines: string[]) => lines.join("\n").trim();
  return {
    subjective: join(buckets.subjective),
    objective: join(buckets.objective),
    assessment: join(buckets.assessment),
    plan: join(buckets.plan),
  };
}

export function formatSoapForCopy(sections: SoapSections): string {
  const part = (title: string, body: string) => `${title}:\n${body || "-"}`;
  return [
    part("Subjective", sections.subjective),
    part("Objective", sections.objective),
    part("Assessment", sections.assessment),
    part("Plan", sections.plan),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Shared style classes
// Every colour is explicit (no inherited text colour), so nothing becomes
// unreadable when the OS is in dark mode.
// ---------------------------------------------------------------------------

export const ui = {
  card: "rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6",
  cardTitle: "text-base font-semibold text-slate-900",
  muted: "text-sm text-slate-600",
  input:
    "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500",
  primaryButton:
    "inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-300 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none",
  secondaryButton:
    "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400",
  spinner: "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
};