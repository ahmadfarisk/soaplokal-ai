# SOAPLocal AI 🩺🤖

Aplikasi web berbasis kecerdasan buatan (AI) lokal yang dirancang khusus untuk mentranskripsikan percakapan antara dokter dan pasien secara *real-time* atau melalui unggahan audio, serta otomatis menghasilkan catatan medis berformat **SOAP** (*Subjective, Objective, Assessment, Plan*). 

Projek ini berjalan **100% secara offline dan privat** di perangkat Anda tanpa mengirimkan data medis sensitif ke server eksternal.

---

## 🚀 Fitur Utama

- **100% Offline & Privat:** Menjaga kerahasiaan data pasien karena seluruh pemrosesan AI berjalan secara lokal di perangkat Anda.
- **Manajemen Model Fleksibel:** Kemudahan mengunduh berbagai model STT dan LLM langsung dari Hugging Face sesuai preferensi Anda.
- **Dual Mode Transkripsi:** Mendukung transkripsi dari file audio yang diunggah maupun rekaman suara secara langsung (*live*).
- **Otomatisasi Catatan SOAP:** Mengubah hasil transkripsi percakapan medis menjadi catatan klinis terstruktur (SOAP) dengan sekali klik.

---

## 🛠️ Tech Stack

- **Frontend:** Next.js
- **Backend:** FastAPI, `llama.cpp`
- **Model AI:** 
  - **Speech-to-Text (STT):** `faster-whisper`
  - **LLM:** OpenVINO & `llama.cpp`

---

## 💻 Persyaratan Sistem (System Requirements)

Sebelum menjalankan aplikasi, pastikan sistem Anda telah terinstal perangkat lunak berikut:
- **Python** (Versi 3.10 atau yang lebih baru)
- **Node.js**
- **CMake**
- **FFmpeg**
- **C++ compiler**
- **Processor Intel** (diperlukan jika ingin menggunakan akselerasi OpenVINO)
- **CUDA Toolkit** (diperlukan jika ingin menggunakan akselerasi GPU NVIDIA)

> **Spesifikasi Referensi Pengembangan:**
> Aplikasi ini diuji dan dikembangkan pada perangkat dengan spesifikasi:
> - **CPU:** Intel(R) Core(TM) i7-9750H
> - **RAM:** 32 GB
> - **GPU:** NVIDIA GeForce RTX 2080 (8GB VRAM)

---

## ⚙️ Panduan Instalasi (Setup)

1. Kloning repositori ini ke komputer lokal Anda:
   ```bash
   git clone https://github.com/username/nama-repositori.git
   cd nama-repositori
   ```

2. Jalankan skrip instalasi sesuai dengan konfigurasi perangkat keras Anda (jalankan melalui PowerShell di Windows):
   - **Untuk pengguna CPU / OpenVINO:**
     ```powershell
     .\setup_cpu.ps1
     ```
   - **Untuk pengguna GPU NVIDIA (CUDA):**
     ```powershell
     .\setup_gpu.ps1
     ```

---

## 🚀 Cara Menjalankan Aplikasi (Usage)

1. Nyalakan aplikasi dengan menjalankan skrip berikut melalui PowerShell:
   ```powershell
   .\start.ps1
   ```
2. Buka antarmuka web melalui browser Anda.
3. **Mengunduh & Memilih Model:**
   - Unduh model STT dan LLM melalui menu aplikasi. 
   - *Rekomendasi Model STT:* `faster-whisper-large-v3`
   - *Rekomendasi Model LLM:* `lmstudio-community/Qwen3-4B-Instruct-2507-GGUF`
   - Pilih model STT dan LLM yang diinginkan, lalu klik tombol **'Load'** untuk mengaktifkan model ke dalam memori.
4. **Memulai Transkripsi:**
   - Unggah berkas audio percakapan medis atau gunakan fitur rekam suara secara *live*.
5. **Membuat Catatan SOAP:**
   - Setelah proses transkripsi selesai, klik tombol **'Generate SOAP note'** untuk menghasilkan ringkasan medis terstruktur.

> ⚠️ **Catatan Penting:** 
> Fitur penghapusan model (*delete*) pada halaman utama saat ini hanya menghapus referensi di UI. Untuk versi ini, folder atau berkas model fisik harus dihapus secara manual dari direktori penyimpanan lokal Anda.

---

## 📝 Kontribusi & Lisensi
Kontribusi, saran, dan laporan *bug* sangat dipersilakan melalui *Issues* atau *Pull Requests* di repositori ini.