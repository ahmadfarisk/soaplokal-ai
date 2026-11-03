#!/usr/bin/env bash
#
# One-shot GPU (CUDA) setup for this project on Linux/WSL, using an NVIDIA GPU.
#
# A complete setup on its own: you do NOT need to run a CPU setup first.
# Use this on machines with an NVIDIA GPU.
#
# Compared with the Windows GPU setup (setup_gpu.ps1):
#   - llama.cpp is installed as a CUDA build. By default this is a prebuilt
#     download (the "ubuntu-cuda" release tarballs), so no CMake, compiler or
#     CUDA Toolkit is needed for it.
#   - Python 3.10-3.12 is required. If the system Python is 3.13+ (or missing),
#     the script provisions Python 3.12 via `uv` — user-level, no sudo needed.
#   - requirements.txt files saved as UTF-16 (Windows editors) are re-encoded
#     to UTF-8 before pip can read them.
#   - The NVIDIA cuBLAS/cuDNN libraries for faster-whisper are installed into
#     the STT backend venv.
#
# Run from the repo root (or anywhere — the script finds its own folder).
# Safe to re-run: finished steps are skipped or refreshed.
#
# Usage:
#   ./setup_linux_gpu.sh                      prebuilt llama.cpp (default)
#   ./setup_linux_gpu.sh --build-from-source  clone + build llama.cpp with CMake/CUDA
#   ./setup_linux_gpu.sh --reinstall-llama-cpp force reinstall/rebuild llama.cpp
#   ./setup_linux_gpu.sh --non-interactive    accept all defaults, no prompts
#
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUILD_FROM_SOURCE=0
REINSTALL_LLAMA_CPP=0
NON_INTERACTIVE=0

usage() {
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-from-source)   BUILD_FROM_SOURCE=1 ;;
        --reinstall-llama-cpp) REINSTALL_LLAMA_CPP=1 ;;
        --non-interactive)     NON_INTERACTIVE=1 ;;
        -h|--help)             usage; exit 0 ;;
        *) echo "Unknown option: $1 (use --help)" >&2; exit 2 ;;
    esac
    shift
done

# ---------------------------------------------------------------------------
# Colors and output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    CYAN=$'\033[36m'; GRAY=$'\033[90m'; NC=$'\033[0m'
else
    RED=""; GREEN=""; YELLOW=""; CYAN=""; GRAY=""; NC=""
fi

section() {
    echo ""
    echo -e "${CYAN}=== $1 ===${NC}"
}

# ---------------------------------------------------------------------------
# Project layout — edit here if your folder names differ
# ---------------------------------------------------------------------------
BACKENDS=(
    "llm-studio-backend 8000"
    "stt-backend-faster-whisper 8001"
)
FRONTEND_DIR="$ROOT/frontend"
LLAMA_DIR="$ROOT/llama.cpp"
# where the LLM backend looks for llama-server (see llm-studio-backend/inference_service.py)
LLAMA_BIN_DIR="$LLAMA_DIR/build/bin"
LLAMA_BIN="$LLAMA_BIN_DIR/llama-server"
BACKUP_DIR="$LLAMA_DIR/cpu-build-backup"

# ---------------------------------------------------------------------------
# Step/result bookkeeping (one step failing must not hide the rest)
# ---------------------------------------------------------------------------
RESULTS_STATUS=()
RESULTS_STEP=()
RESULTS_DETAIL=()
STEP_STATUS="OK"
STEP_DETAIL=""

add_result() { # status step detail
    RESULTS_STATUS+=("$1"); RESULTS_STEP+=("$2"); RESULTS_DETAIL+=("${3:-}")
}

run_step() { # name function [args...]
    local name="$1"; shift
    STEP_STATUS="OK"; STEP_DETAIL=""
    echo ""
    echo -e "${YELLOW}>> $name${NC}"
    if "$@"; then
        add_result "$STEP_STATUS" "$name" "$STEP_DETAIL"
    else
        local rc=$?
        add_result "FAILED" "$name" "exit code $rc"
    fi
}

run_checked() { # description command...
    local desc="$1"; shift
    "$@"
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        echo -e "   ${RED}$desc failed (exit code $rc).${NC}" >&2
        return 1
    fi
    return 0
}

read_default() { # prompt default
    if [[ $NON_INTERACTIVE -eq 1 ]]; then echo "$2"; return; fi
    local value
    read -r -p "$1 [$2] " value
    if [[ -z "$value" ]]; then echo "$2"; else echo "$value"; fi
}

