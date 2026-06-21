-- Built Trailers — Phase 1 schema (PostgreSQL dialect; runs on Render Postgres and PGlite)

CREATE TABLE IF NOT EXISTS role (
  name  TEXT PRIMARY KEY,
  tier  TEXT NOT NULL CHECK (tier IN ('admin','editor','viewer'))
);

CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  title         TEXT,                 -- job role (references role.name)
  role          TEXT NOT NULL DEFAULT 'viewer',  -- permission tier (admin/editor/viewer)
  manager_id    TEXT REFERENCES app_user(id),
  phone         TEXT
);

CREATE TABLE IF NOT EXISTS vendor (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  lead_days INT  NOT NULL DEFAULT 0,
  terms     TEXT,
  status    TEXT NOT NULL DEFAULT 'active'   -- active / pending / rejected
);

CREATE TABLE IF NOT EXISTS part (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('P','M')),  -- Purchased / Manufactured
  vendor_id TEXT REFERENCES vendor(id),
  uom       TEXT,
  spec      TEXT,
  cost      NUMERIC(12,2) NOT NULL DEFAULT 0,   -- unit cost (purchased) or material cost (manufactured)
  on_hand   INT NOT NULL DEFAULT 0,
  reorder   INT NOT NULL DEFAULT 0,
  cushion   INT NOT NULL DEFAULT 0,
  lot       INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS model (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT,
  axle     TEXT,
  price    NUMERIC(12,2) NOT NULL DEFAULT 0,
  cap      NUMERIC(8,2)  NOT NULL DEFAULT 0    -- daily build capacity
);

CREATE TABLE IF NOT EXISTS bom_line (
  id       SERIAL PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  part_id  TEXT NOT NULL REFERENCES part(id),
  qty      NUMERIC(12,3) NOT NULL
);

