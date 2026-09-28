
import logging

from optimum.intel import OVModelForSpeechSeq2Seq
from transformers import AutoProcessor, pipeline

import models_registry

class InferenceError(Exception):
  """Raised for load/unload/transcribe failures the caller needs to handle explicitly."""



logger = logging.getLogger(__name__)


# Loaded list
_loaded_pipelines: dict[str, object] = {}


# Load / Unload

# Load model
def load_model(model_id: str, local_path: str, device: str = "AUTO"):
  # Returns if model is already loaded
  if model_id in _loaded_pipelines: 
    return
  
  # Unload pipelines so there's only one pipeline at all time
  unload_all()
  
  try:
    logger.info(f"Loading [{model_id}] pipeline.")
    # Load model
    model = OVModelForSpeechSeq2Seq.from_pretrained(local_path, device=device)
    processor = AutoProcessor.from_pretrained(local_path)
    # Put loade model into the list of loaded models
    _loaded_pipelines[model_id] = pipeline(
      "automatic-speech-recognition",
      model=model,
      tokenizer=processor.tokenizer,
      feature_extractor=processor.feature_extractor,
    )
  except e: 
    raise InferenceError(f"Failed to load {model_id} pipeline: {e}")

def unload_model(model_id: str) -> None:
  """Removes a loaded pipeline from memory, letting Python garbage-collect it."""
  if model_id in _loaded_pipelines:
    del _loaded_pipelines[model_id]
    logger.info(f"[{model_id}] Unloaded.")
  else:
    logger.info(f"[{model_id}] Not currently loaded, nothing to unload.")


def unload_all() -> None:
  """Removes all loaded pipelines from memory."""
  for model_id in list(_loaded_pipelines.keys()):
    unload_model(model_id)
  

# Get loaded model
def get_loaded_models() -> str:
  print(_loaded_pipelines)


# Transcribe an audio (RETURNS THE TEXT)
def transcribe(model_id: str, audio_path: str) -> str:
  pipe = _loaded_pipelines.get(model_id)
  if pipe is None:
    raise InferenceError(f"Model '{model_id}' is not loaded.")
  result = pipe(
    audio_path,
    return_timestamps=True,
    generate_kwargs={
      "repetition_penalty": 1.3,
      "no_repeat_ngram_size": 3,
    },
  )
  return result["text"]




if __name__ == "__main__":
  logging.basicConfig(level=logging.INFO)
  models_registry.init_db()

  MODEL_ID = "whisper-small-int8-ov"

  try:
    load_model(MODEL_ID, "models/"+MODEL_ID)
    print("Loaded pipelines:",_loaded_pipelines)

    print("----------------------------------------------------------------")
    print("Result:", transcribe(MODEL_ID, "test_audio.mp3"))
    print("----------------------------------------------------------------")
  except InferenceError as e:
    print(f"Error: {e}")
  finally:
    unload_all()