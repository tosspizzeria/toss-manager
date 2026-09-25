-- Toss Pizzeria & Pub — Manager Sheet schema
-- Paste this whole file into the Supabase SQL Editor and hit Run.
-- Safe to re-run: everything is guarded with "if not exists".

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Managers: who can sign in, and whose initials land on checklist items.
-- pin_hash is sha-256 of the 4-digit pin, computed in the browser.
-- ---------------------------------------------------------------------------
create table if not exists managers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  initials    text not null,
  pin_hash    text not null,
  is_admin    boolean not null default false,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Staff roster: drives the tip-pool dropdowns so names aren't retyped nightly.
-- ---------------------------------------------------------------------------
create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        text not null default 'Server',
  in_tip_pool boolean not null default true,
  active      boolean not null default true,
  -- carries over the per-person row colours from the Tip Tracker tab
  color       text not null default '#c8352b',
  -- shorthand the old daily tabs used, e.g. ["Ash","Ashley"] -> Ashley Gonzalez
  aliases     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- Older installs: add the column without losing rows.
alter table staff add column if not exists color text not null default '#c8352b';
alter table staff add column if not exists aliases jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Checklist templates. Editable, so the opening/closing lists can change
-- without a code deploy. A day sheet stores initials keyed by item id, and
-- keeps its own copy of the label so history doesn't rewrite itself when a
-- line is later reworded or retired.
-- ---------------------------------------------------------------------------
create table if not exists checklist_items (
  id         uuid primary key default gen_random_uuid(),
  phase      text not null check (phase in ('open', 'close')),
  label      text not null,
  sort_order integer not null default 0,
  active     boolean not null default true
);

