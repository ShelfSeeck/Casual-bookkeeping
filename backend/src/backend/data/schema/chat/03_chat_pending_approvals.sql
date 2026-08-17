CREATE TABLE IF NOT EXISTS chat_pending_approvals (
    account_phone TEXT PRIMARY KEY,
    approval_request_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