ask_yn() { # prompt  -> returns 0 for yes
    local answer
    read -r -p "$1 (y/N) " answer
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

die() {
    echo -e "${RED}$1${NC}" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# 1. GPU check
# ---------------------------------------------------------------------------
section "Checking the GPU"

if ! command -v nvidia-smi >/dev/null 2>&1; then
    die "No NVIDIA GPU or driver detected (nvidia-smi not found).
Without an NVIDIA GPU, use a CPU setup instead.
If you do have an NVIDIA card, install/update its driver (on WSL: install the
Windows driver from nvidia.com, then re-run in a fresh terminal)."
fi

GPU_LINE=$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
if [[ -z "$GPU_LINE" ]]; then
    die "nvidia-smi returned nothing. Install or update the NVIDIA driver and re-run."
fi
GPU_NAME=$(echo "$GPU_LINE" | cut -d, -f1 | xargs)
GPU_DRIVER=$(echo "$GPU_LINE" | cut -d, -f2 | xargs)
GPU_VRAM_MB=$(echo "$GPU_LINE" | cut -d, -f3 | xargs)

# The highest CUDA version the driver supports is in the nvidia-smi header
# ("CUDA Version: X.Y" or, on newer WSL drivers, "CUDA UMD Version: X.Y")
GPU_CUDA=$(nvidia-smi 2>/dev/null | grep -oE 'CUDA[ A-Za-z]*Version: [0-9]+\.[0-9]+' | head -1 | grep -oE '[0-9]+\.[0-9]+')

GPU_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | xargs)
[[ "$GPU_CAP" =~ ^[0-9]+\.[0-9]+$ ]] || GPU_CAP=""

echo -e "  GPU:            ${GREEN}$GPU_NAME${NC}"
echo "  VRAM:           $GPU_VRAM_MB MB"
echo "  Driver:         $GPU_DRIVER"
echo "  Max CUDA:       ${GPU_CUDA:-unknown}"
[[ -n "$GPU_CAP" ]] && echo "  Compute cap:    $GPU_CAP"

if [[ -z "$GPU_CUDA" ]] || ! python3 -c "import sys; sys.exit(0 if tuple(map(int,'$GPU_CUDA'.split('.'))) >= (12,0) else 1)"; then
    die "The driver reports CUDA ${GPU_CUDA:-unknown}; the builds used here need CUDA 12 or newer.
Update the NVIDIA driver, open a new terminal, and re-run."
fi

if [[ "$GPU_VRAM_MB" -gt 0 && "$GPU_VRAM_MB" -lt 6000 ]]; then
    echo -e "  ${YELLOW}Note: under 6 GB of VRAM is tight. Pick small models, and expect the LLM and
Whisper not to fit at the same time.${NC}"
fi

# ---------------------------------------------------------------------------
# 2. Prerequisites (checked BEFORE any installation happens)
# ---------------------------------------------------------------------------
section "Checking prerequisites"

FATAL_MISSING=0

report_prereq() { # name ok detail hint fatal(1/0)
    local name="$1" ok="$2" detail="$3" hint="${4:-}" fatal="${5:-1}"
    if [[ "$ok" == "1" ]]; then
        echo -e "  [${GREEN}  OK   ${NC}] $(printf '%-16s' "$name") $detail"
        add_result "OK" "Prereq: $name" "$detail"
    elif [[ "$fatal" == "1" ]]; then
        echo -e "  [${RED}MISSING${NC}] $(printf '%-16s' "$name") $detail"
        [[ -n "$hint" ]] && echo -e "            ${GRAY}Fix: $hint${NC}"
        add_result "FAILED" "Prereq: $name" "$detail"
        FATAL_MISSING=1
    else
        echo -e "  [${YELLOW} WARN  ${NC}] $(printf '%-16s' "$name") $detail"
        [[ -n "$hint" ]] && echo -e "            ${GRAY}Fix: $hint${NC}"
        add_result "WARNING" "Prereq: $name" "$detail"
    fi
}

# --- Python 3.10-3.12 (the pinned wheels don't exist for 3.13+) ------------
PYTHON_BIN=""
for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        pv=$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)
        case "$pv" in
            3.10|3.11|3.12) PYTHON_BIN="$(command -v "$candidate")"; break ;;
        esac
    fi
done

if [[ -n "$PYTHON_BIN" ]]; then
    py_ver=$("$PYTHON_BIN" --version 2>&1)
    report_prereq "Python" 1 "$py_ver"
elif command -v uv >/dev/null 2>&1; then
    report_prereq "Python" 1 "system Python unusable (3.13+); Python 3.12 will be provisioned via uv"
