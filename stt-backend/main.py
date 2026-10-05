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


import asyncio
import json
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
from inference_service import InferenceError, resample_chunk

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
async def live_transcribe(websocket: WebSocket):
    await websocket.accept()
 
    model_id = websocket.query_params.get("model_id")
    if not model_id:
        await websocket.close(code=1008, reason="model_id query param required")
        return
 
    vad = VoiceActivityDetector(aggressiveness=2)
    # Each item is ("audio", bytes) | ("stop", None) | ("disconnect", None)
    audio_queue: asyncio.Queue[tuple[str, bytes | None]] = asyncio.Queue()
 
    async def reader():
        """Does nothing but keep reading from the socket — never blocked by
        transcription, so uvicorn's keepalive pings always get answered.
        Branches on message type so it can tell audio bytes apart from the
        client's {"type": "stop"} control message."""
        try:
            while True:
                message = await websocket.receive()

                if message["type"] == "websocket.disconnect":
                    await audio_queue.put(("disconnect", None))
                    return

                if message.get("bytes") is not None:
                    await audio_queue.put(("audio", message["bytes"]))
                elif message.get("text") is not None:
                    try:
                        payload = json.loads(message["text"])
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "stop":
                        logger.info("Received stop signal — will flush and drain queue.")
                        await audio_queue.put(("stop", None))
                        return  # stop listening for more audio once stop is requested
        except WebSocketDisconnect:
            await audio_queue.put(("disconnect", None))
 
    async def process_chunk(chunk_bytes: bytes, chunk_count: int) -> None:
        """Runs the save/filter/resample/transcribe/hallucination-check/send
        pipeline for one finalized chunk — shared by both the normal VAD
        path and the flush-on-stop path, so logging and behavior match."""
        try:
            _save_wav(f"./vad_test_chunks/chunk_{chunk_count}.wav", chunk_bytes)

            if not is_likely_real_speech(chunk_bytes):
                logger.info(f"Phrase {chunk_count} rejected as non-speech (ZCR/energy check).")
                return

            # Resampling
            audio_array = resample_chunk(chunk_bytes)
            logger.info(f"Phrase {chunk_count} audio resampled.")

            # Transcribe in threadpool
            text = await run_in_threadpool(
                inference_service.transcribe_array, model_id, audio_array
            )
            logger.info(f"Phrase {chunk_count} audio transcribed.")

            # Hallucination check
            if is_hallucination(text):
                logger.info(f"Phrase {chunk_count} transcription failed (Hallucination).")
                return

            logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
            
            # Send result
            await websocket.send_json({"type": "phrase", "text": text})

        except WebSocketDisconnect:
            logger.info("Client disconnected before result could be sent.")
            raise
        except Exception as e:
            logger.error(f"Error processing phrase {chunk_count}: {e}")
            # Don't let one bad chunk kill the whole session — keep going.

    async def processor():
        """Pulls audio off the queue, runs VAD, transcribes finalized
        phrases, and sends results back — independently of the reader.
        On "stop", finishes draining whatever's already queued, flushes
        any trailing buffered speech, then sends a "done" acknowledgment
        before the session ends."""
        chunk_count = 0
        while True:
            kind, data = await audio_queue.get()

            if kind == "disconnect":
                logger.info("Live transcription session ended (disconnect).")
                break

            if kind == "stop":
                # Flush whatever speech was buffered but never finalized —
                # e.g. the user's last sentence, with no pause yet.
                finalized_chunk = vad.flush()
                if finalized_chunk is not None:
                    chunk_count += 1
                    try:
                        await process_chunk(finalized_chunk, chunk_count)
                    except WebSocketDisconnect:
                        break
                else:
                    logger.info("Nothing left to flush on stop.")

                try:
                    await websocket.send_json({"type": "done"})
                    logger.info("Sent done acknowledgment, session finishing.")
                except WebSocketDisconnect:
                    logger.info("Client already gone before done could be sent.")
                break

            # kind == "audio"
            finalized_chunk = vad.feed(data)
            if finalized_chunk is None:
                continue

            chunk_count += 1
            try:
                await process_chunk(finalized_chunk, chunk_count)
            except WebSocketDisconnect:
                break
 
    reader_task = asyncio.create_task(reader())
    processor_task = asyncio.create_task(processor())
 
    try:
        await processor_task  # the session is "done" once the processor stops
    finally:
        reader_task.cancel()
        logger.info("Live transcription session ended.")



KNOWN_HALLUCINATIONS = {
    "terima kasih kerana menonton",
    "sampai jumpa di video selanjutnya",
    "selamat menikmati",
    "jangan lupa tolong tekan like dan subscribe",
    "terima kasih telah menonton",
    "terima kasih banyak untuk menonton",
    "selamat menikmati",
}

def is_hallucination(text: str) -> bool:
    return text.strip().lower().rstrip(".!") in KNOWN_HALLUCINATIONS


# def normalize_audio(audio: np.ndarray) -> np.ndarray:
#     peak = np.abs(audio).max()
#     if peak > 0:
#         return audio / peak * 0.95  # normalize to 95% of full scale, avoid clipping
#     return audio


def _save_wav(path: Path, pcm_bytes: bytes) -> None:
    """Writes raw 16-bit PCM bytes as a playable .wav file."""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)


def is_likely_real_speech(pcm_bytes: bytes, sample_rate: int = 48000) -> bool:
    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if len(audio) == 0:
        return False

    # --- Zero-crossing rate ---
    signs = np.sign(audio)
    signs[signs == 0] = 1  # avoid double-counting a flat zero as a crossing
    zero_crossings = np.sum(np.abs(np.diff(signs))) / 2
    zcr = zero_crossings / len(audio)

    # --- Energy spread across sub-windows ---
    window_size = int(sample_rate * 0.02)  # 20ms windows
    num_windows = len(audio) // window_size
    if num_windows == 0:
        return False

    window_energies = [
        np.sqrt(np.mean(audio[i * window_size:(i + 1) * window_size] ** 2))
        for i in range(num_windows)
    ]
    max_energy = max(window_energies)
    active_windows = sum(1 for e in window_energies if e > max_energy * 0.3)
    spread_ratio = active_windows / num_windows

    # Tune these two thresholds against your own click vs. speech test cases.
    ZCR_MAX = 0.100 # clicks tend to run higher than this
    SPREAD_MIN = 0.02 # clicks concentrate energy in very few windows

    logging.info(f"zcr={zcr:.3f} spread={spread_ratio:.3f}")

    return zcr < ZCR_MAX and spread_ratio > SPREAD_MIN