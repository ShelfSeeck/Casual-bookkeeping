CREATE TABLE IF NOT EXISTS database_operations (
    server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    account_phone TEXT NOT NULL,
    device_id TEXT,
    actor_type TEXT NOT NULL,
    source_turn_id TEXT,
    operation_type TEXT NOT NULL,
    reverts_operation_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_database_operations_account_phone
    ON database_operations (account_phone);
CREATE INDEX IF NOT EXISTS idx_database_operations_device_id
    ON database_operations (device_id);
CREATE INDEX IF NOT EXISTS idx_database_operations_actor_type
    ON database_operations (actor_type);
CREATE INDEX IF NOT EXISTS idx_database_operations_source_turn_id
    ON database_operations (source_turn_id);
CREATE INDEX IF NOT EXISTS idx_database_operations_operation_type
    ON database_operations (operation_type);
CREATE INDEX IF NOT EXISTS idx_database_operations_reverts_operation_id
    ON database_operations (reverts_operation_id);
CREATE INDEX IF NOT EXISTS idx_database_operations_created_at
    ON database_operations (created_at);
