#!/usr/bin/env bash
#
# start.sh — starts the whole project (LLM backend, STT backend, frontend)
#            from one terminal. Bash port of start.ps1 (Linux/WSL).
#
# Run from anywhere. All service output goes to ./logs/ — this window only
# shows startup status, error lines, and a report if a service crashes.
# Press Ctrl+C to stop everything.
#
# Usage:
#   ./start.sh [--dev] [--quiet] [--open-browser]
#
#   --dev           Run the backends with uvicorn --reload. Off by default,
#                   because a reload restarts the process and silently
#                   unloads any model you had loaded.
#   --quiet         Don't echo error lines in this window (they are still
#                   written to the logs, and a crash is still reported).
#   --open-browser  Open the frontend in your default browser once
#                   everything is ready (needs xdg-open; on WSL that opens
#                   the Windows browser).
#
# To launch another service (e.g. a second STT backend), add one entry per
# array below, in the same position in every array.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"

# ---------------------------------------------------------------------------
# Services — add a line here to launch another one
# ---------------------------------------------------------------------------
SVC_NAMES=("llm" "stt" "web")
SVC_LABELS=("LLM backend" "STT backend" "Frontend")
SVC_KINDS=("python" "python" "npm")
SVC_DIRS=("llm-studio-backend" "stt-backend-faster-whisper" "frontend")
SVC_PORTS=(8000 8001 3000)
SVC_URLS=("http://localhost:8000/docs" "http://localhost:8001/docs" "http://localhost:3000")
SVC_TIMEOUTS=(180 180 240)

# Lines matching this are echoed to the terminal (case-sensitive on purpose,
# so ordinary words like "no errors" don't trigger it).
ERROR_PATTERN='ERROR|CRITICAL|Traceback|Exception|[A-Za-z_][A-Za-z0-9_]*Error:'

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
DEV=0; QUIET=0; OPEN_BROWSER=0
usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dev)          DEV=1 ;;
        -q|--quiet)        QUIET=1 ;;
        -b|--open-browser) OPEN_BROWSER=1 ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    esac
    shift
done

# Colors (respected if the caller already set NO_COLOR)
if [[ -n "${NO_COLOR:-}" ]]; then
    RED='' GREEN='' CYAN='' YELLOW='' DIM='' NC=''
else
    RED=$'\033[31m'; GREEN=$'\033[32m'; CYAN=$'\033[36m'
    YELLOW=$'\033[33m'; DIM=$'\033[2m'; NC=$'\033[0m'
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
declare -A LOGPOS
SVC_PIDS=()

