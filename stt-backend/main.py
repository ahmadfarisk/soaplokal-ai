
"""
main.py (STT service)

The FastAPI entry point for the STT backend. Routes HTTP requests 
to models_registry.py, download_service.py, and inference_service.py. 
Run with:

uvicorn main:app --reload --port 8001
"""


whisper_model_choices = [
    {
        'id': 'whisper-tiny-int8-ov',
        'hf_model_id': 'OpenVINO/whisper-tiny-int8-ov'
    },
    {
        'id': 'whisper-small-int8-ov',
        'hf_model_id': 'OpenVINO/whisper-small-int8-ov'
    },
    {
        'id': 'whisper-base-int8-ov',
        'hf_model_id': 'OpenVINO/whisper-base-int8-ov'
    },
    {
        'id': 'whisper-medium-int8-ov',
        'hf_model_id': 'OpenVINO/whisper-medium-int8-ov'
    },
]



import logging
import os
import tempfile
from pathlib import Path
import wave
import traceback
import numpy as np

from starlette.concurrency import run_in_threadpool

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect

from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from vad_service import VoiceActivityDetector, SAMPLE_RATE

import download_service
import inference_service
import models_registry
from inference_service import InferenceError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Local AI Studio — STT Backend")

# Allow the Next.js dev server to call this API directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@app.on_event("startup")
def on_startup():
    models_registry.init_db()
    logger.info("STT registry initialized. ✅")


@app.on_event("shutdown")
def on_shutdown():
    inference_service.unload_all()
    logger.info("All STT models unloaded on shutdown. 🧼")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class DownloadRequest(BaseModel):
    model_id: str
    hf_model_id: str
    force: bool = False


# ---------------------------------------------------------------------------
# Model registry / download endpoints
# ---------------------------------------------------------------------------

@app.get("/models")
def list_models():
    """Lists every STT model known to the registry, with its current status."""
    return models_registry.get_all_models()


@app.get("/models/{model_id}/status")
def get_model_status(model_id: str):
    """Poll this to track download progress/completion (status: downloading | ready | error)."""
    model = models_registry.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")

    response = {"model_id": model_id, "status": model["status"]}
    if model["status"] == "error":
        response["error_message"] = model["error_message"]
    return response


@app.post("/models/download")
def download_model(req: DownloadRequest, background_tasks: BackgroundTasks):
    """
    Starts a download in the background. Returns immediately — poll
    GET /models/{model_id}/status to track progress/completion.
    """
    existing = models_registry.get_model(req.model_id)
    if existing and existing["status"] == "ready" and not req.force:
        return {"status": "already_downloaded", "model": existing}

    background_tasks.add_task(
        download_service.download, req.model_id, req.hf_model_id, req.force
    )
    return {"status": "started", "model_id": req.model_id}


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    """Removes a model's registry entry. Unloads it first if it's currently loaded."""
    model = models_registry.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")

    inference_service.unload_model(model_id) 
    models_registry.delete_model(model_id)

    # Note: does not delete files on disk — add that here once you're
    # comfortable letting the API delete model folders automatically.
    return {"status": "deleted", "model_id": model_id}


# ---------------------------------------------------------------------------
# Inference endpoints
# ---------------------------------------------------------------------------

@app.post("/models/{model_id}/load")
def load_model(model_id: str):
    """Loads the model's pipeline into memory (in-process, not a subprocess)."""
    model = models_registry.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")
    if model["status"] != "ready":
        raise HTTPException(
            status_code=400,
            detail=f"Model '{model_id}' is not downloaded yet (status: {model['status']}).",
        )

    try:
        inference_service.load_model(model_id, model["local_path"])
    except InferenceError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "loaded", "model_id": model_id}


@app.post("/models/{model_id}/unload")
def unload_model(model_id: str):
    inference_service.unload_model(model_id)
    return {"status": "unloaded", "model_id": model_id}


@app.get("/models/loaded")
def list_loaded_models():
    """Shows which models currently have a pipeline loaded in memory."""
    return inference_service.get_loaded_models()


@app.post("/transcribe")
async def transcribe(model_id: str, file: UploadFile = File(...)):
    """
    Accepts an uploaded audio file (wav, mp3, etc.) and transcribes it
    with the given (already-loaded) model.
    """
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        result = inference_service.transcribe(model_id, tmp_path)
        return result
    except InferenceError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        os.remove(tmp_path)  # always clean up, even if transcription fails


# ---------------------------------------------------------------------------
# websocket endpoints
# ---------------------------------------------------------------------------

CHUNKS_DIR = Path(__file__).parent / "vad_test_chunks"
CHUNKS_DIR.mkdir(exist_ok=True)

@app.websocket("/ws/live-transcribe")
async def live_transcribe(websocket: WebSocket, model_id: str):
    await websocket.accept()
    vad = VoiceActivityDetector(aggressiveness=2)
    chunk_count = 0
    _transcribed: list = []
 
    try:
        while True:
            data = await websocket.receive_bytes()
            finalized_chunk = vad.feed(data)
 
            if finalized_chunk is not None:
                chunk_count += 1

                logger.info(f"Phrase {chunk_count} detected.")
                # path = CHUNKS_DIR / f"chunk_{chunk_count:03d}.wav"
                # _save_wav(path, finalized_chunk)
                # logger.info(f"Saved {path} ({len(finalized_chunk)} bytes)")
                # await websocket.send_json({"type": "phrase_boundary", "chunk": chunk_count})

                audio_array = inference_service._resample_chunk(finalized_chunk)
                # audio_array = normalize_audio(audio_array)
                # audio_array = inference_service._reduce_noise(inference_service._resample_chunk(finalized_chunk))
                logger.info(f"Phrase {chunk_count} audio resampled.")
                text = await run_in_threadpool(inference_service.transcribe_array, model_id, audio_array)
                
                if is_hallucination(text):
                    logger.info(f"Phrase {chunk_count} transcription failed (Hallucination).")
                    continue

                logger.info(f"Phrase {chunk_count} audio transcribed.")
                _transcribed.append(text)
                try:
                    await websocket.send_json({"type": "phrase", "text": text})
                except WebSocketDisconnect:
                    logger.info("Client disconnected before result could be sent.")
                    break
 
    except Exception as e:
        logger.error(f"WebSocket disconnected: {e}")
        traceback.print_exc()


KNOWN_HALLUCINATIONS = {
    "terima kasih kerana menonton",
    "sampai jumpa di video selanjutnya",
    "selamat menikmati",
    "jangan lupa tolong tekan like dan subscribe",
    "terima kasih telah menonton",
    "terima kasih banyak untuk menonton",
}

def is_hallucination(text: str) -> bool:
    return text.strip().lower().rstrip(".!") in KNOWN_HALLUCINATIONS

def normalize_audio(audio: np.ndarray) -> np.ndarray:
    peak = np.abs(audio).max()
    if peak > 0:
        return audio / peak * 0.95  # normalize to 95% of full scale, avoid clipping
    return audio

def _save_wav(path: Path, pcm_bytes: bytes) -> None:
    """Writes raw 16-bit PCM bytes as a playable .wav file."""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)