"""
inference_service.py

Manages llama-server subprocesses: loading (spawn + health-check),
unloading (terminate), and proxying chat requests to whichever
model is currently loaded. Separate from download/storage concerns.
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
# Path(
#     r"C:/Users/Administrator/Desktop/Faris/Projects/Web Development/WebApp1/local-ai-00112/llama.cpp/build/bin/Release/llama-server.exe"
# )

PORT_RANGE_START = 8100
HEALTH_CHECK_TIMEOUT_SECONDS = 60
HEALTH_CHECK_INTERVAL_SECONDS = 1

# --- In-memory state ---------------------------------------------------------
# { model_id: {"process": Popen, "port": int} }
_loaded_models: dict[str, dict] = {}


class InferenceError(Exception):
    """Raised for load/unload/chat failures the caller needs to handle explicitly."""


# Note: State (which models are loaded, on which ports) is kept in memory only,
# it does NOT need to survive a backend restart, since a restart means all spawned llama-server processes should be killed anyway.



# ---------------------------------------------------------------------------
# Load / unload
# ---------------------------------------------------------------------------

def load_model(model_id: str) -> dict:
    """
    Spawns llama-server for the given model_id and waits until it's healthy.
    Raises InferenceError if the model isn't downloaded, already loaded
    elsewhere, or fails to become healthy in time.
    """
    # Check if model already loaded
    if model_id in _loaded_models:
        logger.info(f"[{model_id}] Already loaded on port {_loaded_models[model_id]['port']}.")
        return _loaded_models[model_id]

    # Check about the model in model registry, and raises an error if it's not perfectly ready
    model = models_registry.get_model(model_id)
    if model is None:
        raise InferenceError(f"Model '{model_id}' not found in registry.")
    if model["status"] != "ready":
        raise InferenceError(f"Model '{model_id}' is not downloaded yet (status: {model['status']}).")
    
    # Check if path llama-server.exe path is correct
    if not LLAMA_SERVER_PATH.exists():
        raise InferenceError(f"llama-server.exe not found at {LLAMA_SERVER_PATH}. Check the path.")

    # Check if the path from inside the registry actually points to an existing model file
    local_path = model["local_path"]
    if not local_path or not Path(local_path).exists():
        raise InferenceError(f"Model file missing on disk: {local_path}")

    # Find a free port to start the llama-server
    port = _find_free_port()

    logger.info(f"[{model_id}] Spawning llama-server on port {port} for {local_path}")
    try:
        # subprocess is like the cmd thing. This process is similar to writing the following command on cmd:
        # ./build/bin/Release/llama-server -m ./my_models/Qwen3-0.6B-Q8_0.gguf --port 8001
        process = subprocess.Popen(
            [
                str(LLAMA_SERVER_PATH), # cmd command to start server
                "-m", local_path, # set model
                "--port", str(port), # set the port
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as e:
        raise InferenceError(f"Failed to start llama-server process: {e}")

    # Check for server health for a set amount of time, and raise an error if it fails
    if not _wait_for_healthy(port):
        process.terminate()
        raise InferenceError(
            f"Model '{model_id}' did not become healthy within {HEALTH_CHECK_TIMEOUT_SECONDS}s. "
            f"Check that the .gguf file isn't corrupted and there's enough RAM to load it."
        )

    # Insert the "process" that we run and its port into the loaded model list
    _loaded_models[model_id] = {"process": process, "port": port}
    logger.info(f"[{model_id}] Ready on port {port}.")
    return _loaded_models[model_id]


def unload_model(model_id: str) -> None:
    """Terminates the process for a loaded model and frees its port."""
    entry = _loaded_models.get(model_id)
    # Check if the model to unload is actually loaded
    if entry is None:
        logger.info(f"[{model_id}] Not currently loaded, nothing to unload.")
        return

    process: subprocess.Popen = entry["process"] # Select the "process" to end
    process.terminate()
    # Kill if not terminated normally
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        logger.warning(f"[{model_id}] Did not terminate gracefully, killing.")
        process.kill()

    # Remove from loaded model list
    del _loaded_models[model_id]
    logger.info(f"[{model_id}] Unloaded.")


def unload_all() -> None:
    """Call this on backend shutdown so no orphaned llama-server processes are left running."""
    for model_id in list(_loaded_models.keys()):
        unload_model(model_id)


def get_loaded_models() -> dict:
    """Returns {model_id: port} for everything currently loaded."""
    return {model_id: entry["port"] for model_id, entry in _loaded_models.items()}


# ---------------------------------------------------------------------------
# Chat proxy
# ---------------------------------------------------------------------------

def chat(model_id: str, message: str, history: Optional[list[dict]] = None, temperature=0.8) -> dict:
    """
    Forwards a chat request to the given model's running llama-server instance.
    Raises InferenceError if the model isn't currently loaded or the request fails.
    """
    # (Try to) Select the model "process"
    entry = _loaded_models.get(model_id)
    if entry is None:
        raise InferenceError(f"Model '{model_id}' is not loaded. Call load_model() first.")

    # Format the message
    messages = (history or []) + [{"role": "user", "content": message}]

    # Send the message to the LLM
    try:
        response = requests.post(
            f"http://localhost:{entry['port']}/v1/chat/completions",
            json = {
                "messages": messages,
                "temperature": temperature,
                },
            timeout=120,
        )
        response.raise_for_status()
    # Error checks
    except requests.exceptions.ConnectionError:
        raise InferenceError(
            f"Could not reach llama-server for '{model_id}' on port {entry['port']}. "
            f"It may have crashed — try unloading and reloading."
        )
    except requests.exceptions.Timeout:
        raise InferenceError(f"Request to '{model_id}' timed out after 120s.")
    except requests.exceptions.HTTPError as e:
        raise InferenceError(f"llama-server returned an error: {e}")

    return response.json()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _find_free_port() -> int:
    """Returns the next port not currently assigned to a loaded model."""
    used_ports = {entry["port"] for entry in _loaded_models.values()}
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

    MODEL_ID = "qwen2.5-1.5b-q4"

    try:
        load_model(MODEL_ID)
        result = chat(MODEL_ID, "Say hi in one sentence.")
        print(result["choices"][0]["message"]["content"])
    except InferenceError as e:
        print(f"Error: {e}")
    finally:
        unload_model(MODEL_ID)