"""
inference_service.py

Manages model inference across two engines:
  - "llama_cpp": spawns llama-server as a subprocess (load = spawn + health-check,
     unload = terminate, chat = HTTP proxy to its port)
  - "openvino":  loads the model directly into this process via optimum-intel
     (load = OVModelForCausalLM.from_pretrained, unload = drop the reference,
     chat = tokenizer.apply_chat_template + model.generate)

Separate from download/storage concerns (see download_service.py / models_registry.py).
Both engines are tracked in one unified _loaded_models dict, keyed by model_id,
with an "engine" field on each entry so load/unload/chat know which path to take.
"""

import logging
import subprocess
import time
from pathlib import Path
from typing import Optional

import requests

import models_registry

logger = logging.getLogger(__name__)

# --- Configuration ---------------------------------------------------------

LLAMA_SERVER_PATH = Path(__file__).parent.parent / "llama.cpp" / "build" / "bin" / "Release" / "llama-server.exe"

PORT_RANGE_START = 8100
HEALTH_CHECK_TIMEOUT_SECONDS = 60
HEALTH_CHECK_INTERVAL_SECONDS = 1

DEFAULT_OV_DEVICE = "CPU"

DEFAULT_MAX_TOKENS = 1024
DEFAULT_TEMPERATURE = 0.8
DEFAULT_REPETITION_PENALTY = 1.15
DEFAULT_TOP_P = 0.9
DEFAULT_TOP_K = 40


THREAD = 6

# --- In-memory state ---------------------------------------------------------
# One dict for both engines. Shape depends on entry["engine"]:
#   llama_cpp -> {"engine": "llama_cpp", "process": Popen, "port": int}
#   openvino  -> {"engine": "openvino", "model": OVModelForCausalLM, "tokenizer": AutoTokenizer}
# Kept in memory only — does NOT need to survive a backend restart, since a
# restart means any spawned llama-server processes should be killed anyway,
# and any in-process OpenVINO models are gone along with the process itself.
_loaded_models: dict[str, dict] = {}


class InferenceError(Exception):
    """Raised for load/unload/chat failures the caller needs to handle explicitly."""


# ---------------------------------------------------------------------------
# Load / unload — public API, branches by engine internally
# ---------------------------------------------------------------------------

def load_model(model_id: str, device: str = DEFAULT_OV_DEVICE) -> dict:
    """
    Loads a model using whichever engine it's registered under.
    `device` only applies to the openvino engine (e.g. "CPU", "GPU", "AUTO");
    ignored for llama_cpp.

    Raises InferenceError if the model isn't downloaded, its engine is
    unrecognized, or it fails to load/become healthy.
    """
    if model_id in _loaded_models:
        logger.info(f"[{model_id}] Already loaded.")
        return _loaded_models[model_id]

    model = models_registry.get_model(model_id)
    if model is None:
        raise InferenceError(f"Model '{model_id}' not found in registry.")
    if model["status"] != "ready":
        raise InferenceError(f"Model '{model_id}' is not downloaded yet (status: {model['status']}).")

    local_path = model["local_path"]
    if not local_path or not Path(local_path).exists():
        raise InferenceError(f"Model file/folder missing on disk: {local_path}")

    engine = model["engine"]
    if engine == "llama_cpp":
        entry = _load_llama_cpp(model_id, local_path)
    elif engine == "openvino":
        entry = _load_openvino(model_id, local_path, device)
    else:
        raise InferenceError(f"Unknown engine '{engine}' for model '{model_id}'.")

    _loaded_models[model_id] = entry
    logger.info(f"[{model_id}] Ready ({engine}).")
    return entry


def unload_model(model_id: str) -> None:
    """Releases a loaded model's resources — terminates the process (llama_cpp) or drops the reference (openvino)."""
    entry = _loaded_models.get(model_id)
    if entry is None:
        logger.info(f"[{model_id}] Not currently loaded, nothing to unload.")
        return

    if entry["engine"] == "llama_cpp":
        _unload_llama_cpp(model_id, entry)
    elif entry["engine"] == "openvino":
        _unload_openvino(model_id, entry)

    del _loaded_models[model_id]
    logger.info(f"[{model_id}] Unloaded.")


def unload_all() -> None:
    """Call this on backend shutdown so no orphaned llama-server processes (or lingering OV models) are left running."""
    for model_id in list(_loaded_models.keys()):
        unload_model(model_id)


def get_loaded_models() -> dict:
    """Returns {model_id: {"engine": ..., "port": port or None}} for everything currently loaded."""
    return {
        model_id: {"engine": entry["engine"], "port": entry.get("port")}
        for model_id, entry in _loaded_models.items()
    }


# ---------------------------------------------------------------------------
# llama_cpp engine — subprocess + HTTP, same mechanics as before
# ---------------------------------------------------------------------------

