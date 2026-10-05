-- ============================================================================
-- YES4ALL SALES DASHBOARD — SCHEMA V2
-- Run once in Supabase → SQL Editor, after supabase_schema.sql. Safe to re-run.
-- Adds: extra sales columns + history lock, inventory/incoming/forecast,
-- weekly review (snapshot, notes, versions, actions), AI recommendation cache,
-- market research tables and aggregate RPCs used by index.html.
--
-- Access model is the same as v1: anon can READ data tables and READ/WRITE
-- the collaboration tables (reviews, actions, AI cache). Only service_role /
-- SQL Editor can write sales, targets, inventory and market data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Extra columns
-- ----------------------------------------------------------------------------
alter table skus add column if not exists category text;
alter table skus add column if not exists block_ads text;
alter table skus add column if not exists labels text;
alter table skus add column if not exists war_plan text;
alter table skus add column if not exists po_treatment text;
alter table skus add column if not exists normal_asp numeric;
alter table skus add column if not exists inventory_as_of date;
alter table skus add column if not exists cm3_unit_base numeric;   -- CM3 per unit before Ads/Promo (V9.8 cost stack)
alter table skus add column if not exists cm3_lane text;
alter table skus add column if not exists cm3_source text;

alter table sales_daily add column if not exists glance_views numeric default 0;
alter table sales_daily add column if not exists ordered_revenue numeric default 0;
alter table sales_daily add column if not exists ordered_nmv numeric default 0;
alter table sales_daily add column if not exists sp_spend numeric default 0;
alter table sales_daily add column if not exists sb_spend numeric default 0;
alter table sales_daily add column if not exists sd_spend numeric default 0;
alter table sales_daily add column if not exists dsp_spend numeric default 0;
alter table sales_daily add column if not exists aff_spend numeric default 0;
alter table sales_daily add column if not exists promo_deal numeric default 0;
alter table sales_daily add column if not exists promo_coupon numeric default 0;
alter table sales_daily add column if not exists promo_discount numeric default 0;

-- ----------------------------------------------------------------------------
-- 2) History lock: rows dated before data_locks.lock_before are read-only.
--    Writes to them are skipped silently (so the hourly sync never fails),
--    unless the session runs: select set_config('app.unlock_history','on',false);
-- ----------------------------------------------------------------------------
create table if not exists data_locks (
  table_name   text primary key,
  lock_before  date not null,
  note         text,
  updated_at   timestamptz not null default now()
);
insert into data_locks (table_name, lock_before, note)
values ('sales_daily', '2026-09-01', 'Final monthly data through Aug-2026')
on conflict (table_name) do nothing;

create or replace function trg_sales_daily_lock() returns trigger language plpgsql as $$
declare v_lock date; v_date date;
begin
  select lock_before into v_lock from data_locks where table_name = 'sales_daily';
  v_date := case when tg_op = 'DELETE' then old.date else new.date end;
  if v_lock is not null and v_date < v_lock
     and coalesce(current_setting('app.unlock_history', true), 'off') <> 'on' then
    return null;  -- skip this row
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists sales_daily_lock on sales_daily;
create trigger sales_daily_lock before insert or update or delete on sales_daily
  for each row execute function trg_sales_daily_lock();

-- ----------------------------------------------------------------------------
-- 3) Inventory, incoming, demand forecast
-- ----------------------------------------------------------------------------
create table if not exists inventory_snapshot (
  sku            text not null references skus(sku) on delete cascade,
  snapshot_date  date not null,
  salable_y4a    numeric default 0,
  salable_amz    numeric default 0,
  primary key (sku, snapshot_date)
);

create table if not exists incoming_weekly (
  sku            text not null references skus(sku) on delete cascade,
  week_start     date not null,          -- Sunday
  qty_y4a        numeric default 0,
  qty_amz        numeric default 0,
  snapshot_date  date not null,
  primary key (sku, week_start, snapshot_date)
);

