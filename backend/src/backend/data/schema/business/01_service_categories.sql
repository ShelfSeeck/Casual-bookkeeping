CREATE TABLE IF NOT EXISTS service_categories (
    service_category_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_phone TEXT NOT NULL,
    sync_id TEXT NOT NULL UNIQUE,
    category_name TEXT NOT NULL,
    subcategories_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    row_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (account_phone, category_name)
);
