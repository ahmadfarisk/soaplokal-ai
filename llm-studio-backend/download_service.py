"""
download_service.py

Wraps huggingface_hub downloads, keeping models_registry.py in sync
with progress/success/failure. Designed to run as a background task —
errors are caught and written into the registry rather than raised,
since there's no open HTTP request left to return them to by the time
a download finishes or fails.

Now supports two engines:
  - "llama_cpp": downloads a single GGUF file (hf_hub_download)
  - "openvino":  downloads a whole pre-converted OpenVINO IR repo (snapshot_download)

Both share the same retry/error-handling logic via _download_with_retries —
only the actual "how do I fetch the files" part differs between them.
"""

import logging
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download
from huggingface_hub.utils import (
    EntryNotFoundError,
    GatedRepoError,
    HfHubHTTPError,
    RepositoryNotFoundError,
)
from requests.exceptions import ConnectionError as RequestsConnectionError
from requests.exceptions import Timeout as RequestsTimeout

import models_registry

logger = logging.getLogger(__name__)

MODELS_DIR = Path(__file__).parent / "models"
MAX_RETRIES = 3

# How it works:
# 1. Checks if model already exists, if yes then returns
# 2. Add the model's data into the db with the status "downloading"
# 3. Depending on "engine", either pull one GGUF file (llama_cpp) or a whole
#    pre-converted OpenVINO IR repo (openvino)
# 4. If there is an error with hugging face, update the model status to be "error"
# 5. If the error is an internet thing or an OS thing or an unknown error then it
#    will try again for MAX_RETRIES times
# Simple no? It looks long because of the error checking, and now because two
# engines share the same retry scaffolding. Still feels a little excessive, but
# this is the part of the project where "excessive" earns its keep.


def download(
    model_id: str,
    engine: str,
    force: bool = False,
    *,
    repo_id: str | None = None,
    filename: str | None = None,
    hf_model_id: str | None = None,
) -> None:
    """
    Entry point — branches by engine, then delegates to _download_with_retries
    with the right "how to fetch" function for that engine.

    llama_cpp expects repo_id + filename.
    openvino expects hf_model_id.
    """
    existing = models_registry.get_model(model_id)
    if existing and existing["status"] == "ready" and not force:
        logger.info(f"[{model_id}] Already downloaded at {existing['local_path']}, skipping.")
        return

    if engine == "llama_cpp":
        if not repo_id or not filename:
            _fail(model_id, "llama_cpp downloads require both repo_id and filename.")
            return

        models_registry.add_model(model_id, engine=engine, repo_id=repo_id, filename=filename)

        existing_path = _existing_gguf_path(filename)
        if existing_path is not None:
            logger.info(f"[{model_id}] Found existing file at {existing_path}, skipping download.")
            models_registry.update_status(
                model_id, status="ready", local_path=str(existing_path), size_bytes=existing_path.stat().st_size
            )
            return

        _download_with_retries(model_id, lambda: _fetch_gguf(model_id, repo_id, filename))

    elif engine == "openvino":
        if not hf_model_id:
            _fail(model_id, "openvino downloads require hf_model_id.")
            return

        models_registry.add_model(model_id, engine=engine, hf_model_id=hf_model_id)

        existing_path = _existing_openvino_path(model_id)
        if existing_path is not None:
            logger.info(f"[{model_id}] Found existing folder at {existing_path}, skipping download.")
            models_registry.update_status(
                model_id, status="ready", local_path=str(existing_path), size_bytes=_folder_size(existing_path)
            )
            return

        _download_with_retries(model_id, lambda: _fetch_openvino(model_id, hf_model_id))

    else:
        _fail(model_id, f"Unknown engine: '{engine}'. Expected 'llama_cpp' or 'openvino'.")


# ---------------------------------------------------------------------------
# Existence checks — if the files are already sitting in models/ (downloaded
# manually, or left over from a registry that got wiped/reset), skip hitting
# the network entirely and just register what's already there.
# ---------------------------------------------------------------------------

def _existing_gguf_path(filename: str) -> Path | None:
    """llama_cpp engine: the GGUF file lives directly at models/<filename>."""
    path = MODELS_DIR / filename
    return path if path.is_file() else None


def _existing_openvino_path(model_id: str) -> Path | None:
    """openvino engine: the model lives in a folder at models/<model_id>, containing IR files."""
    path = MODELS_DIR / model_id
    if path.is_dir() and any(path.glob("*.xml")):
        return path
    return None


