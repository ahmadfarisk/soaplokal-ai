"""
models_registry.py

Handles the database. Provide functions to deal with the database, 
such as add_model, get_model, update_status, and more.
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
 
DB_PATH = Path(__file__).parent / "stt_registry.db"

# This file provide functions to deal with the database, such as inserting models, getting models, update model status, and more.


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



# For creating the db
def init_db():
  """Creates the models table if it doesn't exist yet. Call this once on startup."""
  with get_connection() as conn:
    conn.execute(
      """
      CREATE TABLE stt_models (
        id TEXT PRIMARY KEY,              -- e.g. "whisper-tiny", "whisper-base"
        hf_model_id TEXT NOT NULL,        -- e.g. "openai/whisper-tiny"
        local_path TEXT,                  -- folder containing the converted OpenVINO IR files
        status TEXT DEFAULT 'not_downloaded',  -- not_downloaded | converting | ready | error
        size_bytes INTEGER,
        downloaded_at TIMESTAMP,
        error_message TEXT
      );
      """
    )

# Note: Status can be not_downloaded, downloading, ready, or error


# To insert a new model into the db
def add_model(model_id: str, hf_model_id: str, filename: str) -> None:
  """
  Inserts a new model row, or resets an existing one, with status 'downloading'.
  Call this right before starting a download.
  """
  with get_connection() as conn:
    conn.execute(
      """
      INSERT INTO models (id, hf_model_id, filename, status)
      VALUES (?, ?, ?, 'downloading')
      ON CONFLICT(id) DO UPDATE SET
        hf_model_id = excluded.hf_model_id,
        status = 'downloading',
        error_message = NULL
      """,
      (model_id, hf_model_id, filename),
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



# For Reading

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




# Test

# if __name__ == "__main__":
#     init_db()
 
#     add_model("qwen3-0.6b-q8_0", "drmcbride/Qwen3-0.6B-Q8_0-GGUF", "qwen3-0.6b-q8_0.gguf")
#     print("After add_model:", get_model("qwen3-0.6b-q8_0"))
 
#     update_status(
#         "qwen3-0.6b-q8_0",
#         status="ready",
#         local_path=".\models\qwen3-0.6b-q8_0.gguf",
#         size_bytes=785_893,
#     )
#     print("After update_status:", get_model("qwen3-0.6b-q8_0"))
 
#     print("All models:", get_all_models())