else
    # Offer to install uv (user-level, no sudo) and let it fetch Python 3.12
    py_ok=0
    if [[ $NON_INTERACTIVE -eq 1 ]] || ask_yn "Python 3.10-3.12 not found. Install 'uv' (user-level, no sudo) to provision Python 3.12?"; then
        if curl -LsSf https://astral.sh/uv/install.sh | sh; then
            export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
            if command -v uv >/dev/null 2>&1; then
                report_prereq "Python" 1 "uv installed; Python 3.12 will be provisioned via uv"
                py_ok=1
            fi
        else
            echo -e "   ${RED}uv installation failed.${NC}"
        fi
    fi
    if [[ $py_ok -eq 0 ]]; then
        report_prereq "Python" 0 "no usable Python 3.10-3.12, and uv is not available" \
            "install uv (https://docs.astral.sh/uv/) or a Python 3.10-3.12, then re-run"
    fi
fi

# --- Node.js 18+ / npm ------------------------------------------------------
NODE_OK=0
if command -v node >/dev/null 2>&1; then
    NV_MAJOR=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
    if [[ "$NV_MAJOR" =~ ^[0-9]+$ && "$NV_MAJOR" -ge 18 ]]; then
        NODE_OK=1
        report_prereq "Node.js" 1 "$(node --version)"
    else
        report_prereq "Node.js" 0 "$(node --version 2>/dev/null) (need 18 or newer)" \
            "install Node.js 18+ (https://nodejs.org or nvm)"
    fi
else
    report_prereq "Node.js" 0 "not found on PATH" "install Node.js 18+ (https://nodejs.org or nvm)"
fi
if command -v npm >/dev/null 2>&1; then
    report_prereq "npm" 1 "$(npm --version)"
else
    report_prereq "npm" 0 "not found" "reinstall Node.js (npm ships with it)"
fi

# --- Only needed when building llama.cpp yourself ---------------------------
if [[ $BUILD_FROM_SOURCE -eq 1 ]]; then
    SRC_MISSING=0

    if command -v git >/dev/null 2>&1; then
        report_prereq "git" 1 "$(git --version | awk '{print $3}')"
    else
        report_prereq "git" 0 "not found" "sudo apt install -y git"
        SRC_MISSING=1
    fi

    CMAKE_OK=0; command -v cmake >/dev/null 2>&1 && CMAKE_OK=1
    GCCXX_OK=0; command -v g++ >/dev/null 2>&1 && GCCXX_OK=1
    NVCC_OK=0;  command -v nvcc  >/dev/null 2>&1 && NVCC_OK=1
    [[ $CMAKE_OK -eq 0 || $GCCXX_OK -eq 0 || $NVCC_OK -eq 0 ]] && SRC_MISSING=1

    if [[ $CMAKE_OK -eq 1 ]]; then
        report_prereq "CMake" 1 "CMake $(cmake --version | head -1 | awk '{print $3}')"
    else
        report_prereq "CMake" 0 "not found" "sudo apt install -y cmake"
    fi

    if [[ $GCCXX_OK -eq 1 ]]; then
        report_prereq "C++ compiler" 1 "$(g++ --version | head -1 | awk '{print $1, $4}')"
    else
        report_prereq "C++ compiler" 0 "g++ not found" "sudo apt install -y build-essential"
    fi

    if [[ $NVCC_OK -eq 1 ]]; then
        report_prereq "CUDA Toolkit" 1 "$(nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | head -1)"
    else
        report_prereq "CUDA Toolkit" 0 "nvcc not found" "sudo apt install -y nvidia-cuda-toolkit"
        # Offer the apt install now (needs the user's sudo password)
        if [[ $NON_INTERACTIVE -eq 0 ]] && ask_yn "Install CUDA Toolkit + build tools now via apt (sudo, ~2-4 GB)?" && \
           sudo apt-get install -y nvidia-cuda-toolkit cmake build-essential git; then
            # Re-check and clear the flag if everything is present now
            command -v cmake >/dev/null 2>&1 && CMAKE_OK=1
            command -v g++   >/dev/null 2>&1 && GCCXX_OK=1
            command -v nvcc  >/dev/null 2>&1 && NVCC_OK=1
            [[ $CMAKE_OK -eq 1 && $GCCXX_OK -eq 1 && $NVCC_OK -eq 1 ]] && { SRC_MISSING=0; echo -e "   ${GREEN}Build tools + CUDA Toolkit installed.${NC}"; }
        fi
    fi
    [[ $SRC_MISSING -eq 1 ]] && FATAL_MISSING=1
