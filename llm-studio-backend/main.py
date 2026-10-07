"""
main.py

The FastAPI entry point — the "receptionist" layer. Defines HTTP endpoints
and delegates all real work to models_registry.py, download_service.py,
and inference_service.py. Run with:

uvicorn main:app --reload --port 8000
"""

import logging
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import download_service
import inference_service
import models_registry
from inference_service import InferenceError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Local AI Studio — LLM Backend")

# Allow the Next.js dev server (different port) to call this API directly.
# Tighten this to your actual frontend origin before deploying anywhere.
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
    logger.info("LLM Registry initialized. ✅")


@app.on_event("shutdown")
def on_shutdown():
    # Prevents orphaned llama-server.exe processes if the backend stops/restarts.
    inference_service.unload_all()
    logger.info("All LLM models unloaded on shutdown. 🧼")


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class DownloadRequest(BaseModel):
    model_id: str
    engine: str
    repo_id: Optional[str] = None
    filename: Optional[str] = None
    hf_model_id: Optional[str] = None

class ChatRequest(BaseModel):
    model_id: str
    message: str
    history: Optional[list[dict]] = None
    temperature: float
    top_p: float
    top_k: int
    repetition_penalty: float
    max_tokens: int

# ---------------------------------------------------------------------------
# Model registry / download endpoints
# ---------------------------------------------------------------------------

# Get all models
@app.get("/models")
def list_models():
    """Get every model known to the registry, with its current status."""
    return models_registry.get_all_models()

# # Get one model
# @app.get("/models/{model_id}")
# def get_model_status(model_id: str):
#     """Get one model in the registry by ID."""
#     model = models_registry.get_model(model_id)
#     if model is None:
#         raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")
#     return model


# # Lists all available model name
# @app.get("/model_list")
# def list_models():
#     """Lists every model known to the registry, with its current status."""
#     models = models_registry.get_all_models()
#     model_list = []
#     for model in models:
#         model_list.append({"id":model["id"], "status": model["status"]})
#     return model_list


# Show status of one model
@app.get("/models/{model_id}/status")
def get_model_status(model_id: str):
    """Poll this to track download progress/completion (status: downloading | ready | error)."""
    model = models_registry.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")
    return {"model_id": model_id, "status": model["status"]}


@app.post("/models/download")
def download_model(req: DownloadRequest, background_tasks: BackgroundTasks):
    """
    Starts a download in the background. Returns immediately — poll
    GET /models/{model_id}/status to track progress/completion.
    """
    existing = models_registry.get_model(req.model_id)
    if existing and existing["status"] == "ready":
        return {"status": "already_downloaded", "model": existing}

    # background_tasks.add_task(
    #     download_service.download, req.model_id, req.repo_id, req.filename
    # )
    background_tasks.add_task(
        download_service.download,
        req.model_id,
        req.engine,
        repo_id=req.repo_id,
        filename=req.filename,
        hf_model_id=req.hf_model_id,
    )
    return {"status": "started", "model_id": req.model_id}


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    """Removes a model's registry entry. Unloads it first if it's currently running."""
    model = models_registry.get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not found.")

    inference_service.unload_model(model_id)  # no-op if it wasn't loaded
    models_registry.delete_model(model_id)

    # Note: this does not delete the .gguf file from disk — add that here
    # (e.g. Path(model["local_path"]).unlink(missing_ok=True)) once you're
    # comfortable letting the API delete files automatically.
    return {"status": "deleted", "model_id": model_id}


# ---------------------------------------------------------------------------
# Inference endpoints
# ---------------------------------------------------------------------------

@app.post("/models/{model_id}/load")
def load_model(model_id: str):
    """Spawns llama-server for this model and waits until it's ready to chat with."""
    try:
        entry = inference_service.load_model(model_id)
    except InferenceError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "loaded", "model_id": model_id, "port": entry["port"]}


@app.post("/models/{model_id}/unload")
def unload_model(model_id: str):
    inference_service.unload_model(model_id)
    return {"status": "unloaded", "model_id": model_id}


@app.get("/models/loaded")
def list_loaded_models():
    """Shows which models currently have a running llama-server process."""
    return inference_service.get_loaded_models()


@app.post("/chat")
def chat(req: ChatRequest):
    try:
        result = inference_service.chat(req.model_id, req.message, req.history,
                                        temperature = req.temperature,
                                        top_p = req.top_p,
                                        top_k = req.top_k,
                                        repetition_penalty = req.repetition_penalty,
                                        max_tokens = req.max_tokens,
                                        )
    except InferenceError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result

@app.post("/models/{model_id}/retry")
def retry(model_id: str):
    models_registry.update_status(model_id, "error")