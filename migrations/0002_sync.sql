CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  client_updated_at TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, id)
);
CREATE INDEX idx_sync_applied ON sync_operations(applied_at);