-- ---------------------------------------------------------------------------
-- Key/value settings: bar drawer float, tip minimum, payout line labels, etc.
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- One row per business date. Replaces one tab per day and one file per month.
-- Money is numeric(12,2); counted bills live in jsonb keyed by denomination.
-- ---------------------------------------------------------------------------
create table if not exists day_sheets (
  id             uuid primary key default gen_random_uuid(),
  business_date  date not null unique,

  manager_id     uuid references managers(id),
  manager_name   text,
  weather        text,
  events         text,

  -- opening safe count, e.g. {"100": 12, "50": 6, "20": 102, ...}
  open_counts    jsonb not null default '{}'::jsonb,
  cash_infusion  numeric(12,2) not null default 0,

  -- payouts out of the safe
  payouts        jsonb not null default '{}'::jsonb,
  extra_payouts  jsonb not null default '[]'::jsonb,

  -- cash brought in from the bar drawer (leaving the drawer float behind)
  cash_in_counts jsonb not null default '{}'::jsonb,

  -- closing safe recount
  close_counts   jsonb not null default '{}'::jsonb,

  -- Two entries summed, as on the sheet (B32 = SUM(F22, F24))
  net_sales_house    numeric(12,2),
  net_sales_delivery numeric(12,2),
  labor_cost_pct numeric(6,2),
  -- null means "derive the tip pool from the payout lines"; a value overrides it
  total_tips     numeric(12,2),

  open_checklist  jsonb not null default '{}'::jsonb,
  close_checklist jsonb not null default '{}'::jsonb,

  -- [{ staff_id, name, role, hours }]
  tip_rows       jsonb not null default '[]'::jsonb,

  notes          jsonb not null default '{}'::jsonb,

  status         text not null default 'open' check (status in ('open', 'closed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists day_sheets_business_date_idx
  on day_sheets (business_date desc);

-- Keep updated_at honest.
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists day_sheets_touch on day_sheets;
create trigger day_sheets_touch before update on day_sheets
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Payroll weeks. The Tip Tracker tab's "Payroll Done" marker, one row per
-- Monday-start week. The tip numbers themselves are never stored here — they
-- are read back out of the day sheets, so the tracker cannot drift from the
-- nightly sheets the way two spreadsheet tabs can.
-- ---------------------------------------------------------------------------
create table if not exists payroll_weeks (
  week_start date primary key,        -- always a Monday
  done       boolean not null default false,
  done_by    text,
  done_at    timestamptz,
  note       text
);

-- ---------------------------------------------------------------------------
-- Row level security. The site ships a public anon key, so RLS is the only
-- thing standing between your sales numbers and the open internet: every
-- policy below requires a signed-in Supabase user.
-- ---------------------------------------------------------------------------
alter table managers        enable row level security;
alter table staff           enable row level security;
alter table checklist_items enable row level security;
alter table settings        enable row level security;
alter table day_sheets      enable row level security;
alter table payroll_weeks   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['managers', 'staff', 'checklist_items', 'settings', 'day_sheets', 'payroll_weeks']
  loop
    execute format('drop policy if exists %I on %I', t || '_authenticated', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Seed data: the opening and closing checklists exactly as they read on the
-- August 2026 South 1st sheet, plus default settings.
-- ---------------------------------------------------------------------------
insert into checklist_items (phase, label, sort_order)
select 'open', label, ord from (values
  ('Turn on all Lights/Fans or heaters if cold out', 1),
  ('Put Fly Bait In Trash Cans', 2),
  ('Set AC/Heat', 3),
  ('Put on Music', 4),
  ('Confirm patio unlocked', 5),
  ('Count Bar Drawer', 6),
  ('Count safe box', 7),
  ('Daily Pretzel Count entered into toast', 8),
  ('Place any liquor or beer orders that need to be put in today', 9),
  ('Check reservations in Opentable', 10),
  ('Confirm all staff has arrived', 11),
  ('Use Toast Now App to update 86''d Items', 12),
  ('Confirm tv''s are on appropriate channels based on sporting events', 13),
  ('Preshift Coaching Session', 14),
  ('Check Ranch/blue Cheese levels let kitchen know if needed made', 15),
  ('Check Opening Bar List', 16),
  ('Check Opening Server List', 17),
  ('Walk entire restaurant make sure ready to open', 18)
) as v(label, ord)
where not exists (select 1 from checklist_items where phase = 'open');

insert into checklist_items (phase, label, sort_order)
select 'close', label, ord from (values
  ('Server Checklist Checked', 1),
  ('Bar Checklist Checked', 2),
  ('Kitchen Checklist Checked', 3),
  ('Prep list complete', 4),
  ('Misters/Heaters turned Off', 5),
  ('Move all empty propane tanks to cage', 6),
  ('AC/Heat Set to 75 cool on hot days, 68 heat on cold', 7),
  ('Attendance Sheet updated', 8),
  ('Check hours in toast', 9),
  ('Both phones on the charger', 10),
  ('Back/Patio Door Locked', 11),
  ('Kegs Locked', 12),
  ('All tablets Charging', 13),
  ('Warmer boxes turned off and ranch fridge closed', 14),
  ('Music Off', 15)
) as v(label, ord)
where not exists (select 1 from checklist_items where phase = 'close');

insert into settings (key, value) values
  ('location_name',      '"South 1st"'::jsonb),
  ('bar_drawer_float',   '60'::jsonb),
  ('tip_minimum_hourly', '20'::jsonb),
  ('cash_pickup_suggest_at', '4000'::jsonb),
  ('weather_zip',        '"78704"'::jsonb),
  ('weather_lat',        '30.2459'::jsonb),
  ('weather_lon',        '-97.7674'::jsonb),
  ('weather_timezone',   '"America/Chicago"'::jsonb),
  -- Teams to highlight on the day sheet's game panel, plus whether to include
  -- ranked college matchups.
  ('favorite_teams',     '["Texas Longhorns","Dallas Cowboys","Houston Texans"]'::jsonb),
  ('show_top_25',        'true'::jsonb),
  -- Each payout line is one of two kinds:
  --   "tip"  feeds the tip pool for payroll and does NOT leave the safe
  --   "safe" is cash that really walks out (petty cash, the bank pickup)
  -- A line with "auto":"cash_in_total" is calculated from the cash-in count
  -- rather than typed.
  ('payout_lines',       '[
      {"key":"team_tip_share","label":"Team Tip Share","kind":"tip",
       "note":"Credit card tips off the POS report. Feeds the tip pool for payroll; does not come out of the safe."},
      {"key":"cash_in_hand","label":"Cash In Hand","kind":"tip","auto":"cash_in_total",
       "note":"The cash-in count. Feeds the tip pool for payroll; the cash itself stays in the safe."},
      {"key":"delivery","label":"Delivery","kind":"safe"},
      {"key":"kitchen_beers","label":"Payouts / Kitchen Beers","kind":"safe"},
      {"key":"cash_pickup","label":"Cash Pickup for Deposit","kind":"safe",
       "note":"Bank deposit. Normally the only thing that lowers the rolling safe balance."}
   ]'::jsonb),
  ('denominations',      '[100, 50, 20, 10, 5, 1]'::jsonb)
on conflict (key) do nothing;
