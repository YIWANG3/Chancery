// Migrations are append-only. Never edit an entry that has shipped; add a new one.

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  repo text,
  default_branch text NOT NULL DEFAULT 'main',
  dir text NOT NULL UNIQUE,
  worktree_root text NOT NULL,
  platform jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_executor text NOT NULL DEFAULT 'claude-desktop',
  default_model text,
  parallel integer NOT NULL DEFAULT 1,
  github_sync boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent (
  id text PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  github_login text,
  notes text
);
INSERT INTO agent (id, kind, name) VALUES
  ('human', 'human', '我'),
  ('claude-desktop', 'claude-desktop', 'Claude'),
  ('codex', 'codex', 'Codex'),
  ('dsh', 'dsh', 'DeepSeek Harness');

CREATE TABLE ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  project_id uuid NOT NULL REFERENCES project(id),
  source text NOT NULL DEFAULT 'local',
  external_ref text,
  kind text NOT NULL DEFAULT 'chore',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'inbox',
  area text[] NOT NULL DEFAULT '{}',
  spec_path text,
  blocked_by uuid[] NOT NULL DEFAULT '{}',
  executor text,
  model text,
  auto_merge boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ticket_external_ref ON ticket (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX ticket_status ON ticket (status, priority, created_at);

CREATE TABLE assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  agent_id text REFERENCES agent(id),
  role text NOT NULL DEFAULT 'execute',
  executor text NOT NULL,
  session_ref text,
  worktree text,
  branch text,
  pr_number integer,
  pr_url text,
  status text NOT NULL DEFAULT 'queued',
  lease_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  last_report jsonb
);
CREATE INDEX assignment_ticket ON assignment (ticket_id, started_at DESC);
CREATE INDEX assignment_open ON assignment (status) WHERE status IN ('queued', 'running', 'waiting');

CREATE TABLE event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  assignment_id uuid REFERENCES assignment(id),
  actor text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_id text
);
CREATE INDEX event_ticket ON event (ticket_id, at);
CREATE UNIQUE INDEX event_external ON event (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project(id),
  ticket_id uuid REFERENCES ticket(id),
  text text NOT NULL,
  state text NOT NULL DEFAULT 'proposed',
  decided_at timestamptz,
  event_id uuid REFERENCES event(id),
  superseded_by uuid REFERENCES decision(id),
  file_anchor text
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending',
  sent_external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due ON outbox (next_at) WHERE state = 'pending';

CREATE TABLE sync_cursor (
  source text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, key)
);

CREATE TABLE ledger (
  backend text NOT NULL,
  usage_window text NOT NULL,
  used_pct real,
  resets_at timestamptz,
  backoff_until timestamptz,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backend, usage_window)
);

CREATE OR REPLACE FUNCTION chancery_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('chancery', TG_TABLE_NAME || ':' || COALESCE(NEW.id::text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_notify AFTER INSERT OR UPDATE ON ticket FOR EACH ROW EXECUTE FUNCTION chancery_notify();
CREATE TRIGGER event_notify AFTER INSERT ON event FOR EACH ROW EXECUTE FUNCTION chancery_notify();
CREATE TRIGGER assignment_notify AFTER INSERT OR UPDATE ON assignment FOR EACH ROW EXECUTE FUNCTION chancery_notify();
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION chancery_notify();

CREATE OR REPLACE FUNCTION ticket_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ticket_touch BEFORE UPDATE ON ticket FOR EACH ROW EXECUTE FUNCTION ticket_touch();
`,
  },
];
