-- Webhook integrations: lifecycle state (disable/rotate/usage), a delivery audit
-- trail, and a JSONB embed column so webhook messages can carry structured
-- self-embeds (no remote fetching — embeds are stored verbatim and rendered by
-- the client from the stored fields only).

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS disabled     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS rotated_at   TIMESTAMPTZ;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Structured, self-contained embeds. Authentication/validation happens in the
-- webhook executor; the database only stores the validated JSON.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGINT PRIMARY KEY,
  webhook_id      BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  message_id      BIGINT,
  status_code     INTEGER NOT NULL,
  success         BOOLEAN NOT NULL,
  error           TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx
  ON webhook_deliveries (webhook_id, id DESC);

-- Delivery idempotency: a repeated (webhook, idempotency key) never inserts a
-- second row, which is what makes retries safe.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_idempotency_key
  ON webhook_deliveries (webhook_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
