CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL UNIQUE,
  language TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lead_score INTEGER DEFAULT 0,
  hot_alert_sent_at TEXT,
  urgent_alert_sent_at TEXT,
  opt_out_at TEXT,
  free_entry_detected INTEGER DEFAULT 0,
  ad_referral_json TEXT,
  collected_name TEXT,
  collected_date TEXT,
  collected_people INTEGER,
  collected_transport_need TEXT,
  collected_lodging_need TEXT,
  collected_pet TEXT,
  collected_plan TEXT,
  price_given_at TEXT,
  handed_off_at TEXT,
  soft_closed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_message_id TEXT UNIQUE,
  customer_phone TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS processed_webhook_messages (
  whatsapp_message_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  channel TEXT NOT NULL,
  score INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  media_id TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