CREATE TABLE IF NOT EXISTS model_labor (
  id       SERIAL PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model(id) ON DELETE CASCADE,
  ws       TEXT NOT NULL,
  hours    NUMERIC(8,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      SERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);

-- ===== Phase 2: Sales, dealers & orders =====

CREATE TABLE IF NOT EXISTS trailer_type (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS customer (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'Dealership',  -- Dealership / Retail
  contact         TEXT,
  phone           TEXT,
  rep_id          TEXT REFERENCES app_user(id),
  sms_consent     BOOLEAN NOT NULL DEFAULT false,
  sms_consent_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_allowed_type (
  customer_id TEXT NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  PRIMARY KEY (customer_id, type)
);

CREATE TABLE IF NOT EXISTS sales_order (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customer(id),
  model_id    TEXT REFERENCES model(id),
  qty         INT NOT NULL DEFAULT 1,
  stage       TEXT NOT NULL DEFAULT 'Quote',
  due         DATE,
  deposit     NUMERIC(4,3) NOT NULL DEFAULT 0,   -- fraction, e.g. 0.300
  channel     TEXT,
  rep_id      TEXT REFERENCES app_user(id),
  consumed    BOOLEAN NOT NULL DEFAULT false,    -- finished-goods inventory consumed at ship
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bom_model ON bom_line(model_id);
CREATE INDEX IF NOT EXISTS idx_bom_part  ON bom_line(part_id);
-- ===== Phase 3: Predictive ordering / purchasing =====

CREATE TABLE IF NOT EXISTS purchase_order (
  id        TEXT PRIMARY KEY,
  vendor_id TEXT REFERENCES vendor(id),
  part_id   TEXT REFERENCES part(id),
  qty       INT NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  placed    DATE NOT NULL DEFAULT CURRENT_DATE,
  eta       DATE,
  status    TEXT NOT NULL DEFAULT 'Open',   -- Open / Received
  created_by TEXT REFERENCES app_user(id)
);

CREATE INDEX IF NOT EXISTS idx_order_stage ON sales_order(stage);
CREATE INDEX IF NOT EXISTS idx_order_cust ON sales_order(customer_id);
-- ===== Phase 4: Accounting (QuickBooks) + OCR invoices =====

CREATE TABLE IF NOT EXISTS accounting_event (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,            -- invoice / bill
  ref         TEXT,                     -- source order/PO/invoice id
  party       TEXT,                     -- customer or vendor name
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  mode        TEXT NOT NULL DEFAULT 'simulated',  -- simulated / quickbooks
  status      TEXT NOT NULL DEFAULT 'posted',     -- posted / pending / synced
  external_id TEXT                      -- QuickBooks object id once synced
);

CREATE TABLE IF NOT EXISTS vendor_invoice (
  id          TEXT PRIMARY KEY,
  vendor_id   TEXT REFERENCES vendor(id),
  number      TEXT,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  lines       INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'Applied',
  created_by  TEXT REFERENCES app_user(id),
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_order(status);
CREATE INDEX IF NOT EXISTS idx_po_part ON purchase_order(part_id);
CREATE INDEX IF NOT EXISTS idx_acct_kind ON accounting_event(kind);

-- ===== Phase 5: People — employees, payroll, time off, outcomes, goals, recognition =====

CREATE TABLE IF NOT EXISTS employee (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  workstation TEXT,
  base_rate   NUMERIC(8,2) NOT NULL DEFAULT 0,   -- $/hr base
  hours_wk    NUMERIC(6,2) NOT NULL DEFAULT 40,
  mgr_id      TEXT REFERENCES app_user(id),       -- direct manager (a user)
  pto_balance NUMERIC(7,2) NOT NULL DEFAULT 80,
  schedule    TEXT                                -- JSON {Mon:["07:00","15:30"],...}
);

CREATE TABLE IF NOT EXISTS time_off (
  id           TEXT PRIMARY KEY,
  emp_id       TEXT REFERENCES employee(id),
  type         TEXT NOT NULL,         -- PTO / Sick / Unpaid / Bereavement
  start_date   DATE,
  end_date     DATE,
  hours        NUMERIC(6,2) NOT NULL DEFAULT 0,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'Pending Manager',  -- Pending Manager / Approved - To Payroll / Processed / Denied
  submitted_on DATE NOT NULL DEFAULT CURRENT_DATE,
  mgr_by TEXT, mgr_on DATE, pay_by TEXT, pay_on DATE
);

CREATE TABLE IF NOT EXISTS user_outcome (
  user_id TEXT PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  day TEXT, week TEXT, month TEXT, set_by TEXT, set_on DATE
);

CREATE TABLE IF NOT EXISTS self_goal (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  horizon    TEXT NOT NULL DEFAULT 'Month',
  done       BOOLEAN NOT NULL DEFAULT false,
  created_on DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS win (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,    -- individual / workstation / department
  target     TEXT NOT NULL,    -- user id, workstation name, or department name
  title      TEXT NOT NULL,
  detail     TEXT,
  by_user    TEXT REFERENCES app_user(id),
  created_on DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS win_reaction (
  win_id  TEXT NOT NULL REFERENCES win(id) ON DELETE CASCADE,
  emoji   TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (win_id, emoji, user_id)
);

CREATE INDEX IF NOT EXISTS idx_emp_ws ON employee(workstation);
CREATE INDEX IF NOT EXISTS idx_to_status ON time_off(status);
CREATE INDEX IF NOT EXISTS idx_goal_user ON self_goal(user_id);

-- ===== Phase 6: Notifications (SMS) =====
CREATE TABLE IF NOT EXISTS notification (
  id      SERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'sms',
  recipient TEXT,
  body    TEXT NOT NULL,
  kind    TEXT,                 -- order-status / alert / manual
  ref     TEXT,
  mode    TEXT NOT NULL DEFAULT 'simulated',
  status  TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS idx_labor_model ON model_labor(model_id);

-- ===== Approval workflow =====
CREATE TABLE IF NOT EXISTS approval_rule (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('po', 'vendor')),
  min_amount  NUMERIC(12,2),
  max_amount  NUMERIC(12,2),
  approver_id TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  seq         INT NOT NULL DEFAULT 1,
  notify      TEXT NOT NULL DEFAULT 'app' CHECK (notify IN ('app', 'sms', 'both')),
  active      BOOLEAN NOT NULL DEFAULT true,
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_request (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL REFERENCES approval_rule(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('po', 'vendor')),
  ref_id        TEXT NOT NULL,
  ref_amount    NUMERIC(12,2),
  ref_desc      TEXT,
  approver_id   TEXT NOT NULL REFERENCES app_user(id),
  seq           INT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  token         TEXT NOT NULL UNIQUE,
  notify_method TEXT NOT NULL DEFAULT 'app',
  requested_by  TEXT REFERENCES app_user(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT REFERENCES app_user(id),
  decided_at    TIMESTAMPTZ,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_appreq_ref     ON approval_request(ref_id);
CREATE INDEX IF NOT EXISTS idx_appreq_user    ON approval_request(approver_id, status);
CREATE INDEX IF NOT EXISTS idx_appreq_token   ON approval_request(token);

-- ===== In-app support system =====
CREATE TABLE IF NOT EXISTS support_ticket (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES app_user(id),
  type        TEXT NOT NULL DEFAULT 'question' CHECK (type IN ('question','bug','feature')),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','ai-resolved','escalated','approved','rejected','done')),
  ai_summary  TEXT,   -- AI's diagnosis / recommendation stored for admin review
  admin_note  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_message (
  id        SERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('user','ai','admin')),
  body      TEXT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_user   ON support_ticket(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON support_ticket(status);
CREATE INDEX IF NOT EXISTS idx_smsg_ticket   ON support_message(ticket_id);

-- ===== QuickBooks error log =====
CREATE TABLE IF NOT EXISTS qbo_error_log (
  id         SERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  method     TEXT,
  endpoint   TEXT,
  status     INT,
  intuit_tid TEXT,
  error_type TEXT,           -- QBOAuthError / QBOFeatureError / Error
  message    TEXT NOT NULL,
  raw_body   TEXT
);
CREATE INDEX IF NOT EXISTS idx_qboerr_ts ON qbo_error_log(ts DESC);

-- ===== Additive migrations (safe to re-run) =====
ALTER TABLE customer  ADD COLUMN IF NOT EXISTS sms_consent    BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE customer  ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;
ALTER TABLE app_user  ADD COLUMN IF NOT EXISTS sms_consent    BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE app_user  ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;

-- ===== SMS opt-in registry (keyword + webform opt-ins by phone) =====
CREATE TABLE IF NOT EXISTS sms_optin (
  phone        TEXT PRIMARY KEY,
  audience     TEXT NOT NULL DEFAULT 'customer',  -- customer / employee
  opted_in     BOOLEAN NOT NULL DEFAULT false,
  opted_in_at  TIMESTAMPTZ,
  opted_out_at TIMESTAMPTZ,
  method       TEXT   -- keyword / webform
);

-- ===== Role-based section access & multi-title users =====
CREATE TABLE IF NOT EXISTS role_section (
  role_name TEXT NOT NULL REFERENCES role(name) ON DELETE CASCADE,
  section   TEXT NOT NULL,
  PRIMARY KEY (role_name, section)
);

CREATE TABLE IF NOT EXISTS user_title (
  user_id   TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_name TEXT NOT NULL REFERENCES role(name) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_name)
);
