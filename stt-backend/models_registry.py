"""
models_registry.py (STT service)

Owns all reads/writes to the STT model registry.
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "stt_registry.db"


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
    """Creates the stt_models table if it doesn't exist yet. Call this once on startup."""
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stt_models (
                id TEXT PRIMARY KEY,
                hf_model_id TEXT NOT NULL,
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

def add_model(model_id: str, hf_model_id: str) -> None:
    """
    Inserts a new model row, or resets an existing one, with status 'downloading'.
    Call this right before starting a download.
    """
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO stt_models (id, hf_model_id, status)
            VALUES (?, ?, 'downloading')
            ON CONFLICT(id) DO UPDATE SET
                hf_model_id = excluded.hf_model_id,
                status = 'downloading',
                error_message = NULL
            """,
            (model_id, hf_model_id),
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
            UPDATE stt_models
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
    """Removes a model's row from the registry. Does NOT delete files on disk — do that separately."""
    with get_connection() as conn:
        conn.execute("DELETE FROM stt_models WHERE id = ?", (model_id,))


# ---------------------------------------------------------------------------
# Read operations
# ---------------------------------------------------------------------------

def get_model(model_id: str) -> Optional[dict]:
    """Fetches one model's details by id, or None if it doesn't exist."""
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM stt_models WHERE id = ?", (model_id,)).fetchone()
        return dict(row) if row else None


def get_all_models() -> list[dict]:
    """Returns every model in the registry, most recently downloaded first."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM stt_models ORDER BY downloaded_at IS NULL, downloaded_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def model_exists(model_id: str) -> bool:
    return get_model(model_id) is not None


# ---------------------------------------------------------------------------
# Manual test — run this file directly to sanity-check the registry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()

    add_model("whisper-tiny-int8", "OpenVINO/whisper-tiny-int8-ov")
    print("After add_model:", get_model("whisper-tiny-int8"))

    update_status(
        "whisper-tiny-int8",
        status="ready",
        local_path="./models/whisper-tiny-int8-ov",
        size_bytes=45_000_000,
    )
    print("After update_status:", get_model("whisper-tiny-int8"))

    print("All models:", get_all_models())