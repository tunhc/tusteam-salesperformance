-- ============================================================================
-- YES4ALL SALES DASHBOARD — SCHEMA V2 (DRAFT, NOT APPLIED)
-- Adds the tables behind the redesigned tabs (see prototype/redesign.html →
-- Blueprint). Review before running. Run AFTER supabase_schema.sql.
--
-- IMPORTANT: this repo is public and the dashboard uses the anon key. Every
-- new table below is readable only by authenticated users. Turn on Supabase
-- Auth (magic link, company email domain) before switching the dashboard to
-- these tables, and never add a "using (true)" read policy to cost or market
-- tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) SALES HISTORY for YoY (sales_daily only holds the current months)
-- ----------------------------------------------------------------------------
create table if not exists sales_monthly (
  sku            text not null references skus(sku) on delete cascade,
  month          date not null,                 -- first day of month
  channel        text,                          -- DI / DS / SPT
  units          numeric default 0,
  gmv            numeric default 0,
  ads            numeric default 0,
  promo          numeric default 0,
  ads_gmv        numeric default 0,             -- ads-attributed sales
  ads_units      numeric default 0,
  glance_views   numeric default 0,
  clicks         numeric default 0,
  impressions    numeric default 0,
  cm3            numeric,                       -- null = no cost stack (excluded, not zero)
  source_file    text,
  ingested_at    timestamptz not null default now(),
  primary key (sku, month)
);

-- ----------------------------------------------------------------------------
-- 2) INVENTORY, INCOMING, FORECAST (Tồn kho vs nhu cầu)
-- ----------------------------------------------------------------------------
create table if not exists inventory_snapshot (
  sku            text not null references skus(sku) on delete cascade,
  snapshot_date  date not null,
  salable_y4a    numeric default 0,
  salable_amz    numeric default 0,
  primary key (sku, snapshot_date)
);

create table if not exists incoming_po (
  id             bigint generated always as identity primary key,
  sku            text not null references skus(sku) on delete cascade,
  po_number      text,
  qty            numeric not null,
  eta_date       date,                          -- null = unknown ETA (dashboard asks for an assumed month)
  status         text default 'open' check (status in ('open','received','cancelled')),
  updated_at     timestamptz not null default now()
);

create table if not exists demand_forecast (
  sku            text not null references skus(sku) on delete cascade,
  week_start     date not null,                 -- Sunday, same convention as the KPI tracker
  run_date       date not null,
  p50_units      numeric not null,
  p80_units      numeric,
  model          text,                          -- ETS / SARIMA / LightGBM / Chronos / rule
  wape           numeric,
  bias           numeric,
  primary key (sku, week_start, run_date)
);

-- ----------------------------------------------------------------------------
-- 3) CM3 COST STACK (from Y4A_CM3_by_Lane V9.8 HTML). Sensitive: FOB/duty.
--    The dashboard should read the view below, never the raw table.
-- ----------------------------------------------------------------------------
create table if not exists cm3_cost_stack (
  sku            text primary key,
  asin           text,
  product_line   text,
  lane           text,                          -- current lane: DI / DS / SPT
  fob            numeric,
  duty           numeric,
  weight_lb      numeric,
  cbm            numeric,
  rev_di         numeric,
  rev_ds         numeric,
  rev_spt        numeric,
  cost_stack_ok  boolean default false,
  source_version text,                          -- e.g. 'V9.8 · v7.3 LIVE Sep15 2026'
  updated_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4) WEEKLY REVIEW (replaces Excel tabs Week 1–4)
--    review_weeks.snapshot is written once by a cron on Monday 06:00 and never
--    recomputed, so the numbers PIC comment on stay fixed.
-- ----------------------------------------------------------------------------
create table if not exists review_weeks (
  week_start     date primary key,              -- Sunday
  week_end       date not null,                 -- Saturday
  snapshot_at    timestamptz,                   -- null until the cron freezes it
  due_at         timestamptz not null,          -- PIC deadline (default Tue 12:00 ICT)
  snapshot       jsonb                          -- per Main PL: gmv, units, wow, target_week, ads, promo, mkt_gmv ...
);

create table if not exists weekly_reviews (
  id             uuid primary key default gen_random_uuid(),
  week_start     date not null references review_weeks(week_start) on delete cascade,
  main_pl        text not null,
  owner          text,
  status         text check (status in ('Đạt tiến độ','Cần chú ý','Chậm tiến độ')),
  issue_text     text,
  action_text    text,
  is_late        boolean not null default false,   -- saved after due_at at least once
  updated_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  unique (week_start, main_pl)
);