fi

# --- ffmpeg (optional: only for audio-file transcription edge cases) --------
if command -v ffmpeg >/dev/null 2>&1; then
    report_prereq "ffmpeg" 1 "$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')" 0
else
    report_prereq "ffmpeg" 0 "not found (optional)" "sudo apt install -y ffmpeg" 0
fi

if [[ $FATAL_MISSING -eq 1 ]]; then
    die "Required prerequisites are missing. Install them, open a NEW terminal (so PATH refreshes), and re-run."
fi

# ---------------------------------------------------------------------------
# 3. llama.cpp with CUDA
# ---------------------------------------------------------------------------
section "llama.cpp (CUDA build)"

test_llama_cuda() { # binary -> 0 if it lists a CUDA device
    local bin="$1"
    [[ -x "$bin" || -f "$bin" ]] || return 1
    "$bin" --list-devices 2>&1 | grep -q 'CUDA'
}

running_project_llama() {
    pgrep -af 'llama-server' 2>/dev/null | grep -qF "$LLAMA_DIR"
}

backup_cpu_build() {
    [[ -f "$LLAMA_BIN" ]] || return 0
    [[ -d "$BACKUP_DIR" ]] && return 0
    if test_llama_cuda "$LLAMA_BIN"; then return 0; fi
    mkdir -p "$BACKUP_DIR"
    cp -a "$LLAMA_BIN_DIR/." "$BACKUP_DIR/"
    echo "   Saved the existing CPU build to $BACKUP_DIR"
}

# --- 3a. prebuilt (default) --------------------------------------------------
step_install_prebuilt_llama() {
    if test_llama_cuda "$LLAMA_BIN" && [[ $REINSTALL_LLAMA_CPP -eq 0 ]]; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="CUDA support already detected (use --reinstall-llama-cpp to reinstall)"
        return 0
    fi
    if running_project_llama; then
        echo -e "   ${RED}A llama-server from this project is running. Stop the app (Ctrl+C in start.sh) and re-run.${NC}"
        return 1
    fi

    echo "   Looking up the latest llama.cpp release with an ubuntu CUDA 12.x x64 build..."
    local disc
    if ! disc=$(python3 - "$GPU_CUDA" <<'PY' 2>&1
import json, re, sys, urllib.request

driver = sys.argv[1] or ""
def ver(t): return tuple(int(x) for x in t.split("."))
driver_v = ver(driver) if driver else None

req = urllib.request.Request(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15",
    headers={"User-Agent": "setup_linux_gpu.sh", "Accept": "application/vnd.github+json"})
with urllib.request.urlopen(req, timeout=30) as r:
    rels = json.load(r)

pat = re.compile(r"^llama-b(\d+)-bin-ubuntu-cuda-(12\.\d+)-x64\.tar\.gz$")
best = None
avail = set()
for rel in rels:
    by_name = {a["name"]: a for a in rel.get("assets", [])}
    for a in rel.get("assets", []):
        m = pat.match(a["name"])
        if m:
            bnum, cv = m.group(1), m.group(2)
            cudart = by_name.get(f"cudart-llama-b{bnum}-bin-ubuntu-cuda-{cv}-x64.tar.gz")
            if cudart:
                if best is None or ver(cv) > ver(best[0]):
                    best = (cv, rel["tag_name"], a, cudart)
        if "ubuntu-cuda" in a["name"]:
            avail.add(a["name"])

if not best:
    print("no-matching-asset")
    for n in sorted(avail)[:12]:
        print("   " + n)
    sys.exit(1)
cv, tag, main, cudart = best
print(f"{tag}|{main['browser_download_url']}|{cudart['browser_download_url']}|{cv}")
PY
    ); then
        if [[ "$disc" == no-matching-asset* ]]; then
            echo -e "   ${RED}No prebuilt ubuntu CUDA 12.x build found that matches this driver (CUDA ${GPU_CUDA}).${NC}"
            echo "   Available ubuntu-cuda assets in the recent releases:"
            printf '%s\n' "$disc" | tail -n +2 | sed 's/^/   /'
        else
            echo -e "   ${RED}Release lookup failed (network error or rate limit).${NC}"
            printf '%s\n' "$disc" | head -3 | sed 's/^/   /'
        fi
        echo -e "   ${YELLOW}Try --build-from-source, or re-run later.${NC}"
        return 1
    fi

    local TAG MAIN_URL CUDART_URL CV
    IFS='|' read -r TAG MAIN_URL CUDART_URL CV <<< "$disc"
    echo "   Release $TAG, CUDA $CV"

    WORK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/llama-cuda-setup.XXXXXX")
    trap 'rm -rf "${WORK_TMP:-}"' EXIT

    echo "   Downloading main tarball (~180 MB)..."
    run_checked "download main tarball" curl -fL --retry 3 -sS -o "$WORK_TMP/main.tar.gz" "$MAIN_URL" || return 1
    echo "   Downloading cudart runtime (~550 MB, the CUDA runtime libraries)..."
    run_checked "download cudart tarball" curl -fL --retry 3 -sS -o "$WORK_TMP/cudart.tar.gz" "$CUDART_URL" || return 1

    echo "   Extracting..."
    mkdir -p "$WORK_TMP/main" "$WORK_TMP/cudart"
    run_checked "extract main" tar xzf "$WORK_TMP/main.tar.gz" -C "$WORK_TMP/main" || return 1
    run_checked "extract cudart" tar xzf "$WORK_TMP/cudart.tar.gz" -C "$WORK_TMP/cudart" || return 1

    # Don't assume the tarball layout: find wherever llama-server landed
    local bin_found
    bin_found=$(find "$WORK_TMP/main" -type f -name "llama-server" | head -1)
    [[ -n "$bin_found" ]] || { echo -e "   ${RED}llama-server was not found inside the main tarball.${NC}"; return 1; }

    backup_cpu_build
    mkdir -p "$LLAMA_BIN_DIR"
    cp -a "$(dirname "$bin_found")/." "$LLAMA_BIN_DIR/"
    chmod +x "$LLAMA_BIN_DIR/llama-server"

    # The CUDA runtime libraries (libcudart.so.12, libcublas.so.12, ...) must sit
    # next to libggml-cuda.so, whose RUNPATH is $ORIGIN — i.e. the same directory
    # as llama-server. This holds for the current release layout (a flat dir);
    # copying every .so the cudart tarball ships works for nested layouts too.
    find "$WORK_TMP/cudart" -name '*.so*' -exec cp -a {} "$LLAMA_BIN_DIR/" \;
    echo "   CUDA runtime libraries placed in $LLAMA_BIN_DIR"

    STEP_DETAIL="release $TAG, CUDA $CV"
}

