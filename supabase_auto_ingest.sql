-- ============================================================================
-- Auto ingest of the "SSO Data Extraction Hourly" Excel (Edge Function pull-hourly)
-- Run once in the SQL Editor (safe to re-run). Schedule: see step 3 at the end.
-- ============================================================================

-- 1) Run log: one row per pull, shown on the dashboard and used to skip
--    a file that has not changed since the last successful load.
create table if not exists ingest_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  source      text,
  status      text not null,            -- ok | skipped | error
  file_hash   text,
  days        date[],
  rows_in     int,
  rows_loaded int,
  gmv         numeric,
  message     text
);
create index if not exists idx_ingest_runs_ran on ingest_runs(ran_at desc);
alter table ingest_runs enable row level security;
drop policy if exists "public read ingest_runs" on ingest_runs;
create policy "public read ingest_runs" on ingest_runs for select using (true);

-- 2) Replace whole days in one transaction: every row of the days present in
--    p_rows is deleted, then p_rows is inserted. Days before data_locks.lock_before
--    stay untouched (the lock trigger skips them).
create or replace function replace_sales_days(p_rows jsonb, p_source text default null, p_hash text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_days date[];
  v_n int;
  v_gmv numeric;
begin
  select array_agg(distinct (r->>'date')::date order by (r->>'date')::date) into v_days from jsonb_array_elements(p_rows) r;
  if v_days is null then
    insert into ingest_runs(source, status, file_hash, rows_in, rows_loaded, message) values (p_source, 'skipped', p_hash, 0, 0, 'no rows for managed SKUs');
    return jsonb_build_object('days', '[]'::jsonb, 'rows', 0);
  end if;
  delete from sales_daily where date = any(v_days);
  insert into sales_daily (sku, date, units, gmv, ordered_nmv, ads, promo, ads_gmv, ads_units, total_clicks, total_impressions,
                           glance_views, ordered_revenue, sp_spend, sb_spend, sd_spend, dsp_spend, aff_spend,
                           promo_deal, promo_coupon, promo_discount, category, source_file)
  select r->>'sku', (r->>'date')::date,
         coalesce((r->>'units')::numeric, 0), coalesce((r->>'gmv')::numeric, 0), coalesce((r->>'ordered_nmv')::numeric, 0),
         coalesce((r->>'ads')::numeric, 0), coalesce((r->>'promo')::numeric, 0), coalesce((r->>'ads_gmv')::numeric, 0),
         coalesce((r->>'ads_units')::numeric, 0), coalesce((r->>'total_clicks')::numeric, 0), coalesce((r->>'total_impressions')::numeric, 0),
         coalesce((r->>'glance_views')::numeric, 0), 0, coalesce((r->>'sp_spend')::numeric, 0), coalesce((r->>'sb_spend')::numeric, 0), coalesce((r->>'sd_spend')::numeric, 0), 0, 0,
         coalesce((r->>'promo_deal')::numeric, 0), coalesce((r->>'promo_coupon')::numeric, 0), coalesce((r->>'promo_discount')::numeric, 0),
         coalesce(r->>'category', (select s.category from skus s where s.sku = r->>'sku')), coalesce(r->>'source_file', p_source)
  from jsonb_array_elements(p_rows) r
  where exists (select 1 from skus s where s.sku = r->>'sku')
  on conflict (sku, date) do update set
    units = excluded.units, gmv = excluded.gmv, ordered_nmv = excluded.ordered_nmv, ads = excluded.ads, promo = excluded.promo,
    ads_gmv = excluded.ads_gmv, ads_units = excluded.ads_units, total_clicks = excluded.total_clicks, total_impressions = excluded.total_impressions, glance_views = excluded.glance_views,
    sp_spend = excluded.sp_spend, sb_spend = excluded.sb_spend, sd_spend = excluded.sd_spend,
    promo_deal = excluded.promo_deal, promo_coupon = excluded.promo_coupon, promo_discount = excluded.promo_discount,
    category = excluded.category, source_file = excluded.source_file;
  get diagnostics v_n = row_count;
  select sum((r->>'gmv')::numeric) into v_gmv from jsonb_array_elements(p_rows) r;
  insert into ingest_runs(source, status, file_hash, days, rows_in, rows_loaded, gmv)
  values (p_source, 'ok', p_hash, v_days, jsonb_array_length(p_rows), v_n, v_gmv);
  return jsonb_build_object('days', to_jsonb(v_days), 'rows', v_n, 'gmv', v_gmv);
end $$;
revoke all on function replace_sales_days(jsonb, text, text) from public;
do $$ begin
  revoke all on function replace_sales_days(jsonb, text, text) from anon, authenticated;
  grant execute on function replace_sales_days(jsonb, text, text) to service_role;
exception when undefined_object then null; end $$;

-- 3) Hourly schedule (run AFTER deploying the Edge Function and setting its
--    PULL_SECRET). Enable pg_net first: Database → Extensions → pg_net.
--    Replace <PULL_SECRET> with the same value as the Edge Function secret:
--
--   select vault.create_secret('<PULL_SECRET>', 'pull_hourly_secret');
--   select cron.schedule('pull-hourly', '7 * * * *', $job$
--     select net.http_post(
--       url := 'https://zlksfonvnxqxdumwlysf.supabase.co/functions/v1/pull-hourly',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--         'x-pull-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pull_hourly_secret')),
--       body := '{}'::jsonb, timeout_milliseconds := 120000)
--   $job$);
--
--   -- stop: select cron.unschedule('pull-hourly');
--   -- check: select * from ingest_runs order by ran_at desc limit 20;