-- every save appends one version; nothing is overwritten
create table if not exists weekly_review_versions (
  id             bigint generated always as identity primary key,
  review_id      uuid not null references weekly_reviews(id) on delete cascade,
  issue_text     text,
  action_text    text,
  status         text,
  is_late        boolean not null,
  saved_by       uuid default auth.uid(),
  saved_at       timestamptz not null default now()
);

-- parsed on save (keyword rules now; Claude API via Edge Function later)
create table if not exists review_issues (
  id             bigint generated always as identity primary key,
  review_id      uuid not null references weekly_reviews(id) on delete cascade,
  week_start     date not null,
  main_pl        text not null,
  code           text not null check (code in ('INV','LIS','PRC','MKT','Others')),
  text           text not null,
  skus           text[] default '{}'
);

create table if not exists review_actions (
  id             bigint generated always as identity primary key,
  review_id      uuid not null references weekly_reviews(id) on delete cascade,
  week_start     date not null,
  main_pl        text not null,
  owner          text,
  text           text not null,
  due_date       date not null,
  due_from_text  boolean not null default false,  -- false = default "Saturday next week"
  skus           text[] default '{}',
  status         text not null default 'Open' check (status in ('Open','Done','Cancel')),
  done_at        timestamptz
);

-- late flag (BEFORE) + one version row per save (AFTER, so the FK target exists)
create or replace function trg_weekly_review_late() returns trigger language plpgsql as $$
declare v_due timestamptz;
begin
  select due_at into v_due from review_weeks where week_start = new.week_start;
  new.is_late := (tg_op = 'UPDATE' and old.is_late) or (v_due is not null and now() > v_due);
  new.updated_at := now();
  return new;
end $$;

create or replace function trg_weekly_review_version() returns trigger language plpgsql as $$
declare v_due timestamptz;
begin
  select due_at into v_due from review_weeks where week_start = new.week_start;
  insert into weekly_review_versions(review_id, issue_text, action_text, status, is_late)
  values (new.id, new.issue_text, new.action_text, new.status, v_due is not null and now() > v_due);
  return null;
end $$;

drop trigger if exists weekly_review_late on weekly_reviews;
create trigger weekly_review_late before insert or update on weekly_reviews
  for each row execute function trg_weekly_review_late();
drop trigger if exists weekly_review_version on weekly_reviews;
create trigger weekly_review_version after insert or update on weekly_reviews
  for each row execute function trg_weekly_review_version();

-- ----------------------------------------------------------------------------
-- 5) MARKET (Helium 10 Xray / SmartScout / Keepa exports)
-- ----------------------------------------------------------------------------
create table if not exists market_brand_monthly (
  category       text not null,
  month          date not null,
  brand          text not null,
  revenue        numeric,
  units          numeric,
  avg_price      numeric,
  share          numeric,                        -- revenue share within category
  source         text,
  primary key (category, month, brand)
);

create table if not exists market_asin_snapshot (
  asin           text not null,
  snapshot_month date not null,
  category       text,
  brand          text,
  title          text,
  variation_weight text,
  variation_color  text,
  variation_size   text,
  price          numeric,
  units          numeric,
  revenue        numeric,
  bsr            integer,
  reviews        integer,
  rating         numeric,
  is_y4a         boolean default false,
  source         text,
  primary key (asin, snapshot_month)
);

-- ----------------------------------------------------------------------------
-- RLS: authenticated read on everything new; authenticated write only on the
-- review tables. Ingestion keeps using service_role (bypasses RLS).
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sales_monthly','inventory_snapshot','incoming_po','demand_forecast','cm3_cost_stack',
                           'review_weeks','weekly_reviews','weekly_review_versions','review_issues','review_actions',
                           'market_brand_monthly','market_asin_snapshot'] loop
    execute format('alter table %I enable row level security', t);
    if t <> 'cm3_cost_stack' then
      execute format('create policy "auth read %1$s" on %1$I for select to authenticated using (true)', t);
    end if;
  end loop;
  foreach t in array array['weekly_reviews','review_issues','review_actions'] loop
    execute format('create policy "auth insert %1$s" on %1$I for insert to authenticated with check (true)', t);
    execute format('create policy "auth update %1$s" on %1$I for update to authenticated using (true)', t);
  end loop;
end $$;

-- CM3 per SKU without exposing FOB/duty
create or replace view cm3_sku_summary with (security_invoker = false) as
  select sku, product_line, lane, cost_stack_ok, source_version
  from cm3_cost_stack;
grant select on cm3_sku_summary to authenticated;

create index if not exists idx_sales_monthly_month on sales_monthly(month);
create index if not exists idx_incoming_eta on incoming_po(eta_date);
create index if not exists idx_forecast_week on demand_forecast(week_start);
create index if not exists idx_review_actions_due on review_actions(due_date) where status = 'Open';
create index if not exists idx_market_asin_cat on market_asin_snapshot(category, snapshot_month);
