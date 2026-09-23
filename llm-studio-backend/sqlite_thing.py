import sqlite3


connection = sqlite3.connect('lai012.db')

cursor = connection.cursor()



command1 = """CREATE TABLE models (
    id TEXT PRIMARY KEY,          -- e.g. "qwen2.5-1.5b-q4"
    repo_id TEXT NOT NULL,        -- HF repo, e.g. "bartowski/Qwen2.5-1.5B-Instruct-GGUF"
    filename TEXT NOT NULL,
    local_path TEXT,
    status TEXT DEFAULT 'not_downloaded',  -- not_downloaded | downloading | ready | error
    size_bytes INTEGER,
    downloaded_at TIMESTAMP
);
"""

cursor.execute(command1)