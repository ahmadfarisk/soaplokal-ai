"""
models_registry.py

Owns all reads/writes to the SQLite model registry. No other module in the
project should touch the database directly — everything goes through the
functions defined here.

Now engine-aware: a model is either "llama_cpp" (single GGUF file, tracked
via repo_id + filename) or "openvino" (a whole pre-converted IR folder,
tracked via hf_model_id).
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "registry.db"

# ---------------------------------------------------------------------------
# Connection handling
# ---------------------------------------------------------------------------

@contextmanager
def get_connection():
    """Yields a SQLite connection with row access by column name."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """Creates the models table if it doesn't exist yet. Call this once on startup."""
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS models (
                id TEXT PRIMARY KEY,
                engine TEXT NOT NULL DEFAULT 'llama_cpp',
                repo_id TEXT,
                filename TEXT,
                hf_model_id TEXT,
                local_path TEXT,
                status TEXT NOT NULL DEFAULT 'not_downloaded',
                size_bytes INTEGER,
                downloaded_at TEXT,
                error_message TEXT
            )
            """
        )


# ---------------------------------------------------------------------------
# Write operations
# ---------------------------------------------------------------------------

def add_model(
    model_id: str,
    engine: str = "llama_cpp",
    repo_id: Optional[str] = None,
    filename: Optional[str] = None,
    hf_model_id: Optional[str] = None,
) -> None:
    """
    Inserts a new model row, or resets an existing one, with status 'downloading'.
    Call this right before starting a download.
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO models (id, engine, repo_id, filename, hf_model_id, status)
            VALUES (?, ?, ?, ?, ?, 'downloading')
            ON CONFLICT(id) DO UPDATE SET
                engine = excluded.engine,
                repo_id = excluded.repo_id,
                filename = excluded.filename,
                hf_model_id = excluded.hf_model_id,
                status = 'downloading',
                error_message = NULL
            """,
            (model_id, engine, repo_id, filename, hf_model_id),
        )


def update_status(
    model_id: str,
    status: str,
    local_path: Optional[str] = None,
    size_bytes: Optional[int] = None,
    error_message: Optional[str] = None,
) -> None:
    """
    Updates a model's status (e.g. 'ready', 'error').
    Pass local_path/size_bytes when a download finishes successfully;
    pass error_message when it fails.
    """
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE models
            SET status = ?,
                local_path = COALESCE(?, local_path),
                size_bytes = COALESCE(?, size_bytes),
                error_message = ?,
                downloaded_at = CASE WHEN ? = 'ready'
                                     THEN ?
                                     ELSE downloaded_at END
            WHERE id = ?
            """,
            (
                status,
                local_path,
                size_bytes,
                error_message,
                status,
                datetime.now(timezone.utc).isoformat(),
                model_id,
            ),
        )


def delete_model(model_id: str) -> None:
    """Removes a model's row from the registry. Does NOT delete the file on disk — do that separately."""
    with get_connection() as conn:
        conn.execute("DELETE FROM models WHERE id = ?", (model_id,))


# ---------------------------------------------------------------------------
# Read operations
# ---------------------------------------------------------------------------

def get_model(model_id: str) -> Optional[dict]:
    """Fetches one model's details by id, or None if it doesn't exist."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM models WHERE id = ?", (model_id,)).fetchone()
        return dict(row) if row else None


def get_all_models() -> list[dict]:
    """Returns every model in the registry, most recently downloaded first."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM models ORDER BY downloaded_at IS NULL, downloaded_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def model_exists(model_id: str) -> bool:
    return get_model(model_id) is not None


# ---------------------------------------------------------------------------
# Manual test — run this file directly to sanity-check the registry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()

    add_model("qwen2.5-1.5b-q4", engine="llama_cpp", repo_id="bartowski/Qwen2.5-1.5B-Instruct-GGUF", filename="Qwen2.5-1.5B-Instruct-Q4_K_M.gguf")
    print("After add_model:", get_model("qwen2.5-1.5b-q4"))

    update_status(
        "qwen2.5-1.5b-q4",
        status="ready",
        local_path="./models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        size_bytes=1_073_741_824,
    )
    print("After update_status:", get_model("qwen2.5-1.5b-q4"))

    print("All models:", get_all_models())