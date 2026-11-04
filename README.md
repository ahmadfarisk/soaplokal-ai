



<!-- # ⚠️ WARNING ⚠️
## Proyek ini masih belum selesai! Instalasi/setup (setup_cpu.ps1 dan setup_gpu.ps1) belum diuji!

--- -->

# SOAPLokal AI 🩺🤖

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

> **Pengecualian — Linux dengan GPU NVIDIA (jalur prebuilt):**
> Skrip `setup_linux_gpu.sh` memakai *prebuilt* llama.cpp CUDA, jadi **CMake, C++ compiler, dan CUDA Toolkit tidak diperlukan** — cukup driver NVIDIA terbaru sudah terpasang (cek dengan `nvidia-smi`). Python 3.10–3.12, Node.js, dan FFmpeg dicek otomatis oleh skrip; jika Python sistem Anda 3.13+, skrip menyediakan Python 3.12 lewat `uv` di level user (tanpa sudo).

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

2. Jalankan skrip instalasi sesuai sistem operasi dan konfigurasi perangkat keras Anda:

   ### Windows (PowerShell)

   - **Jika hanya ingin menggunakan CPU**
     ```powershell
     .\setup_cpu.ps1
     ```

      Parameter:

      - `-SkipLlamaCpp`
            Jangan clone atau build berkas llama.cpp (misalnya, jika Anda hanya menggunakan model OpenVINO).

      - `-RebuildLlamaCpp`
            Build ulang berkas llama.cpp meskipun berkas llama-server.exe sudah ada.

      - `-NonInteractive`
            Terima semua pengaturan default dan lewati setiap permintaan (tanpa login ke Hugging Face).

   - **Jika ingin menggunakan GPU NVIDIA (CUDA):**
     ```powershell
     .\setup_gpu.ps1
     ```

      Parameter:

      - `-BuildFromSource`
            Clone dan build berkas llama.cpp dengan CUDA sendiri, alih-alih mengunduh versi yang sudah dikompilasi. Diperlukan Git, CMake, Visual Studio Build Tools, dan CUDA Toolkit. (Disarankan jika tidak ada berkas llama.cpp yang sudah dikompilasi untuk versi CUDA Anda)

      - `-ReinstallLlamaCpp`
            Instal ulang file llama.cpp versi CUDA, meskipun dukungan CUDA sudah terdeteksi.

      - `-NonInteractive`
            Terima semua pengaturan default dan lewati setiap permintaan (tanpa login ke Hugging Face).

   ### Linux / WSL (Bash)

   Untuk mesin dengan GPU NVIDIA:

   ```bash
   ./setup_linux_gpu.sh
   ```

   Ini setup *one-shot* yang berdiri sendiri (tidak perlu menjalankan setup CPU dulu). Skrip akan:
   - Memeriksa prasyarat: GPU NVIDIA + driver (via `nvidia-smi`), Python 3.10–3.12, Node.js, npm, dan FFmpeg
   - Menyediakan Python 3.12 lewat `uv` (level user, tanpa sudo) jika Python sistem 3.13+ atau tidak ada
   - Menginstal `llama.cpp` build CUDA — secara default dari *prebuilt* release (tanpa CMake/compiler/CUDA Toolkit)
   - Membuat virtual environment dan memasang backend LLM, backend STT (termasuk pustaka NVIDIA cuBLAS/cuDNN untuk faster-whisper), dan `node_modules` frontend
   - Menulis `frontend/.env.local` dan (opsional) login ke Hugging Face untuk model gated

   Aman dijalankan ulang: langkah yang sudah selesai akan dilewati/disegarkan.

   Parameter:

   - `--build-from-source`
            Clone dan build llama.cpp dengan CMake/CUDA sendiri, alih-alih mengunduh versi yang sudah dikompilasi. Memerlukan Git, CMake, C++ compiler, dan CUDA Toolkit. (Disarankan jika tidak ada *prebuilt* untuk versi CUDA Anda)

   - `--reinstall-llama-cpp`
            Instal ulang/build ulang llama.cpp meskipun dukungan CUDA sudah terdeteksi.

   - `--non-interactive`
            Terima semua pengaturan default dan lewati setiap permintaan (tanpa login ke Hugging Face).

---

## 🚀 Cara Menjalankan Aplikasi (Usage)

1. Nyalakan aplikasi dengan menjalankan skrip starter (menjalankan ketiga service — LLM backend, STT backend, dan frontend — dari satu terminal, dan menghentikan semuanya saat Ctrl+C):
   - **Windows (PowerShell)**
     ```powershell
     .\start.ps1
     ```
   - **Linux / WSL (Bash)**
     ```bash
     ./start.sh
     ```

     Parameter yang tersedia di kedua skrip:
     - `--dev` / `-Dev` — jalankan backend dengan `uvicorn --reload` (off by default, karena reload me-restart proses dan melempar model yang sedang dimuat)
     - `--quiet` / `-Quiet` — jangan menampilkan baris error di terminal (tetap ditulis ke log)
     - `--open-browser` / `-OpenBrowser` — buka frontend di browser default saat semuanya siap

2. Buka antarmuka web melalui browser Anda (http://localhost:3000).
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