# Print whatever was appended to a log file since the last call (position is
# remembered in LOGPOS), skipping the trailing partial line until it is done.
get_new_lines() {
    local file="$1"
    local pos="${LOGPOS[$file]:-0}"
    local size chunk endnl lines line partial
    [[ -f "$file" ]] || return 0
    size=$(stat -c %s "$file" 2>/dev/null) || return 0
    if (( size < pos )); then pos=0; fi          # file was truncated
    (( pos >= size )) && return 0
    chunk=$(tail -c +$((pos + 1)) "$file" 2>/dev/null)
    [[ -n "$chunk" ]] || return 0
    endnl=$(tail -c 1 "$file" | od -An -tx1 | tr -d ' \n')
    lines=()
    while IFS= read -r line; do lines+=("$line"); done <<<"$chunk"
    if [[ "$endnl" != "0a" ]] && (( ${#lines[@]} > 0 )); then
        lines=("${lines[@]:0:$(( ${#lines[@]} - 1 ))}")   # drop partial line
        partial="${chunk##*$'\n'}"
        pos=$(( size - ${#partial} ))
    fi
    LOGPOS[$file]=$pos
    (( ${#lines[@]} )) && printf '%s\n' "${lines[@]}"
}

# Echo matching error lines from a service's logs (max 5 per log per tick).
show_error_lines() {
    local i="$1"
    local name="${SVC_NAMES[$i]}"
    local f line shown
    local -a hits=()
    for f in "$LOG_DIR/$name.out.log" "$LOG_DIR/$name.err.log"; do
        hits=()
        while IFS= read -r line; do
            [[ "$line" =~ $ERROR_PATTERN ]] && hits+=("$line")
        done < <(get_new_lines "$f")
        (( ${#hits[@]} )) || continue
        shown=0
        for line in "${hits[@]}"; do
            if (( shown >= 5 )); then break; fi    # don't flood the window
            echo "${RED}[$name] $line${NC}"
            (( shown++ ))
        done
        if (( ${#hits[@]} > shown )); then
            echo "${RED}[$name] ... plus $(( ${#hits[@]} - shown )) more error lines, see the logs folder${NC}"
        fi
    done
}

show_log_tail() {
    local i="$1" f line
    for f in "$LOG_DIR/${SVC_NAMES[$i]}.out.log" "$LOG_DIR/${SVC_NAMES[$i]}.err.log"; do
        [[ -f "$f" ]] || continue
        local tail
        tail=$(tail -n 15 "$f" 2>/dev/null)
        [[ -n "$tail" ]] || continue
        echo "  ${DIM}--- last lines of $f ---${NC}"
        while IFS= read -r line; do echo "  ${DIM}$line${NC}"; done <<<"$tail"
    done
}

port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"
    else
        ( exec 3<>"/dev/tcp/127.0.0.1/${port}" ) 2>/dev/null
    fi
}

# Poll the service URL until it answers with status < 500, or the timeout
# expires, or the process dies.
wait_ready() {
    local i="$1"
    local url="${SVC_URLS[$i]}" timeout="${SVC_TIMEOUTS[$i]}" pid="${SVC_PIDS[$i]}"
    local deadline=$(( $(date +%s) + timeout )) code
    while (( $(date +%s) < deadline )); do
        kill -0 "$pid" 2>/dev/null || return 1
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
        [[ "$code" =~ ^[1-4][0-9][0-9]$ ]] && return 0
        sleep 0.7
    done
    return 1
}

# Each service was started with setsid, so its PID is its own process group —
# killing "-$pid" takes the whole tree (uvicorn --reload workers included).
STOPPED=0
stop_all() {
    (( STOPPED )) && return
    STOPPED=1
    if (( ${#SVC_PIDS[@]} > 0 )); then
        echo
        echo "${CYAN}Stopping services...${NC}"
    fi
    local pid
    for pid in "${SVC_PIDS[@]}"; do
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    done
    sleep 1
    for pid in "${SVC_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
        fi
    done
    # Safety net: make sure no llama-server from this project survives and
    # keeps holding VRAM (it is a child of the LLM backend, but if the
    # backend was killed -9 it may be orphaned).
    pkill -TERM -f 'llama\.cpp/build/bin/[l]lama-server' 2>/dev/null
}
trap 'echo; echo "^C"; stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
problems=()
command -v npm >/dev/null 2>&1  || problems+=("npm not found on PATH (install Node.js)")
command -v curl >/dev/null 2>&1 || problems+=("curl not found on PATH (needed for the readiness probe)")

for i in "${!SVC_NAMES[@]}"; do
    dir="$ROOT/${SVC_DIRS[$i]}"
    if [[ ! -d "$dir" ]]; then problems+=("Folder not found: $dir"); continue; fi
    if [[ "${SVC_KINDS[$i]}" == python && ! -x "$dir/.venv/bin/python" ]]; then
        problems+=("${SVC_LABELS[$i]}: no venv in ${SVC_DIRS[$i]}. Run setup_linux_gpu.sh (or setup_cpu.sh) first.")
    fi
    if [[ "${SVC_KINDS[$i]}" == npm && ! -d "$dir/node_modules" ]]; then
        problems+=("${SVC_LABELS[$i]}: node_modules missing. Run npm install in ${SVC_DIRS[$i]} first.")
    fi
    if port_in_use "${SVC_PORTS[$i]}"; then
        problems+=("Port ${SVC_PORTS[$i]} (${SVC_LABELS[$i]}) is already in use. A previous run may still be going: check for python, node or llama-server processes.")
    fi
done

if (( ${#problems[@]} > 0 )); then
    echo "${RED}Can't start:${NC}"
    for p in "${problems[@]}"; do echo "${RED}  - $p${NC}"; done
    exit 1
fi

mkdir -p "$LOG_DIR"

# Unbuffered Python output so log files update in real time; no colour codes in logs
export PYTHONUNBUFFERED=1
export NO_COLOR=1

# ---------------------------------------------------------------------------
# Start everything
# ---------------------------------------------------------------------------
EXIT_CODE=0
echo "${CYAN}Starting services (backends can take a minute to import their libraries)...${NC}"

for i in "${!SVC_NAMES[@]}"; do
    dir="$ROOT/${SVC_DIRS[$i]}"
    out_log="$LOG_DIR/${SVC_NAMES[$i]}.out.log"
    err_log="$LOG_DIR/${SVC_NAMES[$i]}.err.log"
    rm -f "$out_log" "$err_log"
    LOGPOS["$out_log"]=0
    LOGPOS["$err_log"]=0

    if [[ "${SVC_KINDS[$i]}" == python ]]; then
        # ${DEV:+...} would expand for DEV=0 too (set != true) — test explicitly
        reload=""
        [[ $DEV -eq 1 ]] && reload="--reload"
        ( cd "$dir" && exec setsid ./.venv/bin/python -m uvicorn main:app \
            --port "${SVC_PORTS[$i]}" $reload >"$out_log" 2>"$err_log" ) &
    else
        ( cd "$dir" && exec setsid npm run dev >"$out_log" 2>"$err_log" ) &
    fi
    SVC_PIDS+=($!)
done

for i in "${!SVC_NAMES[@]}"; do
    printf '  %-13s' "${SVC_LABELS[$i]}"
    if wait_ready "$i"; then
        echo " ${GREEN}ready${NC}"
    else
        echo " ${RED}FAILED${NC}"
        if ! kill -0 "${SVC_PIDS[$i]}" 2>/dev/null; then
            code=0; wait "${SVC_PIDS[$i]}" 2>/dev/null || code=$?
            echo "${RED}  It exited during startup (code $code).${NC}"
        else
            echo "${RED}  It didn't respond within ${SVC_TIMEOUTS[$i]}s.${NC}"
        fi
        show_log_tail "$i"
        EXIT_CODE=1
        break
    fi
done

if (( EXIT_CODE == 0 )); then
    echo
    echo "${GREEN}Everything is running:${NC}"
    echo "  App:      http://localhost:3000"
    echo "  LLM API:  http://localhost:8000/docs"
    echo "  STT API:  http://localhost:8001/docs"
    echo "  Logs:     $LOG_DIR"
    echo
    echo "${YELLOW}Press Ctrl+C to stop everything.${NC}"
    if (( OPEN_BROWSER )) && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://localhost:3000" >/dev/null 2>&1 &
    fi

    # Monitor: echo error lines, and stop everything if any service dies
    crashed=0
    while (( crashed == 0 )); do
        for i in "${!SVC_NAMES[@]}"; do
            pid="${SVC_PIDS[$i]}"
            if ! kill -0 "$pid" 2>/dev/null; then
                echo
                code=0; wait "$pid" 2>/dev/null || code=$?
                echo "${RED}${SVC_LABELS[$i]} stopped unexpectedly (exit code $code).${NC}"
                show_log_tail "$i"
                crashed=1
                EXIT_CODE=1
                break
            fi
            (( QUIET )) || show_error_lines "$i"
        done
        (( crashed )) || sleep 1
    done
fi

stop_all
exit "$EXIT_CODE"