create table if not exists demand_forecast_monthly (
  sku            text not null references skus(sku) on delete cascade,
  month          date not null,
  units          numeric default 0,
  gmv            numeric default 0,
  source         text,
  updated_at     timestamptz not null default now(),
  primary key (sku, month)
);

-- ----------------------------------------------------------------------------
-- 4) Weekly review
-- ----------------------------------------------------------------------------
create table if not exists review_weeks (
  week_start     date primary key,       -- Sunday
  week_end       date not null,          -- Saturday
  due_at         timestamptz not null,   -- PIC deadline
  frozen_at      timestamptz             -- null = not snapshotted yet
);

create table if not exists review_snapshot (
  week_start     date not null references review_weeks(week_start) on delete cascade,
  sku            text not null,
  units numeric, gmv numeric, ads numeric, promo numeric, ads_gmv numeric, ads_units numeric,
  clicks numeric, impressions numeric, glance_views numeric,
  prev_units numeric, prev_gmv numeric, prev_ads numeric, prev_promo numeric, prev_ads_gmv numeric,
  prev_glance_views numeric, prev_clicks numeric,
  target_units numeric, target_gmv numeric, ads_budget numeric, promo_budget numeric,
  salable_y4a numeric, salable_amz numeric, rrp numeric,
  primary key (week_start, sku)
);

create table if not exists weekly_reviews (
  id             uuid primary key default gen_random_uuid(),
  week_start     date not null,
  main_pl        text not null,
  owner          text,
  status         text,
  issue_text     text,
  action_text    text,
  is_late        boolean not null default false,
  updated_at     timestamptz not null default now(),
  unique (week_start, main_pl)
);

create table if not exists weekly_review_versions (
  id             bigint generated always as identity primary key,
  review_id      uuid not null references weekly_reviews(id) on delete cascade,
  issue_text     text,
  action_text    text,
  status         text,
  is_late        boolean not null,
  saved_at       timestamptz not null default now(),
  owner          text,
  main_pl        text,
  week_start     date
);
alter table weekly_review_versions add column if not exists owner text;
alter table weekly_review_versions add column if not exists main_pl text;
alter table weekly_review_versions add column if not exists week_start date;

create table if not exists review_actions (
  id             bigint generated always as identity primary key,
  review_id      uuid not null references weekly_reviews(id) on delete cascade,
  week_start     date not null,
  main_pl        text not null,
  owner          text,
  text           text not null,
  due_date       date not null,
  due_from_text  boolean not null default false,
  skus           text[] default '{}',
  status         text not null default 'Open' check (status in ('Open','Done','Cancel')),
  done_at        timestamptz
);

create or replace function trg_weekly_review_late() returns trigger language plpgsql as $$
declare v_due timestamptz;
begin
  new.updated_at := now();
  -- bulk import of historical notes keeps is_late as given
  if coalesce(current_setting('app.import_notes', true), 'off') = 'on' then return new; end if;
  select due_at into v_due from review_weeks where week_start = new.week_start;
  -- week row not created yet (e.g. notes entered early): default deadline = Tuesday 17:00 (VN) after the week
  if v_due is null then v_due := ((new.week_start + 9)::timestamp + time '17:00') at time zone 'Asia/Ho_Chi_Minh'; end if;
  new.is_late := (tg_op = 'UPDATE' and old.is_late) or (v_due is not null and now() > v_due);
  new.updated_at := now();
  return new;
end $$;

create or replace function trg_weekly_review_version() returns trigger language plpgsql as $$
begin
  insert into weekly_review_versions(review_id, issue_text, action_text, status, is_late, owner, main_pl, week_start)
  values (new.id, new.issue_text, new.action_text, new.status, new.is_late, new.owner, new.main_pl, new.week_start);
  return null;
end $$;

