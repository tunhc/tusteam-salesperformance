-- ============================================================================
-- YES4ALL SALES DASHBOARD — SUPABASE SCHEMA
-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) SKUS — master identity (PIC / Main PL / Sub PL / inventory / channel...)
--    Written by the ingestion script (upsert_skus) whenever the "Amazon Follow
--    up" or Final Target files are refreshed. Read-only from the dashboard.
-- ----------------------------------------------------------------------------
create table if not exists skus (
  sku            text primary key,
  product_name   text,
  pic            text,
  main_pl        text,
  sub_pl         text,
  lifecycle      text,
  selling_type   text,
  asin_status    text,
  salable_y4a    numeric default 0,
  salable_amz    numeric default 0,
  channel        text,
  portfolio      text,
  priority       text,
  moc            numeric,
  moc_band       text,
  rrp            numeric default 0,
  updated_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2) TARGETS_MONTHLY — one row per SKU per calendar month.
--    "month" is always stored as the 1st day of that month (e.g. 2026-08-01).
-- ----------------------------------------------------------------------------
create table if not exists targets_monthly (
  id             bigint generated always as identity primary key,
  sku            text not null references skus(sku) on delete cascade,
  month          date not null,
  target_units   numeric default 0,
  target_gmv     numeric default 0,
  ads_target     numeric default 0,
  promo_target   numeric default 0,
  updated_at     timestamptz not null default now(),
  unique (sku, month)
);

-- ----------------------------------------------------------------------------
-- 3) SALES_DAILY — one row per SKU per calendar day, upserted from whatever
--    Excel extract (hourly/daily SSO export) Rachel sends next. Re-uploading
--    a file that overlaps existing dates just overwrites those rows (upsert
--    on sku+date), so it's always safe to re-send a file.
-- ----------------------------------------------------------------------------
create table if not exists sales_daily (
  id             bigint generated always as identity primary key,
  sku            text not null references skus(sku) on delete cascade,
  date           date not null,
  units          numeric default 0,
  gmv            numeric default 0,
  ads            numeric default 0,
  promo          numeric default 0,
  ads_gmv        numeric default 0,  -- sb_ordered_nmv + sd_ordered_nmv + sp_ordered_nmv (Ads Performance tab)
  ads_units      numeric default 0,  -- sb_ordered_units + sd_ordered_units + sp_ordered_units (Ads Performance tab)
  category       text,
  source_file    text,
  ingested_at    timestamptz not null default now(),
  unique (sku, date)
);

-- ----------------------------------------------------------------------------
-- 4) PRODUCT DIARY — action plans per product group (Main PL), with a code
--    (INV/LIS/PRC/MKT/Others), a status, and optional follow-up notes.
--    Written directly by the dashboard using the anon key.
-- ----------------------------------------------------------------------------
create table if not exists diary_entries (
  id             uuid primary key default gen_random_uuid(),
  main_pl        text not null,
  code           text not null check (code in ('INV','LIS','PRC','MKT','Others')),
  pic            text,
  note           text not null,
  status         text not null default 'Open' check (status in ('Open','Done','Issue','Cancel')),
  entry_date     date not null default current_date,
  created_at     timestamptz not null default now()
);

create table if not exists diary_followups (
  id             uuid primary key default gen_random_uuid(),
  entry_id       uuid not null references diary_entries(id) on delete cascade,
  followup_date  date not null default current_date,
  text           text not null,
  created_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5) PROJECTS — free-form project log, 3-column view (Project | Progress |
--    Issues) built by grouping project_log rows by project_id + log_type.
--    Written directly by the dashboard using the anon key.
-- ----------------------------------------------------------------------------
create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  created_at     timestamptz not null default now()
);

create table if not exists project_log (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  log_type       text not null check (log_type in ('progress','issues')),
  log_date       date not null default current_date,
  text           text not null,
  created_at     timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Design: anon key (public, lives in the dashboard HTML) can only READ the
-- sales/target/sku data, and can READ+WRITE the diary/project tables (that's
-- the whole point of those two tabs). Only the service_role key — used by the
-- Python ingestion script, kept secret, NEVER put in the dashboard or GitHub —
-- can write skus / targets_monthly / sales_daily, because service_role
-- bypasses RLS entirely. That way even if the anon key leaks, the worst case
-- is someone can add junk diary/project notes, not corrupt real sales data.
-- ============================================================================

alter table skus enable row level security;
alter table targets_monthly enable row level security;
alter table sales_daily enable row level security;
alter table diary_entries enable row level security;
alter table diary_followups enable row level security;
alter table projects enable row level security;
alter table project_log enable row level security;

-- Public read-only on the data tables (dashboard needs this to show numbers)
create policy "public read skus" on skus for select using (true);
create policy "public read targets_monthly" on targets_monthly for select using (true);
create policy "public read sales_daily" on sales_daily for select using (true);

-- Public read + write on diary/project tables (dashboard needs this for the
-- Product Diary and Projects tabs to actually save)
create policy "public read diary_entries" on diary_entries for select using (true);
create policy "public write diary_entries" on diary_entries for insert with check (true);
create policy "public update diary_entries" on diary_entries for update using (true);

create policy "public read diary_followups" on diary_followups for select using (true);
create policy "public write diary_followups" on diary_followups for insert with check (true);

create policy "public read projects" on projects for select using (true);
create policy "public write projects" on projects for insert with check (true);

create policy "public read project_log" on project_log for select using (true);
create policy "public write project_log" on project_log for insert with check (true);

-- Helpful indexes
create index if not exists idx_sales_daily_date on sales_daily(date);
create index if not exists idx_sales_daily_sku on sales_daily(sku);
create index if not exists idx_targets_month on targets_monthly(month);
create index if not exists idx_diary_mainpl on diary_entries(main_pl);
create index if not exists idx_project_log_project on project_log(project_id);
