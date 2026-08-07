CREATE TABLE IF NOT EXISTS accounts (
    phone TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
