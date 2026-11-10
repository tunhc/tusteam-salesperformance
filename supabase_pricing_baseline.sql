-- ============================================================================
-- Price check + forecast baseline (safe to re-run)
--
--   price_reference      "RRP tham chiếu" (column U) per SKU from Yes4All_Optimal_Pricing_SKU.xlsx,
--                        the fixed price the Issue monitor compares against
--   keepa_prices         current Buy Box price per ASIN from the Keepa export (US_Keepa_Raw_Auto.xlsx:
--                        column E = ASIN, column Z = "Buy Box: Current"); loaded by pull-inventory
--   forecast_baseline_*  the inventory file used when the month's target was built
--                        (e.g. Yes4All_US_Inventory_10282026.xlsx for Nov-2026): stock per SKU and
--                        incoming per week; Tracking Target compares today's supply with it
-- ============================================================================
create table if not exists price_reference (
  sku          text primary key,
  asin         text,
  pic          text,
  rrp_ref      numeric,          -- column U "RRP tham chiếu"
  rrp_low      numeric,
  rrp_high     numeric,
  asp_optimal  numeric,
  source       text,
  loaded_at    timestamptz not null default now()
);

create table if not exists keepa_prices (
  asin             text primary key,
  sku              text,
  buybox_current   numeric,      -- column Z "Buy Box: Current"
  buybox_30d       numeric,
  buybox_90d       numeric,
  buybox_seller    text,
  amazon_current   numeric,
  new_current      numeric,
  sales_rank       numeric,
  rating           numeric,
  rating_count     numeric,
  keepa_updated_at timestamp,    -- "Last update" of the row in the Keepa export
  file_refreshed   text,         -- "Page refreshed at …" of the export
  loaded_at        timestamptz not null default now()
);
create index if not exists idx_keepa_prices_sku on keepa_prices(sku);

create table if not exists forecast_baseline_inventory (
  month        date not null,    -- target month (first day)
  sku          text not null,
  salable_y4a  numeric default 0,
  salable_amz  numeric default 0,
  as_of        timestamp,
  source       text,
  primary key (month, sku)
);
create table if not exists forecast_baseline_incoming (
  month        date not null,
  sku          text not null,
  week_start   date not null,    -- Sunday
  qty_y4a      numeric default 0,
  qty_amz      numeric default 0,
  primary key (month, sku, week_start)
);