# --- 3b. build from source ---------------------------------------------------
step_build_llama_from_source() {
    if [[ ! -d "$LLAMA_DIR/.git" ]]; then
        if [[ -e "$LLAMA_DIR" ]] && [[ -n "$(ls -A "$LLAMA_DIR" 2>/dev/null)" ]]; then
            echo -e "   ${RED}$LLAMA_DIR exists but isn't a git clone (maybe from a prebuilt install). Remove or rename it, then re-run.${NC}"
            return 1
        fi
        run_checked "git clone" git clone https://github.com/ggml-org/llama.cpp "$LLAMA_DIR" || return 1
    else
        echo "   Already cloned — reusing $LLAMA_DIR"
    fi

    if test_llama_cuda "$LLAMA_BIN" && [[ $REINSTALL_LLAMA_CPP -eq 0 ]]; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="CUDA support already detected (use --reinstall-llama-cpp to rebuild)"
        return 0
    fi
    if running_project_llama; then
        echo -e "   ${RED}llama-server is running. Stop the app (Ctrl+C in start.sh) and re-run.${NC}"
        return 1
    fi

    backup_cpu_build

    # Stale CMake settings from an earlier (CPU) configure would otherwise be reused
    rm -rf "$LLAMA_DIR/build"

    local args=(-B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON)
    if [[ -n "$GPU_CAP" ]]; then
        # e.g. 7.5 -> 75. Building for just this GPU makes the build much faster.
        args+=(-DCMAKE_CUDA_ARCHITECTURES="${GPU_CAP/./}")
    fi

    (
        cd "$LLAMA_DIR" || exit 1
        run_checked "cmake configure" cmake "${args[@]}" || exit 1
        run_checked "cmake build" cmake --build build -j "$(nproc)" || exit 1
    )
    [[ -f "$LLAMA_BIN" ]] || { echo -e "   ${RED}Build finished but llama-server was not found at $LLAMA_BIN${NC}"; return 1; }
}

if [[ $BUILD_FROM_SOURCE -eq 1 ]]; then
    run_step "Clone and build llama.cpp with CUDA (this takes a while)" step_build_llama_from_source
else
    run_step "Install prebuilt llama.cpp CUDA build" step_install_prebuilt_llama
fi