drop trigger if exists weekly_review_late on weekly_reviews;
create trigger weekly_review_late before insert or update on weekly_reviews
  for each row execute function trg_weekly_review_late();
drop trigger if exists weekly_review_version on weekly_reviews;
create trigger weekly_review_version after insert or update on weekly_reviews
  for each row execute function trg_weekly_review_version();

-- Snapshot one Sun→Sat week into review_snapshot (per SKU, with prior week and
-- a pro-rated weekly target). Re-running with p_force = true refreshes it.
create or replace function freeze_review_week(p_week_start date, p_force boolean default false,
                                              p_due_dow int default 2, p_due_time time default '17:00')
returns int language plpgsql as $$
declare v_ws date := p_week_start - extract(dow from p_week_start)::int;  -- snap to Sunday
        v_frozen timestamptz; v_n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    if p_force then raise exception 'Only an admin can re-freeze a week'; end if;
    -- the week counts as complete once any day after it has data
    if not exists (select 1 from sales_daily where date > v_ws + 6) then return 0; end if;
  end if;
  insert into review_weeks (week_start, week_end, due_at)
  values (v_ws, v_ws + 6, ((v_ws + 7 + p_due_dow)::timestamp + p_due_time) at time zone 'Asia/Ho_Chi_Minh')
  on conflict (week_start) do nothing;
  select frozen_at into v_frozen from review_weeks where week_start = v_ws;
  if v_frozen is not null and not p_force then return 0; end if;

  delete from review_snapshot where week_start = v_ws;
  with cur as (
    select sku, sum(units) units, sum(gmv) gmv, sum(ads) ads, sum(promo) promo, sum(ads_gmv) ads_gmv,
           sum(ads_units) ads_units, sum(total_clicks) clicks, sum(total_impressions) impressions, sum(glance_views) glance_views
    from sales_daily where date between v_ws and v_ws + 6 group by sku),
  prev as (
    select sku, sum(units) units, sum(gmv) gmv, sum(ads) ads, sum(promo) promo, sum(ads_gmv) ads_gmv,
           sum(glance_views) glance_views, sum(total_clicks) clicks
    from sales_daily where date between v_ws - 7 and v_ws - 1 group by sku),
  tgt as (
    select t.sku,
           sum(t.target_units / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))) target_units,
           sum(t.target_gmv   / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))) target_gmv,
           sum(t.ads_target   / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))) ads_budget,
           sum(t.promo_target / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))) promo_budget
    from generate_series(v_ws, v_ws + 6, interval '1 day') d
    join targets_monthly t on t.month = date_trunc('month', d)::date
    group by t.sku),
  keys as (select sku from cur union select sku from prev union select sku from tgt)
  insert into review_snapshot
  select v_ws, k.sku, c.units, c.gmv, c.ads, c.promo, c.ads_gmv, c.ads_units, c.clicks, c.impressions, c.glance_views,
         p.units, p.gmv, p.ads, p.promo, p.ads_gmv, p.glance_views, p.clicks,
         g.target_units, g.target_gmv, g.ads_budget, g.promo_budget,
         s.salable_y4a, s.salable_amz, s.rrp
  from keys k
  left join cur c on c.sku = k.sku left join prev p on p.sku = k.sku left join tgt g on g.sku = k.sku
  left join skus s on s.sku = k.sku;
  get diagnostics v_n = row_count;
  update review_weeks set frozen_at = now() where week_start = v_ws;
  return v_n;
end $$;

-- Every hour: freeze the last complete week as soon as data for a later day
-- exists (max date − 7 days falls in that week; already frozen weeks are skipped).
-- Needs the pg_cron extension (Database → Extensions → pg_cron). If it is not
-- enabled this block only prints a notice.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule('freeze-review-week') where exists (select 1 from cron.job where jobname = 'freeze-review-week');
  perform cron.schedule('freeze-review-week', '20 * * * *',
    $job$select freeze_review_week((select max(date) from sales_daily) - 7)$job$);
