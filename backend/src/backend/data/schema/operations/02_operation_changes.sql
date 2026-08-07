CREATE TABLE IF NOT EXISTS operation_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_sync_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    before_version INTEGER,
    after_version INTEGER,
    before_json TEXT,
    after_json TEXT,
    changed_fields_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_changes_operation_id
    ON operation_changes (operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_changes_entity
    ON operation_changes (entity_type, entity_sync_id);