# --- 3c. verify ----------------------------------------------------------------
step_verify_llama_cuda() {
    if [[ ! -f "$LLAMA_BIN" ]]; then
        echo -e "   ${RED}llama-server not found at $LLAMA_BIN${NC}"
        return 1
    fi
    chmod +x "$LLAMA_BIN" 2>/dev/null || true

    # Make sure the CUDA runtime libraries are discoverable by the dynamic
    # loader. The CUDA backend (libggml-cuda.so) is dlopen'd by llama-server,
    # so check it explicitly too — a plain ldd on llama-server looks clean
    # even when the CUDA libraries are missing.
    local target missing
    for target in "$LLAMA_BIN" "$LLAMA_BIN_DIR/libggml-cuda.so"; do
        [[ -f "$target" ]] || continue
        missing=$(ldd "$target" 2>/dev/null | awk '/not found/ {print $1}')
        if [[ -n "$missing" ]]; then
            if command -v patchelf >/dev/null 2>&1; then
                patchelf --set-rpath '$ORIGIN:$ORIGIN/../lib' "$target" && \
                    echo "   Fixed library path via patchelf for $(basename "$target") (was missing: $(echo $missing | tr '\n' ' '))"
            else
                echo -e "   ${YELLOW}ldd reports missing libraries for $(basename "$target"): $(echo $missing | tr '\n' ' ')
   patchelf is not installed, so I could not set an rpath. Install it
   (sudo apt install -y patchelf) and re-run, or ensure LD_LIBRARY_PATH
   includes $LLAMA_BIN_DIR when the app runs.${NC}"
            fi
        fi
    done

    local out
    out=$("$LLAMA_BIN" --list-devices 2>&1) || true
    if printf '%s' "$out" | grep -q 'CUDA'; then
        STEP_DETAIL="CUDA device listed"
    else
        # Not fatal: very old builds may not support --list-devices at all
        STEP_STATUS="WARNING"
        STEP_DETAIL="couldn't confirm CUDA. Load a model and look for a 'CUDA' device line in the llama-server startup output."
        echo -e "${GRAY}   Output was:${NC}"
        printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | head -8 | sed "s/^/${GRAY}   /"
    fi
}
run_step "Verify llama.cpp can see the GPU" step_verify_llama_cuda

# ---------------------------------------------------------------------------
# 4. Python backends: venv + requirements (+ NVIDIA libraries for faster-whisper)
# ---------------------------------------------------------------------------
section "Python backends"

ensure_uv_python() { # echoes an interpreter path for 3.10-3.12
    if [[ -n "$PYTHON_BIN" ]]; then echo "$PYTHON_BIN"; return; fi
    # uv path
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    uv python install 3.12 >/dev/null 2>&1 || true
    uv python find 3.12
}

fix_requirements_encoding() { # file -> re-encode UTF-16 to UTF-8 in place; echoes 1 if converted
    local f="$1"
    local bom
    bom=$(head -c 2 "$f" | od -An -tx1 | tr -d ' \n')
    if [[ "$bom" == "fffe" || "$bom" == "feff" ]]; then
        python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
data = open(p, "rb").read()
text = data.decode("utf-16")
open(p, "w", encoding="utf-8", newline="\n").write(text.replace("\r\n", "\n"))
PY
        echo 1
    else
        echo 0
    fi
}

step_setup_backend() { # name port
    local name="$1" port="$2"
    local dir="$ROOT/$name"
    local requirements="$dir/requirements.txt"
    local venv_dir="$dir/.venv"
    local venv_py="$venv_dir/bin/python"

    [[ -d "$dir" ]] || { echo -e "   ${RED}Folder not found: $dir${NC}"; return 1; }
    [[ -f "$requirements" ]] || { echo -e "   ${RED}requirements.txt not found in $dir${NC}"; return 1; }

    # requirements.txt may have been saved as UTF-16 by a Windows editor — pip can't read that
    if [[ "$(fix_requirements_encoding "$requirements")" == "1" ]]; then
        echo "   Re-encoded requirements.txt (UTF-16 -> UTF-8)"
    fi

    local py
    py=$(ensure_uv_python)
    [[ -n "$py" ]] || { echo -e "   ${RED}No usable Python 3.10-3.12 found (uv provisioning failed).${NC}"; return 1; }

    if [[ ! -x "$venv_py" ]]; then
        echo "   Creating venv with $( "$py" --version 2>&1 ) at $venv_dir"
        run_checked "venv creation" "$py" -m venv "$venv_dir" || return 1
    fi

    # setuptools/wheel first: some packages (e.g. webrtcvad) fail to build without them
    run_checked "pip upgrade" "$venv_py" -m pip install --upgrade pip setuptools wheel || return 1
    run_checked "pip install -r requirements.txt" "$venv_py" -m pip install -r "$requirements" || return 1
}

