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
  -- Compliance record of the LAST stop request. `opt_out_at` is the ACTIVE
  -- suppression flag and may be cleared when the customer reopens the
  -- conversation themselves; this column is written once and never cleared.
  last_opt_out_at TEXT,
  free_entry_detected INTEGER DEFAULT 0,
  ad_referral_json TEXT,
  entry_marker TEXT,
  entry_temperature TEXT,
  entry_marker_at TEXT,
  collected_name TEXT,
  collected_date TEXT,
  collected_date_window TEXT,
  date_status TEXT NOT NULL DEFAULT 'unasked',
  collected_people INTEGER,
  collected_transport_need TEXT,
  collected_lodging_need TEXT,
  collected_pet TEXT,
  collected_plan TEXT,
  collected_adults INTEGER,
  collected_children INTEGER,
  collected_child_ages_json TEXT,
  collected_travel_origin TEXT,
  collected_date_canon_year INTEGER,
  collected_date_canon_month INTEGER,
  collected_date_canon_day INTEGER,
  price_given_at TEXT,
  handed_off_at TEXT,
  soft_closed_at TEXT,
  gallery_nudged_at TEXT,
  converted_at TEXT,
  assigned_line_id TEXT,
  assigned_agent_chat TEXT,
  conversation_mode TEXT DEFAULT 'bot',
  lead_pain TEXT,
  lead_pain_detail TEXT,
  lead_pain_detected_at TEXT,
  selected_experience_id TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_message_id TEXT UNIQUE,
  customer_phone TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  raw_json TEXT,
  app_version TEXT,
  media_id TEXT
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
  created_at TEXT NOT NULL,
  purpose TEXT DEFAULT 'reply',
  success INTEGER DEFAULT 1,
  error_type TEXT
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

CREATE TABLE IF NOT EXISTS payment_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_reference TEXT NOT NULL UNIQUE,
  customer_phone TEXT NOT NULL,
  preference_id TEXT UNIQUE,
  payment_url TEXT,
  expected_amount_cop INTEGER NOT NULL,
  plan_id TEXT,
  booking_date TEXT,
  people INTEGER,
  transport_need TEXT,
  deposit_percent INTEGER,
  availability_confirmed_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  mercado_pago_payment_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS bridge_sessions (
  agent_chat_id TEXT PRIMARY KEY,
  customer_phone TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  return_mode TEXT NOT NULL DEFAULT 'bot'
);

CREATE TABLE IF NOT EXISTS system_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  error_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  stack TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_errors_type ON system_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_system_errors_created ON system_errors(created_at);

-- Conversation history lookups group/filter by phone + time + direction.
CREATE INDEX IF NOT EXISTS idx_messages_phone_created_direction
  ON messages(customer_phone, created_at, direction);

-- LIVE: Explicit marketing opt-in for the single post-24h template. Operator-granted
-- (Telegram /followupgrant); `granted_by` is the provenance record.
CREATE TABLE IF NOT EXISTS followup_consent (
  customer_phone TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TEXT
);

-- LIVE: one row per (phone, anchor) for the one-shot post-24h template. The UNIQUE key
-- is the idempotency guarantee: two overlapping scheduler ticks cannot both insert the
-- same claim.
-- status: pending | sent | failed | uncertain
--   uncertain = Meta may have accepted the message (never auto-retry).
CREATE TABLE IF NOT EXISTS followup_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  anchor_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  whatsapp_message_id TEXT,
  failed_at TEXT,
  error_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (customer_phone, anchor_at)
);
CREATE INDEX IF NOT EXISTS idx_followup_events_phone_status
  ON followup_events(customer_phone, status);

-- Customer consent lifecycle for the consent ask → recurring-template flow.
-- status: unasked | pending | active | declined | revoked
-- consent_session: incremented each time a new ask session opens (reopen, deferral, closure)
--   so cycle keys are `c1`, `c2`, … per session instead of globally burned
CREATE TABLE IF NOT EXISTS followup_subscriptions (
  customer_phone TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unasked',
  asked_at TEXT,
  ask_outbound_message_id TEXT,
  ask_attempts INTEGER DEFAULT 0,
  consent_session INTEGER NOT NULL DEFAULT 1,
  deferred_reask_used INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT,
  decision_inbound_message_id TEXT,
  consent_source TEXT,
  activated_at TEXT,
  revoked_at TEXT,
  revoke_source TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_followup_subscriptions_status
  ON followup_subscriptions(status);

-- Per-stage dispatch ledger for the consent-gated follow-up flow.
-- event_kind: consent_ask | recurring
-- cycle_key:  'c1','c2',... for consent asks; 'c1-r1','c2-r1',... for recurring sends.
--   NOTE: the recurring key is a SEQUENCE INDEX, not YYYY-MM. A calendar key would
--   collapse to one row per month, which makes short dev intervals untestable and
--   silently caps production at one send per calendar month.
-- status: due | claimed | dispatching | accepted | delivered | failed | uncertain | cancelled
-- UNIQUE (customer_phone, event_kind, cycle_key) ensures one send per phase per cycle.
CREATE TABLE IF NOT EXISTS followup_subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  cycle_key TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due',
  claim_token TEXT,
  claimed_at TEXT,
  dispatch_started_at TEXT,
  dispatching_until TEXT,
  accepted_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  error_reason TEXT,
  whatsapp_message_id TEXT,
  attempts INTEGER DEFAULT 0,
  updated_at TEXT,
  UNIQUE (customer_phone, event_kind, cycle_key)
);
CREATE INDEX IF NOT EXISTS idx_followup_subscription_events_due_status
  ON followup_subscription_events(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_followup_subscription_events_phone_kind_status
  ON followup_subscription_events(customer_phone, event_kind, status);
CREATE INDEX IF NOT EXISTS idx_messages_direction_phone_created
  ON messages(direction, customer_phone, created_at);

-- Replay ledger for OUTBOUND customer-facing images: the resolved CDN url, the
-- caption actually sent, and which flow produced it. Every row is outbound;
-- inbound customer photos are recorded on `messages.media_id` instead.
--
-- Deliberately separate from `media_sends`, which stays a pure rate-limit ledger
-- (claim/release semantics, 72h budget). This table is append-only and is never
-- read by the reply path, so a write failure here can never affect delivery.
--
-- `turn_inbound_message_id` is the WhatsApp id of the INBOUND message that
-- triggered the turn; NULL means there was no inbound turn (follow-up outbound).
-- `carried_reply = 1` marks the photo whose caption is the bot reply text, which
-- is how a transcript replay avoids rendering that reply twice.
CREATE TABLE IF NOT EXISTS outbound_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  media_url TEXT NOT NULL,
  media_id TEXT NOT NULL,
  caption TEXT,
  carried_reply INTEGER NOT NULL DEFAULT 0,
  flow TEXT NOT NULL,
  theme_site_id TEXT,
  theme_type TEXT,
  turn_inbound_message_id TEXT,
  sequence INTEGER,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbound_media_phone_sent
  ON outbound_media(customer_phone, sent_at);