exception when others then
  raise notice 'pg_cron not available (%). Freeze weeks manually: select freeze_review_week(''2026-09-20'');', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 5) AI recommendation cache (filled by the ai-recommend Edge Function)
-- ----------------------------------------------------------------------------
create table if not exists ai_recommendations (
  id             bigint generated always as identity primary key,
  scope          text not null,          -- 'sku' | 'main_pl' | 'week'
  scope_key      text not null,          -- SKU code, PL name or week_start
  as_of          date not null,
  question       text,
  answer         text not null,
  model          text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_ai_rec_scope on ai_recommendations(scope, scope_key, as_of desc);

-- ----------------------------------------------------------------------------
-- 6) Market research
-- ----------------------------------------------------------------------------
create table if not exists market_variation (
  category text not null, attribute text, variation text not null, brand text not null,
  metric text not null check (metric in ('revenue','price')), value numeric, period text, source text,
  primary key (category, variation, brand, metric)
);
create table if not exists market_brand_monthly (
  category text not null, month date not null, brand text not null,
  revenue numeric, units numeric, avg_price numeric, source text,
  primary key (category, month, brand)
);
create table if not exists market_asin_weekly (
  category text, asin text not null, brand text, title text, week_start date not null,
  price numeric, units numeric, source text,
  primary key (asin, week_start)
);
create table if not exists market_variation_monthly (
  category text not null, attribute text not null, variation text not null, month date not null,
  value numeric, mode text not null default '', source text,
  primary key (category, attribute, variation, month, mode)
);

-- ----------------------------------------------------------------------------
-- 7) Aggregate RPCs (keep the browser from paging through 150k+ daily rows)
-- ----------------------------------------------------------------------------
-- gv_units = units on days that have glance views (the hourly export has none),
-- so CR = gv_units / glance_views is not diluted by days without GV.
-- Return types changed (gv_units added), so drop first.
drop function if exists sales_by_sku(date, date);
drop function if exists sales_trend(date, date, text, text[]);
drop function if exists sales_trend_by_sku(date, date, text, text[]);

create or replace function sales_by_sku(p_from date, p_to date)
returns table (sku text, days int, units numeric, gmv numeric, ads numeric, promo numeric, ads_gmv numeric, ads_units numeric,
               clicks numeric, impressions numeric, glance_views numeric, ordered_revenue numeric,
               sp_spend numeric, sb_spend numeric, sd_spend numeric, dsp_spend numeric,
               promo_deal numeric, promo_coupon numeric, promo_discount numeric, gv_units numeric)
language sql stable as $$
  select sku, count(*)::int, sum(units), sum(gmv), sum(ads), sum(promo), sum(ads_gmv), sum(ads_units),
         sum(total_clicks), sum(total_impressions), sum(glance_views), sum(ordered_revenue),
         sum(sp_spend), sum(sb_spend), sum(sd_spend), sum(dsp_spend),
         sum(promo_deal), sum(promo_coupon), sum(promo_discount),
         coalesce(sum(units) filter (where glance_views > 0), 0)
  from sales_daily where date between p_from and p_to group by sku
$$;

-- p_grain: 'day' | 'week' (Sunday start) | 'month'; p_skus null = all SKUs
create or replace function sales_trend(p_from date, p_to date, p_grain text default 'month', p_skus text[] default null)
returns table (period date, units numeric, gmv numeric, ads numeric, promo numeric, ads_gmv numeric, ads_units numeric,
               clicks numeric, impressions numeric, glance_views numeric, ordered_revenue numeric,
               sp_spend numeric, sb_spend numeric, sd_spend numeric, dsp_spend numeric, gv_units numeric)
