CREATE TABLE IF NOT EXISTS customer_code_mappings (
    mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_phone TEXT NOT NULL,
    sync_id TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL,
    customer_code TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    row_version INTEGER NOT NULL DEFAULT 1,
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
