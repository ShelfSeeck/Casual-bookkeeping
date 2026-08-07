CREATE TABLE IF NOT EXISTS chat_turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