def _load_llama_cpp(model_id: str, local_path: str) -> dict:
    if not LLAMA_SERVER_PATH.exists():
        raise InferenceError(f"llama-server.exe not found at {LLAMA_SERVER_PATH}. Check the path.")

    port = _find_free_port()
    logger.info(f"[{model_id}] Spawning llama-server on port {port} for {local_path}")

    try:
        # Equivalent to running on the command line:
        # ./build/bin/Release/llama-server -m <local_path> --port <port>
        process = subprocess.Popen(
            [str(LLAMA_SERVER_PATH), "-m", local_path, "-t",str(THREAD),"--port", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as e:
        raise InferenceError(f"Failed to start llama-server process: {e}")

    if not _wait_for_healthy(port):
        process.terminate()
        raise InferenceError(
            f"Model '{model_id}' did not become healthy within {HEALTH_CHECK_TIMEOUT_SECONDS}s. "
            f"Check that the .gguf file isn't corrupted and there's enough RAM to load it."
        )

    return {"engine": "llama_cpp", "process": process, "port": port}


def _unload_llama_cpp(model_id: str, entry: dict) -> None:
    process: subprocess.Popen = entry["process"]
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        logger.warning(f"[{model_id}] Did not terminate gracefully, killing.")
        process.kill()


def _chat_llama_cpp(entry: dict, message: str, history: list[dict] | None, params: dict, timeout: int) -> dict:
    messages = (history or []) + [{"role": "user", "content": message}]
    start_time = time.perf_counter()
    try:
        response = requests.post(
            f"http://localhost:{entry['port']}/v1/chat/completions",
            json={
                "messages": messages,
                "temperature": params["temperature"],
                "top_p": params["top_p"],
                "top_k": params["top_k"],
                "repeat_penalty": params["repetition_penalty"],
                "max_tokens": params["max_tokens"],
            },
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.exceptions.ConnectionError:
        raise InferenceError(
            f"Could not reach llama-server on port {entry['port']}. It may have crashed — try unloading and reloading."
        )
    except requests.exceptions.Timeout:
        raise InferenceError(f"Request timed out after {timeout}s.")
    except requests.exceptions.HTTPError as e:
        raise InferenceError(f"llama-server returned an error: {e}")
    
    elapsed = time.perf_counter() - start_time

    data = response.json()  # already in the {"choices": [{"message": {"content": ...}}]} shape
    usage = data.get("usage", {})
    data["metrics"] = _llm_metrics(elapsed, usage.get("prompt_tokens"), usage.get("completion_tokens"))

    # llama-server optionally reports its own prompt-processing vs generation
    # split — free extra detail OpenVINO's response has no equivalent for.
    timings = data.get("timings")
    if timings:
        data["metrics"]["prompt_seconds"] = round(timings.get("prompt_ms", 0) / 1000, 3)
        data["metrics"]["generation_seconds"] = round(timings.get("predicted_ms", 0) / 1000, 3)
        data["metrics"]["generation_tokens_per_second"] = round(timings.get("predicted_per_second", 0), 2)

    return data


# ---------------------------------------------------------------------------
# openvino engine — loaded in-process via optimum-intel, no subprocess/port
# ---------------------------------------------------------------------------

def _load_openvino(model_id: str, local_path: str, device: str) -> dict:
    # Imported lazily so the llama_cpp-only path doesn't require optimum[openvino]
    # to be installed if you're not using any OpenVINO models.
    logger.info(f"[{model_id}] Preparing to load OpenVINO model.")
    try:
        from optimum.intel import OVModelForCausalLM
        from transformers import AutoTokenizer
    except ImportError as e:
        raise InferenceError(
            "optimum[openvino] is not installed. Run: pip install \"optimum[openvino]\""
        ) from e

    logger.info(f"[{model_id}] Loading OpenVINO model from {local_path} (device={device})")
    try:
        model = OVModelForCausalLM.from_pretrained(local_path, device=device)
        tokenizer = AutoTokenizer.from_pretrained(local_path)
    except Exception as e:
        raise InferenceError(f"Failed to load OpenVINO model: {e}")

    return {"engine": "openvino", "model": model, "tokenizer": tokenizer, "port": "NONE"}


def _unload_openvino(model_id: str, entry: dict) -> None:
    # Nothing to terminate — just let Python garbage-collect the model/tokenizer
    # once _loaded_models no longer holds a reference to them.
    pass


def _chat_openvino(entry: dict, message: str, history: list[dict] | None, params: dict) -> dict:
    model = entry["model"]
    tokenizer = entry["tokenizer"]
    messages = (history or []) + [{"role": "user", "content": message}]

    try:
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt, return_tensors="pt")

        generate_kwargs = {
            "max_new_tokens": params["max_tokens"],
            "repetition_penalty": params["repetition_penalty"],
        }
        # temperature 0 means "be deterministic" -> greedy decoding instead of sampling
        if params["temperature"] > 0:
            generate_kwargs.update(
                do_sample=True,
                temperature=params["temperature"],
                top_p=params["top_p"],
                top_k=params["top_k"],
            )
        else:
            generate_kwargs["do_sample"] = False
        
        start_time = time.perf_counter()
        outputs = model.generate(**inputs, **generate_kwargs)
        elapsed = time.perf_counter() - start_time

        prompt_tokens = int(inputs.input_ids.shape[1])
        completion_tokens = int(outputs.shape[1] - prompt_tokens)
        text = tokenizer.decode(outputs[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)

    except Exception as e:
        raise InferenceError(f"OpenVINO generation failed: {e}")

    # Normalized to match llama_cpp's response shape, so main.py and the
    # frontend never need to know which engine actually answered. No
    # prompt/generation split here (unlike llama_cpp's optional "timings") —
    # HF's generate() doesn't report that breakdown without switching to a
    # streaming generation call, which this doesn't currently do.
    return {
        "choices": [{"message": {"content": text}}],
        "metrics": _llm_metrics(elapsed, prompt_tokens, completion_tokens),
    }


# ---------------------------------------------------------------------------
# Unified chat — branches by engine, returns the same shape either way
# ---------------------------------------------------------------------------

def chat(
    model_id: str,
    message: str,
    history: Optional[list[dict]] = None,
    temperature: float = DEFAULT_TEMPERATURE,
    top_p: float = DEFAULT_TOP_P,
    top_k: int = DEFAULT_TOP_K,
    repetition_penalty: float = DEFAULT_REPETITION_PENALTY,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    timeout: int = 300,
) -> dict:
    """
    Sends a chat message to whichever engine the loaded model uses. All sampling
    parameters are per-request, so they can be changed freely without reloading
    the model. `timeout` only applies to llama_cpp (the HTTP call).
    Raises InferenceError if the model isn't currently loaded or the request fails.
    Always returns {"choices": [{"message": {"content": "..."}}]} regardless of engine.
    """

    logger.info(f"Param: temperature = {temperature}")
    logger.info(f"Param: top_p = {top_p}")
    logger.info(f"Param: top_k = {top_k}")
    logger.info(f"Param: repetition_penalty = {repetition_penalty}")
    logger.info(f"Param: max_tokens = {max_tokens}")

    entry = _loaded_models.get(model_id)
    if entry is None:
        raise InferenceError(f"Model '{model_id}' is not loaded. Call load_model() first.")

    params = {
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
        "repetition_penalty": repetition_penalty,
        "max_tokens": max_tokens,
    }

    if entry["engine"] == "llama_cpp":
        return _chat_llama_cpp(entry, message, history, params, timeout)
    elif entry["engine"] == "openvino":
        return _chat_openvino(entry, message, history, params)
    else:
        raise InferenceError(f"Unknown engine '{entry['engine']}' for model '{model_id}'.")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _llm_metrics(elapsed: float, prompt_tokens: int | None, completion_tokens: int | None) -> dict:
    """
    Same definition for both engines, so the frontend never needs to branch
    on which one answered. tokens_per_second is completion tokens over the
    TOTAL elapsed time (including prompt processing) — for a long transcript
    that's the number you actually experience waiting, not just raw decode speed.
    """
    tps = completion_tokens / elapsed if completion_tokens and elapsed > 0 else None
    return {
        "total_seconds": round(elapsed, 3),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tokens_per_second": round(tps, 2) if tps else None,
    }


def _find_free_port() -> int:
    """Returns the next port not currently assigned to a loaded llama_cpp model."""
    used_ports = {entry["port"] for entry in _loaded_models.values() if entry["engine"] == "llama_cpp"}
    port = PORT_RANGE_START
    while port in used_ports:
        port += 1
    return port


def _wait_for_healthy(port: int) -> bool:
    """Polls llama-server's /health endpoint until it responds or times out."""
    deadline = time.time() + HEALTH_CHECK_TIMEOUT_SECONDS
    while time.time() < deadline:
        try:
            r = requests.get(f"http://localhost:{port}/health", timeout=2)
            if r.status_code == 200:
                return True
        except requests.exceptions.RequestException:
            pass  # server not up yet, keep polling
        time.sleep(HEALTH_CHECK_INTERVAL_SECONDS)
    return False


# ---------------------------------------------------------------------------
# Manual test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    models_registry.init_db()

    # --- llama_cpp engine ---
    LLAMA_MODEL_ID = "qwen2.5-1.5b-q4"
    try:
        load_model(LLAMA_MODEL_ID)
        result = chat(LLAMA_MODEL_ID, "Say hi in one sentence.")
        print("[llama_cpp]", result["choices"][0]["message"]["content"])
    except InferenceError as e:
        print(f"[llama_cpp] Error: {e}")
    finally:
        unload_model(LLAMA_MODEL_ID)

    # --- openvino engine ---
    OV_MODEL_ID = "qwen2.5-1.5b-ov-8bit"
    try:
        load_model(OV_MODEL_ID, device="AUTO")
        result = chat(OV_MODEL_ID, "Say hi in one sentence.")
        print("[openvino]", result["choices"][0]["message"]["content"])
    except InferenceError as e:
        print(f"[openvino] Error: {e}")
    finally:
        unload_model(OV_MODEL_ID)