def _folder_size(path: Path) -> int:
    """Sums every file's size under a folder — openvino downloads are folders, not single files."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


# ---------------------------------------------------------------------------
# Per-engine fetch functions — each returns (local_path, size_bytes) on success,
# and lets exceptions bubble up to _download_with_retries to classify.
# ---------------------------------------------------------------------------

def _fetch_gguf(model_id: str, repo_id: str, filename: str) -> tuple[str, int]:
    """llama_cpp engine: pull a single GGUF file."""
    local_path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=str(MODELS_DIR),
        # huggingface_hub resumes partial files automatically on retry
    )
    size_bytes = Path(local_path).stat().st_size
    return local_path, size_bytes


def _fetch_openvino(model_id: str, hf_model_id: str) -> tuple[str, int]:
    """openvino engine: pull the whole pre-converted OpenVINO IR repo."""
    local_dir = MODELS_DIR / model_id
    local_path = snapshot_download(
        repo_id=hf_model_id,
        local_dir=str(local_dir),
        # snapshot_download resumes partially-downloaded files automatically
    )
    size_bytes = _folder_size(Path(local_path))
    return local_path, size_bytes


# ---------------------------------------------------------------------------
# Shared retry/error-handling loop — identical logic regardless of engine,
# just calls whichever fetch_fn was passed in.
# ---------------------------------------------------------------------------

def _download_with_retries(model_id: str, fetch_fn) -> None:
    """
    Calls fetch_fn() up to MAX_RETRIES times, classifying errors the same way
    for both engines. fetch_fn takes no args (engine-specific values are
    already bound via closure in download()) and returns (local_path, size_bytes).
    Never raises — always leaves the registry in 'ready' or 'error' state.
    """
    last_error: Exception | None = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"[{model_id}] Download attempt {attempt}/{MAX_RETRIES}")

            local_path, size_bytes = fetch_fn()

            models_registry.update_status(
                model_id,
                status="ready",
                local_path=local_path,
                size_bytes=size_bytes,
            )
            logger.info(f"[{model_id}] Download complete: {local_path} ({size_bytes} bytes)")
            return  # success, stop here

        # --- Non-retryable errors: fail fast, no point retrying ---
        except RepositoryNotFoundError:
            _fail(model_id, "Repo not found. Check the repo_id / hf_model_id is correct and spelled right.")
            return

        except EntryNotFoundError:
            _fail(model_id, "File not found in repo. Check the exact filename on Hugging Face.")
            return

        except GatedRepoError:
            _fail(
                model_id,
                "This is a gated model. Accept its license on huggingface.co and "
                "make sure a valid HF_TOKEN is set.",
            )
            return

        except HfHubHTTPError as e:
            if getattr(e.response, "status_code", None) == 401:
                _fail(model_id, "Hugging Face authentication failed. Check your HF_TOKEN.")
                return
            # Other HTTP errors (5xx, rate limits) — worth retrying
            last_error = e
            logger.warning(f"[{model_id}] HTTP error on attempt {attempt}: {e}")

        # --- Retryable errors: transient network issues ---
        except (RequestsConnectionError, RequestsTimeout) as e:
            last_error = e
            logger.warning(f"[{model_id}] Network error on attempt {attempt}: {e}")

        except OSError as e:
            # Covers disk-full and permission errors — retrying won't help disk-full,
            # but we still want a clear message rather than a raw traceback.
            _fail(model_id, f"Disk/filesystem error while saving files: {e}")
            return

        except Exception as e:
            # Unexpected error type — don't retry blindly, surface it clearly instead.
            _fail(model_id, f"Unexpected error: {e}")
            return

    # If we exhausted all retries on a retryable error:
    _fail(model_id, f"Download failed after {MAX_RETRIES} attempts: {last_error}")


def _fail(model_id: str, message: str) -> None:
    """Marks a model as errored in the registry and logs it."""
    logger.error(f"[{model_id}] {message}")
    models_registry.update_status(model_id, status="error", error_message=message)


# Test

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    models_registry.init_db()

    # # Should fail cleanly with a clear error, not a crash
    # download("bad-model", "llama_cpp", repo_id="this-repo/does-not-exist", filename="nope.gguf")
    # print(models_registry.get_model("bad-model"))

    # llama_cpp engine — should succeed
    download("qwen3-0.6b-q8_0", "llama_cpp", repo_id="drmcbride/Qwen3-0.6B-Q8_0-GGUF", filename="qwen3-0.6b-q8_0.gguf")
    print(models_registry.get_model("qwen3-0.6b-q8_0"))

    # openvino engine — should succeed
    download("qwen2.5-1.5b-ov-8bit", "openvino", hf_model_id="hsuwill000/Qwen2.5-1.5B-Instruct-openvino-8bit")
    print(models_registry.get_model("qwen2.5-1.5b-ov-8bit"))