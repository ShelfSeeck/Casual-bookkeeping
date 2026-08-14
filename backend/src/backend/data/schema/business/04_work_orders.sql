CREATE TABLE IF NOT EXISTS work_orders (
    work_order_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_phone TEXT NOT NULL,
    sync_id TEXT NOT NULL UNIQUE,
    work_order_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,

    customer_id INTEGER NOT NULL,
    customer_code TEXT NOT NULL,
    customer_name TEXT NOT NULL,

    service_category TEXT NOT NULL,
    service_item TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit TEXT NOT NULL CHECK (trim(unit) <> ''),

    unit_price_cents INTEGER
        CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
    is_completed INTEGER NOT NULL DEFAULT 0
        CHECK (is_completed IN (0, 1)),
    row_version INTEGER NOT NULL DEFAULT 1
);