language sql stable as $$
  select case p_grain when 'day' then date
                      when 'week' then date - extract(dow from date)::int
                      else date_trunc('month', date)::date end as period,
         sum(units), sum(gmv), sum(ads), sum(promo), sum(ads_gmv), sum(ads_units),
         sum(total_clicks), sum(total_impressions), sum(glance_views), sum(ordered_revenue),
         sum(sp_spend), sum(sb_spend), sum(sd_spend), sum(dsp_spend),
         coalesce(sum(units) filter (where glance_views > 0), 0)
  from sales_daily
  where date between p_from and p_to and (p_skus is null or sku = any(p_skus))
  group by 1 order by 1
$$;

-- per SKU per period, for SKU drill-downs and PL-level ads diagnostics
create or replace function sales_trend_by_sku(p_from date, p_to date, p_grain text default 'week', p_skus text[] default null)
returns table (period date, sku text, units numeric, gmv numeric, ads numeric, promo numeric, ads_gmv numeric,
               ads_units numeric, clicks numeric, impressions numeric, glance_views numeric, gv_units numeric)
language sql stable as $$
  select case p_grain when 'day' then date
                      when 'week' then date - extract(dow from date)::int
                      else date_trunc('month', date)::date end,
         sku, sum(units), sum(gmv), sum(ads), sum(promo), sum(ads_gmv), sum(ads_units),
         sum(total_clicks), sum(total_impressions), sum(glance_views),
         coalesce(sum(units) filter (where glance_views > 0), 0)
  from sales_daily
  where date between p_from and p_to and (p_skus is null or sku = any(p_skus))
  group by 1, 2 order by 1, 2
$$;

create or replace function sales_date_bounds()
returns table (min_date date, max_date date, lock_before date)
language sql stable as $$
  select min(date), max(date), (select lock_before from data_locks where table_name = 'sales_daily') from sales_daily
$$;

-- ----------------------------------------------------------------------------
-- 8) Row Level Security
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  -- read-only for the dashboard
  foreach t in array array['data_locks','inventory_snapshot','incoming_weekly','demand_forecast_monthly',
                           'review_weeks','review_snapshot','market_variation','market_brand_monthly',
                           'market_asin_weekly','market_variation_monthly'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %1$s" on %1$I', t);
    execute format('create policy "public read %1$s" on %1$I for select using (true)', t);
  end loop;
  -- read + write from the dashboard (same model as diary_entries)
  foreach t in array array['weekly_reviews','weekly_review_versions','review_actions','ai_recommendations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %1$s" on %1$I', t);
    execute format('create policy "public read %1$s" on %1$I for select using (true)', t);
    execute format('drop policy if exists "public insert %1$s" on %1$I', t);
    execute format('create policy "public insert %1$s" on %1$I for insert with check (true)', t);
    execute format('drop policy if exists "public update %1$s" on %1$I', t);
    execute format('create policy "public update %1$s" on %1$I for update using (true)', t);
  end loop;
  execute 'drop policy if exists "public delete review_actions" on review_actions';
  execute 'create policy "public delete review_actions" on review_actions for delete using (true)';
end $$;

-- the dashboard may snapshot the current week on demand
grant execute on function freeze_review_week(date, boolean, int, time) to anon, authenticated;
grant execute on function sales_by_sku(date, date) to anon, authenticated;
grant execute on function sales_trend(date, date, text, text[]) to anon, authenticated;
grant execute on function sales_trend_by_sku(date, date, text, text[]) to anon, authenticated;
grant execute on function sales_date_bounds() to anon, authenticated;
-- freeze_review_week writes review_snapshot/review_weeks, which anon cannot
-- write directly, so it runs with the owner's rights:
alter function freeze_review_week(date, boolean, int, time) security definer set search_path = public;

create index if not exists idx_sales_daily_sku_date on sales_daily(sku, date);
create index if not exists idx_incoming_week on incoming_weekly(week_start);
create index if not exists idx_review_actions_due on review_actions(due_date) where status = 'Open';
create index if not exists idx_market_asin_week on market_asin_weekly(category, week_start);