for entry in "${BACKENDS[@]}"; do
    b_name="${entry% *}"; b_port="${entry#* }"
    run_step "Set up $b_name (port $b_port)" step_setup_backend "$b_name" "$b_port"
done

# NVIDIA cuBLAS/cuDNN for the faster-whisper (STT) backend
step_stt_nvidia_libs() {
    local dir="$ROOT/stt-backend-faster-whisper"
    local venv_py="$dir/.venv/bin/python"
    [[ -x "$venv_py" ]] || { STEP_STATUS="SKIPPED"; STEP_DETAIL="STT venv not available"; return 0; }

    local pip_show
    pip_show=$("$venv_py" -m pip show faster-whisper 2>/dev/null)
    if ! printf '%s' "$pip_show" | grep -q '^Name: faster-whisper'; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="faster-whisper not installed in this venv"
        return 0
    fi

    # ctranslate2 4.5+ expects cuDNN 9 / CUDA 12
    local ct_ver
    ct_ver=$("$venv_py" -m pip show ctranslate2 2>/dev/null | sed -n 's/^Version: //p')
    if [[ "$ct_ver" =~ ^([0-9]+)\.([0-9]+) ]]; then
        if [[ ${BASH_REMATCH[1]} -lt 4 || ( ${BASH_REMATCH[1]} -eq 4 && ${BASH_REMATCH[2]} -lt 5 ) ]]; then
            echo -e "   ${YELLOW}Warning: ctranslate2 $ct_ver is older than 4.5, which expects different
cuDNN/CUDA versions. Consider: pip install --upgrade ctranslate2 faster-whisper${NC}"
        fi
    fi

    # The pinned requirements already include these; install explicitly as insurance
    run_checked "pip install NVIDIA libraries" "$venv_py" -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" || return 1

    # Confirm the libraries actually landed in this venv
    local site_packages nvidia_dir cublas cudnn
    site_packages=$("$venv_py" -c "import sysconfig; print(sysconfig.get_paths()['purelib'])")
    nvidia_dir="$site_packages/nvidia"
    cublas=$(find "$nvidia_dir" -name "libcublas.so.12" 2>/dev/null | head -1)
    cudnn=$(find "$nvidia_dir" -name "libcudnn.so.9" 2>/dev/null | head -1)
    if [[ -z "$cublas" || -z "$cudnn" ]]; then
        echo -e "   ${RED}pip finished but libcublas.so.12 / libcudnn.so.9 were not found under $nvidia_dir.${NC}"
        return 1
    fi

    # ctranslate2 sees the GPU through the driver. This doesn't prove cuBLAS/cuDNN load
    # correctly: that only happens when a model is loaded on the GPU.
    local count last_line
    count=$("$venv_py" -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())" 2>/dev/null)
    last_line=$(printf '%s' "$count" | tail -1 | xargs)
    if [[ "$last_line" =~ ^[0-9]+$ ]] && [[ "$last_line" -ge 1 ]]; then
        STEP_DETAIL="libraries installed, ctranslate2 sees $last_line CUDA device(s)"
    else
        STEP_STATUS="WARNING"
        STEP_DETAIL="libraries installed, but ctranslate2 reported no CUDA device"
    fi
}
run_step "Install NVIDIA libraries for stt-backend-faster-whisper" step_stt_nvidia_libs

# ---------------------------------------------------------------------------
# 5. Frontend
# ---------------------------------------------------------------------------
section "Frontend"

FRONTEND_READY=0
if [[ ! -d "$FRONTEND_DIR" ]]; then
    add_result "FAILED" "Frontend" "folder not found at $FRONTEND_DIR"
    echo -e "Folder not found: $FRONTEND_DIR" >&2
else
    step_frontend_install() {
        run_checked "npm install" npm --prefix "$FRONTEND_DIR" install || return 1
    }
    run_step "npm install (frontend)" step_frontend_install
    [[ "${RESULTS_STATUS[-1]}" == "OK" ]] && FRONTEND_READY=1
fi

# ---------------------------------------------------------------------------
# 6. Configuration: frontend .env.local + optional Hugging Face login
# ---------------------------------------------------------------------------
section "Configuration"

