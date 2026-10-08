-- ============================================================================
-- BTR Tracking (Amazon Born To Run). Run once in the SQL Editor (safe to re-run).
--   btr_offers        one row per BTR offer (ASIN), from "Born-to-run Alert - SSO.xlsx"
--   asin_inventory    salable inventory per SKU × ASIN, from "Yes4All_US_Inventory_<date>.xlsx" (sheet report)
--   sales_asin_daily  sales per ASIN per day, written by pull-hourly from the hourly export (product_id)
-- The dashboard adds sales_asin_daily after btr_offers.as_of to Amazon's sold quantity,
-- so the BTR tab keeps moving between two alert files.
-- ============================================================================

create table if not exists btr_offers (
  offer_id         text primary key,
  asin             text not null,
  sku              text,
  pic              text,               -- Sales PIC in the alert file
  product_title    text,
  offer_name       text,
  offer_state      text,
  status           text,
  st_start         date not null,      -- sell-through start
  st_end           date not null,      -- sell-through end
  as_of            date not null,      -- last day covered by sold_qty (st_end - Days Remaining)
  submitted_qty    numeric,
  accepted_qty     numeric,
  vendor_resp_qty  numeric,            -- units the retention fee applies to
  product_cost     numeric,
  sold_qty         numeric,            -- Amazon's sold quantity up to as_of
  est_sold_end     numeric,            -- Amazon's "Est. Qty Sold by ST End"
  est_retention    numeric,            -- Amazon's "Est. Retention End"
  retention_rate   numeric,            -- est_retention ÷ ((vendor_resp_qty - est_sold_end) × product_cost)
  ad_spend         numeric,            -- ST window, up to as_of
  promo_spend      numeric,
  alert_level      text,
  action_code      text,
  link             text,
  file_updated_at  timestamp,
  loaded_at        timestamptz not null default now()
);
create index if not exists idx_btr_offers_asin on btr_offers(asin);

create table if not exists asin_inventory (
  sku           text not null,
  asin          text not null,
  asin_status   text,
  dep           text,
  salable_y4a   numeric,               -- per SKU (repeated on every ASIN row of the SKU)
  salable_amz   numeric,               -- per ASIN
  incoming_y4a  numeric,
  incoming_amz  numeric,
  snapshot_at   timestamp,
  primary key (sku, asin)
);

create table if not exists sales_asin_daily (
  asin          text not null,
  date          date not null,
  sku           text,
  units         numeric not null default 0,
  gmv           numeric not null default 0,
  ads           numeric not null default 0,
  promo         numeric not null default 0,
  glance_views  numeric not null default 0,
  source_file   text,
  primary key (asin, date)
);
create index if not exists idx_sales_asin_daily_date on sales_asin_daily(date);

do $$ declare t text; begin
  foreach t in array array['btr_offers','asin_inventory','sales_asin_daily'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %s" on %I', t, t);
    execute format('create policy "public read %s" on %I for select using (true)', t, t);
    begin execute format('grant select on %I to ai_reader', t); exception when undefined_object then null; end;
  end loop;
end $$;

-- Replace whole days of ASIN sales in one transaction (pull-hourly, service role only).
create or replace function replace_sales_asin_days(p_rows jsonb, p_source text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_days date[]; v_n int;
begin
  select array_agg(distinct (r->>'date')::date) into v_days from jsonb_array_elements(p_rows) r;
  if v_days is null then return 0; end if;
  delete from sales_asin_daily where date = any(v_days);
  insert into sales_asin_daily (asin, date, sku, units, gmv, ads, promo, glance_views, source_file)
  select r->>'asin', (r->>'date')::date, r->>'sku',
         coalesce((r->>'units')::numeric, 0), coalesce((r->>'gmv')::numeric, 0), coalesce((r->>'ads')::numeric, 0),
         coalesce((r->>'promo')::numeric, 0), coalesce((r->>'glance_views')::numeric, 0), p_source
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'asin', '') <> ''
  on conflict (asin, date) do update set sku = excluded.sku, units = excluded.units, gmv = excluded.gmv, ads = excluded.ads,
    promo = excluded.promo, glance_views = excluded.glance_views, source_file = excluded.source_file;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function replace_sales_asin_days(jsonb, text) from public;
do $$ begin
  revoke all on function replace_sales_asin_days(jsonb, text) from anon, authenticated;
  grant execute on function replace_sales_asin_days(jsonb, text) to service_role;
exception when undefined_object then null; end $$;
