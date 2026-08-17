CREATE TABLE IF NOT EXISTS account_devices (
    account_phone TEXT NOT NULL,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    refresh_expires_at TEXT NOT NULL,
    refresh_token_hash TEXT,
    refresh_family_id TEXT,
    refresh_jti TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    PRIMARY KEY (account_phone, device_id)
);
