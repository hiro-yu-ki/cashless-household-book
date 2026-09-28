PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  icon TEXT NOT NULL DEFAULT 'tag',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_categories_kind ON categories(kind, archived);

CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','refund')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  merchant TEXT NOT NULL DEFAULT '',
  merchant_normalized TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_event_id TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','inbox','duplicate_suspected')),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  note TEXT NOT NULL DEFAULT '',
  raw_payload TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_transactions_source_event ON transactions(source, source_event_id) WHERE source_event_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_transactions_fingerprint ON transactions(fingerprint) WHERE deleted_at IS NULL;
CREATE INDEX idx_transactions_date ON transactions(occurred_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_transactions_status ON transactions(status) WHERE deleted_at IS NULL;

CREATE TABLE transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_splits_transaction ON transaction_splits(transaction_id);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  UNIQUE(month, category_id)
);

CREATE TABLE merchant_history (
  merchant_normalized TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  chosen_count INTEGER NOT NULL DEFAULT 0,
  corrected_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (merchant_normalized, category_id)
);

CREATE TABLE classification_feedback (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  merchant_normalized TEXT NOT NULL,
  predicted_category_id TEXT,
  chosen_category_id TEXT NOT NULL REFERENCES categories(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id,name,kind,color,icon) VALUES
 ('cat-food','食費','expense','#f97316','utensils'), ('cat-daily','日用品','expense','#06b6d4','basket'),
 ('cat-transport','交通','expense','#3b82f6','train'), ('cat-utility','水道・光熱','expense','#eab308','bolt'),
 ('cat-fun','娯楽','expense','#a855f7','sparkles'), ('cat-other-expense','その他支出','expense','#64748b','tag'),
 ('cat-salary','給与','income','#22c55e','wallet'), ('cat-other-income','その他収入','income','#10b981','plus');
INSERT INTO payment_methods (id,name,type) VALUES
 ('pm-paypay','PayPay','qr'), ('pm-suica','Suica','transport_ic'), ('pm-aeonpay','AEON Pay','qr'),
 ('pm-credit','クレジットカード','credit_card'), ('pm-cash','現金','cash'), ('pm-other','その他','other');
