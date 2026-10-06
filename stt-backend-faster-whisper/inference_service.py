import logging
import time

# For faster-whisper (CTranslate2-backed, no torch/optimum-intel needed)
from faster_whisper import WhisperModel

import numpy as np
import librosa
# import noisereduce

import models_registry

class InferenceError(Exception):
  """Raised for load/unload/transcribe failures the caller needs to handle explicitly."""

DEFAULT_DEVICE = "cpu"          # "cpu" or "cuda"
DEFAULT_COMPUTE_TYPE = "int8"   # quantization — "int8" for CPU, "float16" is typical for "cuda"

BEAM_SIZE = 1
INITIAL_PROMPT = "Ini adalah percakapan antara seorang dokter dan pasiennya."
LIVE_INITIAL_PROMPT = "Ini adalah cuplikan percakapan antara seorang dokter dan pasiennya."

logger = logging.getLogger(__name__)


# Loaded list — same shape/intent as the OpenVINO version, just holding a
# faster-whisper WhisperModel instead of a transformers pipeline.
_loaded_pipelines: dict[str, object] = {}


# Load / Unload

# Load model
def load_model(model_id: str, local_path: str, device: str = DEFAULT_DEVICE, compute_type: str = DEFAULT_COMPUTE_TYPE):
  # Returns if model is already loaded
  if model_id in _loaded_pipelines:
    return

  # Unload pipelines so there's only one pipeline at all time
  unload_all()

  try:
    logger.info(f"Loading [{model_id}] model (device={device}, compute_type={compute_type}).")
    # WhisperModel wraps download/load/compile into one call — no separate
    # processor/tokenizer wiring and no pipeline() wrapper needed, unlike
    # the OpenVINO/transformers version.
    _loaded_pipelines[model_id] = WhisperModel(local_path, device=device, compute_type=compute_type)

    print(_loaded_pipelines[model_id].feature_extractor.mel_filters.shape)
  except Exception as e:
    raise InferenceError(f"Failed to load {model_id} model: {e}")

def unload_model(model_id: str) -> None:
  """Removes a loaded model from memory, letting Python garbage-collect it."""
  if model_id in _loaded_pipelines:
    del _loaded_pipelines[model_id]
    logger.info(f"[{model_id}] Unloaded.")
  else:
    logger.info(f"[{model_id}] Not currently loaded, nothing to unload.")


def unload_all() -> None:
  """Removes all loaded models from memory."""
  for model_id in list(_loaded_pipelines.keys()):
    unload_model(model_id)


# Get loaded model
def get_loaded_models() -> dict:
  """Returns {model_id: {"engine": "faster_whisper"}} for everything currently loaded."""
  return {model_id: {"engine": "faster_whisper"} for model_id in _loaded_pipelines.keys()}


# ---------------------------------------------------------------------------
# Shared transcription runner — faster-whisper accepts either a file path or
# a numpy array as `audio`, so transcribe() and transcribe_array() can both
# funnel through this instead of duplicating the model.transcribe(...) call.
# `model.transcribe()` returns a lazy segment generator + an `info` object —
# the generator has to actually be consumed (iterated) for any work to
# happen at all, which is why the elapsed-time measurement wraps the join,
# not just the call to .transcribe() itself.
# ---------------------------------------------------------------------------

def _run_transcribe(model_id: str, audio, **transcribe_kwargs):
  model: WhisperModel | None = _loaded_pipelines.get(model_id)
  if model is None:
    raise InferenceError(f"Model '{model_id}' is not loaded.")

  start_time = time.perf_counter()
  segments, info = model.transcribe(audio, **transcribe_kwargs)
  text = " ".join(segment.text.strip() for segment in segments)  # consumes the generator
  elapsed = time.perf_counter() - start_time

  return text, info, elapsed


# Transcribe an audio file (RETURNS THE TEXT)
def transcribe(model_id: str, audio_path: str) -> dict:
  text, info, elapsed = _run_transcribe(
    model_id,
    audio_path,
    repetition_penalty=1.2,
    no_repeat_ngram_size=3,
    language="id",
    task="transcribe",
    initial_prompt=INITIAL_PROMPT,
    beam_size=BEAM_SIZE,
  )

  # info.duration comes straight from faster-whisper — no need to compute
  # audio length manually the way the OpenVINO version had to.
  real_time_factor = elapsed / info.duration if info.duration else None

  return {
    "text": text,
    "metrics": {
      "processing_seconds": round(elapsed, 3),
      "audio_seconds": round(info.duration, 2) if info.duration else None,
      "real_time_factor": round(real_time_factor, 3) if real_time_factor else None,
    },
  }


# Transcribe array
def transcribe_array(model_id: str, audio_array: np.ndarray, sampling_rate: int = 16000) -> dict:
  # faster-whisper expects float32 audio at 16kHz, same as what
  # resample_chunk() below already produces — no extra conversion needed.
  text, info, elapsed = _run_transcribe(
    model_id,
    audio_array,
    repetition_penalty=1.2,
    no_repeat_ngram_size=3,
    language="id",  # faster-whisper expects an ISO-639-1 code, not "indonesian"
    task="transcribe",
    condition_on_previous_text=False,
    initial_prompt=LIVE_INITIAL_PROMPT,
    beam_size=BEAM_SIZE,
  )

  real_time_factor = elapsed / info.duration if info.duration else None

  return {
    "text": text,
    "metrics": {
      "processing_seconds": round(elapsed, 3),
      "audio_seconds": round(info.duration, 2) if info.duration else None,
      "real_time_factor": round(real_time_factor, 3) if real_time_factor else None,
    },
  }


def resample_chunk(pcm_bytes: bytes, orig_sr: int = 48000, target_sr: int = 16000) -> np.ndarray:
    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    return librosa.resample(audio, orig_sr=orig_sr, target_sr=target_sr)

# def _reduce_noise(arr: np.ndarray, target_sr: int = 16000):
#   _reduced_array = noisereduce.reduce_noise(y=arr, sr=target_sr)
#   return _reduced_array


if __name__ == "__main__":
  logging.basicConfig(level=logging.INFO)
  models_registry.init_db()

  MODEL_ID = "whisper-small-faster"

  try:
    load_model(MODEL_ID, "models/"+MODEL_ID)
    print("Loaded pipelines:", _loaded_pipelines)

    print("----------------------------------------------------------------")
    print("Result:", transcribe(MODEL_ID, "test_audio.mp3"))
    print("----------------------------------------------------------------")
  except InferenceError as e:
    print(f"Error: {e}")
  finally:
    unload_all()