-- ============================================================================
-- Auto ingest of the "Yes4All_US_Inventory" Excel (sheet report) — Edge Function pull-inventory
-- Stock (salable Y4A + AMZ) and weekly incoming (Y4A + AMZ), once a day.
-- Run once in the SQL Editor after supabase_auto_ingest.sql (needs ingest_runs). Safe to re-run.
-- Schedule: see step 2 at the end.
-- ============================================================================

-- 1) Replace one day's inventory snapshot in one transaction:
--    inventory_snapshot  upsert (sku, snapshot_date)       → history: one row per SKU per day
--    skus                salable_y4a / salable_amz / asin_status / inventory_as_of (what the dashboard shows)
--    incoming_weekly     rows of snapshot_date replaced; snapshots older than 90 days pruned
--    asin_inventory      replaced (BTR tab), only if supabase_btr.sql has been run
-- Only SKUs already in skus are written (same rule as pull-hourly); SKUs missing
-- from the file keep their last numbers.
create or replace function replace_inventory_snapshot(
  p_date date, p_skus jsonb, p_incoming jsonb, p_asins jsonb default '[]'::jsonb,
  p_source text default null, p_hash text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_skus int; v_inc int; v_asins int := null;
begin
  insert into inventory_snapshot (sku, snapshot_date, salable_y4a, salable_amz)
  select r->>'sku', p_date, coalesce((r->>'salable_y4a')::numeric, 0), coalesce((r->>'salable_amz')::numeric, 0)
  from jsonb_array_elements(p_skus) r
  where exists (select 1 from skus s where s.sku = r->>'sku')
  on conflict (sku, snapshot_date) do update set salable_y4a = excluded.salable_y4a, salable_amz = excluded.salable_amz;

  update skus s set salable_y4a = coalesce((r->>'salable_y4a')::numeric, 0),
                    salable_amz = coalesce((r->>'salable_amz')::numeric, 0),
                    asin_status = coalesce(r->>'asin_status', s.asin_status),
                    inventory_as_of = p_date
  from jsonb_array_elements(p_skus) r
  where s.sku = r->>'sku';
  get diagnostics v_skus = row_count;

  delete from incoming_weekly where snapshot_date = p_date or snapshot_date < p_date - 90;
  insert into incoming_weekly (sku, week_start, qty_y4a, qty_amz, snapshot_date)
  select r->>'sku', (r->>'week_start')::date, coalesce((r->>'qty_y4a')::numeric, 0), coalesce((r->>'qty_amz')::numeric, 0), p_date
  from jsonb_array_elements(p_incoming) r
  where exists (select 1 from skus s where s.sku = r->>'sku')
  on conflict (sku, week_start, snapshot_date) do update set qty_y4a = excluded.qty_y4a, qty_amz = excluded.qty_amz;
  get diagnostics v_inc = row_count;

  if to_regclass('public.asin_inventory') is not null and jsonb_array_length(p_asins) > 0 then
    delete from asin_inventory where true;
    insert into asin_inventory (sku, asin, asin_status, dep, salable_y4a, salable_amz, incoming_y4a, incoming_amz, snapshot_at)
    select r->>'sku', r->>'asin', r->>'asin_status', r->>'dep',
           (r->>'salable_y4a')::numeric, (r->>'salable_amz')::numeric, (r->>'incoming_y4a')::numeric, (r->>'incoming_amz')::numeric,
           (r->>'snapshot_at')::timestamp
    from jsonb_array_elements(p_asins) r
    on conflict (sku, asin) do nothing;
    get diagnostics v_asins = row_count;
  end if;

  insert into ingest_runs(source, status, file_hash, days, rows_in, rows_loaded, message)
  values (p_source, 'ok', p_hash, array[p_date], jsonb_array_length(p_skus), v_skus,
          format('inventory %s: %s SKU, %s dòng incoming, asin_inventory %s', p_date, v_skus, v_inc, coalesce(v_asins::text, 'bỏ qua')));
  return jsonb_build_object('snapshot_date', p_date, 'skus', v_skus, 'incoming_rows', v_inc, 'asin_rows', v_asins);
end $$;
revoke all on function replace_inventory_snapshot(date, jsonb, jsonb, jsonb, text, text) from public;
do $$ begin
  revoke all on function replace_inventory_snapshot(date, jsonb, jsonb, jsonb, text, text) from anon, authenticated;
  grant execute on function replace_inventory_snapshot(date, jsonb, jsonb, jsonb, text, text) to service_role;
exception when undefined_object then null; end $$;

-- 2) Daily schedule (run AFTER deploying the Edge Function and setting its secrets).
--    Needs pg_net + pg_cron (Database → Extensions). Replace <PULL_SECRET> with the
--    Edge Function's PULL_SECRET. Times are UTC: '15 0 * * *' = 07:15 Vietnam time, every day.
--
--   select vault.create_secret('<PULL_SECRET>', 'pull_inventory_secret');
--   select cron.schedule('pull-inventory', '15 0 * * *', $job$
--     select net.http_post(
--       url := 'https://zlksfonvnxqxdumwlysf.supabase.co/functions/v1/pull-inventory',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--         'x-pull-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pull_inventory_secret')),
--       body := '{}'::jsonb, timeout_milliseconds := 120000)
--   $job$);
--
--   -- more often (the file updates hourly; an unchanged file is skipped): '25 */4 * * *' = every 4 hours
--   -- stop:    select cron.unschedule('pull-inventory');
--   -- check:   select * from ingest_runs where source like 'auto: inventory%' order by ran_at desc limit 20;
--   -- history: select snapshot_date, sum(salable_y4a), sum(salable_amz) from inventory_snapshot group by 1 order by 1 desc;
--
--    Link that needs a Microsoft login (SharePoint of the company)? Use Power Automate instead of pg_cron:
--    Recurrence (1 day) → SharePoint "Get file content using path" → HTTP POST to the function URL,
--    headers x-pull-secret / x-file-name, Body = body('Get_file_content_using_path')?['$content'].