step_write_env_local() {
    local env_path="$FRONTEND_DIR/.env.local"
    local write=1
    if [[ -f "$env_path" ]]; then
        if [[ $NON_INTERACTIVE -eq 1 ]]; then
            write=0
        else
            write=0
            ask_yn ".env.local already exists. Overwrite?" && write=1
        fi
    fi
    if [[ $write -eq 0 ]]; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="kept existing file"
        return 0
    fi
    {
        echo "NEXT_PUBLIC_LLM_API_URL=$(read_default "URL for llm-studio-backend" "http://localhost:8000")"
        echo "NEXT_PUBLIC_STT_API_URL=$(read_default "URL for stt-backend-faster-whisper" "http://localhost:8001")"
    } > "$env_path"
    echo "   Wrote $env_path"
}
[[ -d "$FRONTEND_DIR" ]] && run_step "Write frontend/.env.local" step_write_env_local

step_hf_login() {
    local llm_py="$ROOT/llm-studio-backend/.venv/bin/python"
    if [[ $NON_INTERACTIVE -eq 1 ]]; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="non-interactive"
    elif [[ ! -x "$llm_py" ]]; then
        STEP_STATUS="SKIPPED"; STEP_DETAIL="LLM backend venv not available"
    else
        echo "   Only needed for gated models. Press Enter to skip."
        local token
        read -r -s -p "   Hugging Face token: " token; echo ""
        if [[ -z "$token" ]]; then
            STEP_STATUS="SKIPPED"; STEP_DETAIL="no token entered"
        else
            # Passed via an environment variable so it never appears on a command line
            HF_SETUP_TOKEN="$token" "$llm_py" -c \
                "import os; from huggingface_hub import login; login(token=os.environ['HF_SETUP_TOKEN'])" \
                || { echo -e "   ${RED}Hugging Face login failed.${NC}"; return 1; }
            STEP_DETAIL="logged in (token stored by huggingface_hub)"
        fi
    fi
}
run_step "Hugging Face login (optional)" step_hf_login

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
section "Summary"

for i in "${!RESULTS_STATUS[@]}"; do
    local_status="${RESULTS_STATUS[$i]}"
    color="$GRAY"
    case "$local_status" in
        OK)      color="$GREEN" ;;
        SKIPPED) color="$GRAY" ;;
        WARNING) color="$YELLOW" ;;
        *)       color="$RED" ;;
    esac
    detail=""
    [[ -n "${RESULTS_DETAIL[$i]}" ]] && detail="  (${RESULTS_DETAIL[$i]})"
    printf '  [%-7s] %s%s\n' "${color}${local_status}${NC}" "${RESULTS_STEP[$i]}" "$detail"
done

echo ""
echo -e "${GREEN}Next: run ./start.sh to launch everything from one terminal
(once it exists), or run each service yourself:${NC}"
for entry in "${BACKENDS[@]}"; do
    b_name="${entry% *}"; b_port="${entry#* }"
    [[ -d "$ROOT/$b_name/.venv" ]] || continue
    echo ""
    echo "  # $b_name"
    echo "  cd \"$ROOT/$b_name\""
    echo "  .venv/bin/python -m uvicorn main:app --reload --port $b_port"
done
if [[ $FRONTEND_READY -eq 1 ]]; then
    echo ""
    echo "  # frontend"
    echo "  cd \"$FRONTEND_DIR\""
    echo "  npm run dev"
    echo ""
    echo "  Then open http://localhost:3000"
fi

echo ""
echo -e "${CYAN}What this script can't do for you:${NC}"
echo -e "  - The app has to ask for the GPU. llama-server needs -ngl (layers on GPU)"
echo -e "    and faster-whisper needs device='cuda'.${GRAY}"
echo -e "  - VRAM is shared by every loaded model (you have ${GPU_VRAM_MB} MB). Watch it with"
echo -e "    nvidia-smi if you see out-of-memory errors.${GRAY}"
echo -e "  - Models are not included. Download them from the app's download panels on first use.${GRAY}"
if [[ -d "$BACKUP_DIR" ]]; then
    echo -e "  - To go back to the CPU build, copy the files from llama.cpp/cpu-build-backup"
    echo -e "    into llama.cpp/build/bin.${GRAY}"
fi

failed=0
for s in "${RESULTS_STATUS[@]}"; do [[ "$s" == "FAILED" ]] && failed=$((failed+1)); done
if [[ $failed -gt 0 ]]; then
    echo ""
    echo -e "${RED}$failed step(s) failed. Fix the cause and re-run; finished steps are skipped.${NC}"
    exit 1
fi
exit 0
