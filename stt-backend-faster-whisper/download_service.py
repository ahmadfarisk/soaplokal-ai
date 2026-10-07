"""
download_service.py (STT service)

Downloads a pre-converted OpenVINO Whisper repo (e.g. "Systran/faster-whisper-*")
from Hugging Face as a whole snapshot.

Runs as a background task — never raises, always leaves the registry in
either 'ready' or 'error' state.
"""

import logging
from pathlib import Path

from huggingface_hub import snapshot_download
from huggingface_hub.utils import (
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


def download(model_id: str, hf_model_id: str, force: bool = False) -> None:
    """
    Downloads a full pre-converted model repo and updates the
    registry as it goes. Safe to call from a FastAPI BackgroundTask.
    """
    existing = models_registry.get_model(model_id)
    if existing and existing["status"] == "ready" and not force:
        logger.info(f"[{model_id}] Already downloaded at {existing['local_path']}, skipping.")
        return

    models_registry.add_model(model_id, hf_model_id)

    local_dir = MODELS_DIR / model_id
    last_error: Exception | None = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"[{model_id}] Download attempt {attempt}/{MAX_RETRIES} — {hf_model_id}")

            # Start downloading
            downloaded_path = snapshot_download(
                repo_id=hf_model_id,
                local_dir=str(local_dir),
            )

            size_bytes = _folder_size(Path(downloaded_path))

            models_registry.update_status(
                model_id,
                status="ready",
                local_path=downloaded_path,
                size_bytes=size_bytes,
            )
            logger.info(f"[{model_id}] Download complete: {downloaded_path} ({size_bytes} bytes)")
            return  

        # --- Non-retryable errors: fail fast ---
        except RepositoryNotFoundError:
            _fail(model_id, f"Repo '{hf_model_id}' not found. Check the model id is correct.")
            return

        except GatedRepoError:
            _fail(
                model_id,
                f"'{hf_model_id}' is a gated model. Accept its license on huggingface.co and "
                f"make sure a valid HF_TOKEN is set.",
            )
            return

        except HfHubHTTPError as e:
            if getattr(e.response, "status_code", None) == 401:
                _fail(model_id, "Hugging Face authentication failed. Check your HF_TOKEN.")
                return
            last_error = e
            logger.warning(f"[{model_id}] HTTP error on attempt {attempt}: {e}")

        # --- Retryable errors: transient network issues ---
        except (RequestsConnectionError, RequestsTimeout) as e:
            last_error = e
            logger.warning(f"[{model_id}] Network error on attempt {attempt}: {e}")

        except OSError as e:
            _fail(model_id, f"Disk/filesystem error while saving files: {e}")
            return

        except Exception as e:
            _fail(model_id, f"Unexpected error: {e}")
            return

    _fail(model_id, f"Download failed after {MAX_RETRIES} attempts: {last_error}")


def _fail(model_id: str, message: str) -> None:
    """Marks a model as errored in the registry and logs it."""
    logger.error(f"[{model_id}] {message}")
    models_registry.update_status(model_id, status="error", error_message=message)


def _folder_size(path: Path) -> int:
    """Sums the size of every file in a downloaded model folder (it's a directory, not a single file)."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


# ---------------------------------------------------------------------------
# Manual test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    models_registry.init_db()

    # Should succeed
    download("whisper-tiny-int8-ov", "OpenVINO/whisper-tiny-int8-ov")
    print(models_registry.get_model("whisper-tiny-int8-ov"))

    # # Should fail cleanly with a clear error, not a crash
    # download("bad-model", "this-repo/does-not-exist")
    # print(models_registry.get_model("bad-model"))