do $$ declare t text; begin
  foreach t in array array['price_reference','keepa_prices','forecast_baseline_inventory','forecast_baseline_incoming'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %1$s" on %1$I', t);
    execute format('create policy "public read %1$s" on %1$I for select using (true)', t);
  end loop;
end $$;

-- Writers, called by the pull-inventory Edge Function (service role only)
create or replace function replace_keepa_prices(p_rows jsonb, p_source text default null, p_hash text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from keepa_prices where true;
  insert into keepa_prices (asin, sku, buybox_current, buybox_30d, buybox_90d, buybox_seller, amazon_current, new_current,
                            sales_rank, rating, rating_count, keepa_updated_at, file_refreshed)
  select distinct on (asin) asin, sku, buybox_current, buybox_30d, buybox_90d, buybox_seller, amazon_current, new_current,
         sales_rank, rating, rating_count, keepa_updated_at, file_refreshed
  from jsonb_to_recordset(p_rows) as r(asin text, sku text, buybox_current numeric, buybox_30d numeric, buybox_90d numeric, buybox_seller text,
       amazon_current numeric, new_current numeric, sales_rank numeric, rating numeric, rating_count numeric, keepa_updated_at timestamp, file_refreshed text)
  where asin is not null order by asin, keepa_updated_at desc nulls last;
  get diagnostics n = row_count;
  insert into ingest_runs (source, status, file_hash, rows_in, rows_loaded, message)
  values (coalesce(p_source, 'keepa'), 'ok', p_hash, jsonb_array_length(p_rows), n, format('keepa: %s ASIN', n));
  return n;
end $$;

create or replace function replace_price_reference(p_rows jsonb, p_source text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from price_reference where true;
  insert into price_reference (sku, asin, pic, rrp_ref, rrp_low, rrp_high, asp_optimal, source)
  select distinct on (sku) sku, asin, pic, rrp_ref, rrp_low, rrp_high, asp_optimal, p_source
  from jsonb_to_recordset(p_rows) as r(sku text, asin text, pic text, rrp_ref numeric, rrp_low numeric, rrp_high numeric, asp_optimal numeric)
  where sku is not null order by sku;
  get diagnostics n = row_count;
  insert into ingest_runs (source, status, rows_in, rows_loaded, message)
  values (coalesce(p_source, 'pricing'), 'ok', jsonb_array_length(p_rows), n, format('price_reference: %s SKU', n));
  return n;
end $$;

create or replace function set_forecast_baseline(p_month date, p_skus jsonb, p_incoming jsonb, p_as_of timestamp default null, p_source text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int;
begin
  delete from forecast_baseline_inventory where month = p_month;
  delete from forecast_baseline_incoming where month = p_month;
  insert into forecast_baseline_inventory (month, sku, salable_y4a, salable_amz, as_of, source)
  select p_month, sku, coalesce(salable_y4a, 0), coalesce(salable_amz, 0), p_as_of, p_source
  from jsonb_to_recordset(p_skus) as r(sku text, salable_y4a numeric, salable_amz numeric) where sku is not null
  on conflict (month, sku) do update set salable_y4a = excluded.salable_y4a, salable_amz = excluded.salable_amz;
  get diagnostics a = row_count;
  insert into forecast_baseline_incoming (month, sku, week_start, qty_y4a, qty_amz)
  select p_month, sku, week_start, sum(coalesce(qty_y4a, 0)), sum(coalesce(qty_amz, 0))
  from jsonb_to_recordset(p_incoming) as r(sku text, week_start date, qty_y4a numeric, qty_amz numeric) where sku is not null
  group by sku, week_start;
  get diagnostics b = row_count;
  insert into ingest_runs (source, status, rows_in, rows_loaded, message)
  values (coalesce(p_source, 'forecast baseline'), 'ok', a + b, a, format('forecast baseline %s: %s SKU, %s dòng incoming', p_month, a, b));
  return jsonb_build_object('month', p_month, 'skus', a, 'incoming_rows', b);
end $$;

revoke execute on function replace_keepa_prices(jsonb, text, text) from public, anon, authenticated;
revoke execute on function replace_price_reference(jsonb, text) from public, anon, authenticated;
revoke execute on function set_forecast_baseline(date, jsonb, jsonb, timestamp, text) from public, anon, authenticated;
grant execute on function replace_keepa_prices(jsonb, text, text) to service_role;
grant execute on function replace_price_reference(jsonb, text) to service_role;
grant execute on function set_forecast_baseline(date, jsonb, jsonb, timestamp, text) to service_role;

-- months that have a baseline, for the picker on Tracking Target
create or replace function forecast_baseline_months()
returns table (month date, as_of timestamp, source text, skus bigint)
language sql stable as $$
  select month, max(as_of), max(source), count(*) from forecast_baseline_inventory group by month order by month desc
$$;
grant execute on function forecast_baseline_months() to anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['price_reference','keepa_prices','forecast_baseline_inventory','forecast_baseline_incoming'] loop
    execute format('grant select on %I to ai_reader', t);
  end loop;
exception when undefined_object then null; end $$;

-- inventory snapshots that can serve as a baseline (picker on Tracking Target)
create or replace function inventory_snapshot_dates()
returns table (snapshot_date date, has_incoming boolean)
language sql stable as $$
  select s.d, exists (select 1 from incoming_weekly w where w.snapshot_date = s.d)
  from (select distinct snapshot_date d from inventory_snapshot) s order by 1 desc
$$;
grant execute on function inventory_snapshot_dates() to anon, authenticated;
