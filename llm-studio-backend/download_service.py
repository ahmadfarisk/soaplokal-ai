"""
download_service.py

Wraps huggingface_hub downloads, keeping models_registry.py in sync
with progress/success/failure. Designed to run as a background task —
errors are caught and written into the registry rather than raised,
since there's no open HTTP request left to return them to by the time
a download finishes or fails.
"""

import logging
from pathlib import Path

from huggingface_hub import hf_hub_download
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
# 3. If there is an error with hugging face, update the model status to be "error"
# 4. If the error is an internet thing or an OS thing or an unkown error then it will try again for MAX_RETRIES times
# Simple no? It looks long because of the error checking. Honestly, it feels quite excessive.

def download(model_id: str, repo_id: str, filename: str, force: bool = False) -> None:
    """
    Downloads a single GGUF file from Hugging Face and updates the registry
    as it goes. Safe to call from a FastAPI BackgroundTask — never raises,
    always leaves the registry in either 'ready' or 'error' state.
    """

    # Check if model already exists
    existing = models_registry.get_model(model_id)
    if existing and existing["status"] == "ready" and not force:
      logger.info(f"[{model_id}] Already downloaded at {existing['local_path']}, skipping.")
      return

    models_registry.add_model(model_id, repo_id, filename)

    last_error: Exception | None = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"[{model_id}] Download attempt {attempt}/{MAX_RETRIES} — {repo_id}/{filename}")

            local_path = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=str(MODELS_DIR),
                # huggingface_hub resumes partial files automatically on retry
            )

            size_bytes = Path(local_path).stat().st_size

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
            _fail(model_id, f"Repo '{repo_id}' not found. Check the repo_id is correct and spelled right.")
            return

        except EntryNotFoundError:
            _fail(model_id, f"File '{filename}' not found in repo '{repo_id}'. Check the exact filename on Hugging Face.")
            return

        except GatedRepoError:
            _fail(
                model_id,
                f"'{repo_id}' is a gated model. Accept its license on huggingface.co and "
                f"make sure a valid HF_TOKEN is set.",
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
            _fail(model_id, f"Disk/filesystem error while saving file: {e}")
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
    # download("bad-model", "this-repo/does-not-exist", "nope.gguf")
    # print(models_registry.get_model("bad-model"))

    # Should succeed
    download("qwen3-0.6b-q8_0", "drmcbride/Qwen3-0.6B-Q8_0-GGUF", "qwen3-0.6b-q8_0.gguf")
    print(models_registry.get_model("qwen3-0.6b-q8_0"))

    