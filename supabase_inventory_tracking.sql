-- ============================================================================
-- Inventory Tracking tab: tồn kho + incoming theo format mới
-- (file "For_Sales_Incoming_Tracker.xlsx"). Run once in the SQL Editor; safe to re-run.
--
--   incoming_detail     every incoming line of the latest file, per source:
--                       AMZ = 01_AMZ_incoming_details (hàng về kho Amazon, AVC DI / AVC WH, mọi nước)
--                       Y4A = 02_Y4A_incoming_details (hàng về kho Y4A US: BRE / NJ1)
--   incoming_eta_log    USA lines of every file loaded (log_date): ETA history per PO line,
--                       so the tab can show how often / how far an ETA moved and,
--                       once a line leaves the file, when it really arrived.
--   inventory_sellable  sellable stock per country × SKU (06_ USA_Sellable INV + 07_INT Sellable INV)
--   amz_inventory_asin  Amazon Vendor inventory per country × ASIN (04_AMZ_sellable details):
--                       on hand, in transit, open PO, OOS rate, confirmation / fill rate, lead time, aged 90+
--
-- The file is uploaded from the dashboard (tab Inventory Tracking → "Upload file").
-- The browser reads the workbook and sends the rows to inv_upload(); writing needs
-- an upload key. Set (or change) it once here, with your own passphrase:
--
--   insert into upload_keys(name, key_hash) values ('inventory', crypt('<passphrase>', gen_salt('bf')))
--   on conflict (name) do update set key_hash = excluded.key_hash;
--
-- inv_upload_finish() then also refreshes the tables the other tabs already read
-- (skus.salable_*, inventory_snapshot, incoming_weekly), so DOC / incoming on
-- Tracking Target follow the new ETA logic.
-- ============================================================================
create extension if not exists pgcrypto with schema extensions;

create table if not exists incoming_detail (
  id                    bigint generated always as identity primary key,
  source                text not null check (source in ('AMZ','Y4A')),
  log_date              date not null,
  country               text not null,
  channel               text,      -- AMZ: AVC DI / AVC WH · Y4A: warehouse (BRE, NJ1)
  po_type               text,      -- Y4A: Replenishment / NPD
  po_name               text not null,
  vendor_code           text,
  sku                   text not null,
  asin                  text,
  qty                   numeric not null default 0,
  eta_salable_date      date,      -- ETA hiện tại (đã cập nhật theo logic mới)
  eta_salable_original  date,      -- ETA ban đầu
  physical_status       text,      -- Pre-pipeline / In production / Pipeline / In land transit
  on_time_status        text,      -- normal / delay vs expected (ETA lùi so với ban đầu) / delay vs current (đã quá ETA, chưa về)
  ordered_date          date,
  container_number      text,
  container_type        text,
  expected_ship_date    date,
  actual_ship_date      date,
  etd_pol               date,
  atd_pol               date,
  eta_pod               date,
  ata_pod               date,      -- AMZ: actual_port_arrival
  department            text,
  product_name          text,
  product_line          text,
  selling_type          text,
  incoming_week         text,
  loaded_at             timestamptz not null default now()
);
create index if not exists idx_incoming_detail_sku on incoming_detail(country, sku);
create index if not exists idx_incoming_detail_src on incoming_detail(source, log_date);

create table if not exists incoming_eta_log (
  source                text not null,
  log_date              date not null,
  country               text not null,
  po_name               text not null,
  sku                   text not null,
  asin                  text not null default '',
  container_number      text not null default '',
  qty                   numeric,
  eta_salable_date      date,
  eta_salable_original  date,
  physical_status       text,
  on_time_status        text,
  primary key (source, log_date, country, po_name, sku, asin, container_number)
);
create index if not exists idx_incoming_eta_log_line on incoming_eta_log(source, country, po_name, sku);

create table if not exists inventory_sellable (
  country       text not null,
  sku           text not null,
  product_name  text,
  department    text,
  inv_y4a       numeric default 0,
  inv_amz       numeric default 0,
  y4a_as_of     date,
  amz_as_of     date,
  loaded_at     timestamptz not null default now(),
  primary key (country, sku)
);

create table if not exists amz_inventory_asin (
  country                         text not null,
  asin                            text not null,
  sku                             text,
  department                      text,
  log_date                        date,
  currency                        text,
  sellable_on_hand_units          numeric,
  sellable_on_hand_value          numeric,
  sellable_in_transit_units       numeric,
  unsellable_on_hand_units        numeric,
  in_transit_units                numeric,
  open_po_units                   numeric,
  total_sellable                  numeric,
  net_received_units              numeric,
  unfilled_customer_ordered_units numeric,
  confirmed_units                 numeric,
  aged_90_units                   numeric,
  procurable_oos_rate             numeric,
  sourceable_oos_rate             numeric,
  vendor_confirmation_rate        numeric,
  receive_fill_rate               numeric,
  vendor_lead_time_days           numeric,
  loaded_at                       timestamptz not null default now(),
  primary key (country, asin)
);
create index if not exists idx_amz_inventory_asin_sku on amz_inventory_asin(country, sku);

-- one row per upload (file name, rows, who) for the "nguồn dữ liệu" line of the tab
create table if not exists inventory_uploads (
  id          bigint generated always as identity primary key,
  file_name   text,
  log_date    date,
  counts      jsonb,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);

create table if not exists upload_keys (
  name      text primary key,
  key_hash  text not null
);

-- ----------------------------------------------------------------------------
-- RLS: the dashboard reads everything except upload_keys; writes go through
-- the functions below only.
-- ----------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['incoming_detail','incoming_eta_log','inventory_sellable','amz_inventory_asin','inventory_uploads'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %1$s" on %1$I', t);
    execute format('create policy "public read %1$s" on %1$I for select using (true)', t);
  end loop;
  alter table upload_keys enable row level security;   -- no policy: invisible to anon
  revoke all on upload_keys from anon, authenticated;
end $$;

-- ----------------------------------------------------------------------------
-- Upload: p_kind = amz_incoming | y4a_incoming | inventory_sellable | amz_asin
-- p_reset = true on the first chunk of a kind (clears the previous file's rows).
-- ----------------------------------------------------------------------------
create or replace function inv_check_key(p_key text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- the pull-inventory Edge Function calls with the service role key: no upload key needed
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' then
    return;
  end if;
  if not exists (select 1 from upload_keys where name = 'inventory' and key_hash = crypt(coalesce(p_key, ''), key_hash)) then
    raise exception 'Upload key không đúng (hoặc chưa tạo: xem đầu file supabase_inventory_tracking.sql)' using errcode = '28000';
  end if;
end $$;

create or replace function inv_upload(p_key text, p_kind text, p_rows jsonb, p_reset boolean default false)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform inv_check_key(p_key);
  if p_kind in ('amz_incoming', 'y4a_incoming') then
    if p_reset then delete from incoming_detail where source = case p_kind when 'amz_incoming' then 'AMZ' else 'Y4A' end; end if;
    insert into incoming_detail (source, log_date, country, channel, po_type, po_name, vendor_code, sku, asin, qty,
      eta_salable_date, eta_salable_original, physical_status, on_time_status, ordered_date, container_number, container_type,
      expected_ship_date, actual_ship_date, etd_pol, atd_pol, eta_pod, ata_pod, department, product_name, product_line, selling_type, incoming_week)
    select case p_kind when 'amz_incoming' then 'AMZ' else 'Y4A' end, log_date, country, channel, po_type, po_name, vendor_code, sku, asin, coalesce(qty, 0),
      eta_salable_date, eta_salable_original, physical_status, on_time_status, ordered_date, container_number, container_type,
      expected_ship_date, actual_ship_date, etd_pol, atd_pol, eta_pod, ata_pod, department, product_name, product_line, selling_type, incoming_week
    from jsonb_to_recordset(p_rows) as r(log_date date, country text, channel text, po_type text, po_name text, vendor_code text, sku text, asin text, qty numeric,
      eta_salable_date date, eta_salable_original date, physical_status text, on_time_status text, ordered_date date, container_number text, container_type text,
      expected_ship_date date, actual_ship_date date, etd_pol date, atd_pol date, eta_pod date, ata_pod date, department text, product_name text,
      product_line text, selling_type text, incoming_week text)
    where sku is not null and po_name is not null and country is not null and log_date is not null;
  elsif p_kind = 'inventory_sellable' then
    if p_reset then delete from inventory_sellable where true; end if;   -- "where true": Supabase blocks DELETE without WHERE from the API
    insert into inventory_sellable (country, sku, product_name, department, inv_y4a, inv_amz, y4a_as_of, amz_as_of)
    select country, sku, max(product_name), max(department), sum(coalesce(inv_y4a, 0)), sum(coalesce(inv_amz, 0)), max(y4a_as_of), max(amz_as_of)
    from jsonb_to_recordset(p_rows) as r(country text, sku text, product_name text, department text, inv_y4a numeric, inv_amz numeric, y4a_as_of date, amz_as_of date)
    where sku is not null and country is not null
    group by country, sku
    on conflict (country, sku) do update set product_name = excluded.product_name, department = excluded.department,
      inv_y4a = excluded.inv_y4a, inv_amz = excluded.inv_amz, y4a_as_of = excluded.y4a_as_of, amz_as_of = excluded.amz_as_of, loaded_at = now();
  elsif p_kind = 'amz_asin' then
    if p_reset then delete from amz_inventory_asin where true; end if;
    insert into amz_inventory_asin (country, asin, sku, department, log_date, currency, sellable_on_hand_units, sellable_on_hand_value,
      sellable_in_transit_units, unsellable_on_hand_units, in_transit_units, open_po_units, total_sellable, net_received_units,
      unfilled_customer_ordered_units, confirmed_units, aged_90_units, procurable_oos_rate, sourceable_oos_rate,
      vendor_confirmation_rate, receive_fill_rate, vendor_lead_time_days)
    select distinct on (country, asin) country, asin, sku, department, log_date, currency, sellable_on_hand_units, sellable_on_hand_value,
      sellable_in_transit_units, unsellable_on_hand_units, in_transit_units, open_po_units, total_sellable, net_received_units,
      unfilled_customer_ordered_units, confirmed_units, aged_90_units, procurable_oos_rate, sourceable_oos_rate,
      vendor_confirmation_rate, receive_fill_rate, vendor_lead_time_days
    from jsonb_to_recordset(p_rows) as r(country text, asin text, sku text, department text, log_date date, currency text,
      sellable_on_hand_units numeric, sellable_on_hand_value numeric, sellable_in_transit_units numeric, unsellable_on_hand_units numeric,
      in_transit_units numeric, open_po_units numeric, total_sellable numeric, net_received_units numeric, unfilled_customer_ordered_units numeric,
      confirmed_units numeric, aged_90_units numeric, procurable_oos_rate numeric, sourceable_oos_rate numeric, vendor_confirmation_rate numeric,
      receive_fill_rate numeric, vendor_lead_time_days numeric)
    where asin is not null and country is not null
    order by country, asin, log_date desc nulls last
    on conflict (country, asin) do update set sku = excluded.sku, department = excluded.department, log_date = excluded.log_date,
      currency = excluded.currency, sellable_on_hand_units = excluded.sellable_on_hand_units, sellable_on_hand_value = excluded.sellable_on_hand_value,
      sellable_in_transit_units = excluded.sellable_in_transit_units, unsellable_on_hand_units = excluded.unsellable_on_hand_units,
      in_transit_units = excluded.in_transit_units, open_po_units = excluded.open_po_units, total_sellable = excluded.total_sellable,
      net_received_units = excluded.net_received_units, unfilled_customer_ordered_units = excluded.unfilled_customer_ordered_units,
      confirmed_units = excluded.confirmed_units, aged_90_units = excluded.aged_90_units, procurable_oos_rate = excluded.procurable_oos_rate,
      sourceable_oos_rate = excluded.sourceable_oos_rate, vendor_confirmation_rate = excluded.vendor_confirmation_rate,
      receive_fill_rate = excluded.receive_fill_rate, vendor_lead_time_days = excluded.vendor_lead_time_days, loaded_at = now();
  else
    raise exception 'p_kind không hợp lệ: %', p_kind;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- After every chunk is in: ETA history (USA), and the tables other tabs read.
drop function if exists inv_upload_finish(text, text, text);
create or replace function inv_upload_finish(p_key text, p_file_name text default null, p_uploaded_by text default null,
                                             p_source text default null, p_hash text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare d_amz date; d_y4a date; d_inv date; c jsonb; n_asin int;
begin
  perform inv_check_key(p_key);
  select max(log_date) into d_amz from incoming_detail where source = 'AMZ';
  select max(log_date) into d_y4a from incoming_detail where source = 'Y4A';
  select greatest(max(y4a_as_of), max(amz_as_of)) into d_inv from inventory_sellable where country = 'USA';

  -- 1) ETA history: one row per PO line per file (USA only, to keep the table small)
  insert into incoming_eta_log (source, log_date, country, po_name, sku, asin, container_number, qty, eta_salable_date,
                                eta_salable_original, physical_status, on_time_status)
  select source, log_date, country, po_name, sku, coalesce(asin, ''), coalesce(container_number, ''), sum(qty),
         min(eta_salable_date), min(eta_salable_original), max(physical_status), max(on_time_status)
  from incoming_detail where country = 'USA'
  group by 1, 2, 3, 4, 5, 6, 7
  on conflict (source, log_date, country, po_name, sku, asin, container_number) do update set qty = excluded.qty,
    eta_salable_date = excluded.eta_salable_date, eta_salable_original = excluded.eta_salable_original,
    physical_status = excluded.physical_status, on_time_status = excluded.on_time_status;

  -- 2) Stock on the SKU master + daily snapshot (USA, team SKUs only: both reference skus)
  if d_inv is not null then
    update skus k set salable_y4a = i.inv_y4a, salable_amz = i.inv_amz, inventory_as_of = d_inv
    from inventory_sellable i where i.country = 'USA' and i.sku = k.sku;
    insert into inventory_snapshot (sku, snapshot_date, salable_y4a, salable_amz)
    select i.sku, d_inv, i.inv_y4a, i.inv_amz from inventory_sellable i join skus k on k.sku = i.sku where i.country = 'USA'
    on conflict (sku, snapshot_date) do update set salable_y4a = excluded.salable_y4a, salable_amz = excluded.salable_amz;
  end if;

  -- 3) Weekly incoming (USA) by the new ETA. Lines already past their ETA (delay vs current)
  --    are put in the week of the file date: they are due now.
  if coalesce(d_amz, d_y4a) is not null then
    delete from incoming_weekly where snapshot_date = greatest(d_amz, d_y4a) or snapshot_date < greatest(d_amz, d_y4a) - 90;
    insert into incoming_weekly (sku, week_start, qty_y4a, qty_amz, snapshot_date)
    select x.sku, x.wk, sum(x.qy), sum(x.qa), greatest(d_amz, d_y4a)
    from (
      select i.sku, (e - extract(dow from e)::int) wk,
             case when source = 'Y4A' then qty else 0 end qy, case when source = 'AMZ' then qty else 0 end qa
      from incoming_detail i, lateral (select greatest(coalesce(i.eta_salable_date, i.log_date), i.log_date) e) z
      where i.country = 'USA'
    ) x join skus k on k.sku = x.sku
    group by x.sku, x.wk;
  end if;

  -- 4) BTR tab: stock per SKU × ASIN (USA, SSO) from 04_AMZ_sellable details; ASIN status kept from the previous rows
  if to_regclass('public.asin_inventory') is not null and exists (select 1 from amz_inventory_asin where country = 'USA') then
    create temp table _ai on commit drop as
    select a.sku, a.asin, o.asin_status, coalesce(a.department, 'SSO') dep,
           coalesce(s.inv_y4a, 0) salable_y4a, coalesce(a.total_sellable, 0) salable_amz,
           coalesce((select sum(qty) from incoming_detail i where i.country = 'USA' and i.source = 'Y4A' and i.sku = a.sku), 0) incoming_y4a,
           coalesce((select sum(qty) from incoming_detail i where i.country = 'USA' and i.source = 'AMZ' and i.asin = a.asin), 0) incoming_amz,
           a.log_date::timestamp snapshot_at
    from amz_inventory_asin a
    left join inventory_sellable s on s.country = 'USA' and s.sku = a.sku
    left join asin_inventory o on o.sku = a.sku and o.asin = a.asin
    where a.country = 'USA' and a.sku is not null and coalesce(a.department, 'SSO') = 'SSO';
    delete from asin_inventory where true;
    insert into asin_inventory (sku, asin, asin_status, dep, salable_y4a, salable_amz, incoming_y4a, incoming_amz, snapshot_at)
    select sku, asin, asin_status, dep, salable_y4a, salable_amz, incoming_y4a, incoming_amz, snapshot_at from _ai
    on conflict (sku, asin) do nothing;
    get diagnostics n_asin = row_count;
  end if;

  select jsonb_build_object(
    'amz_lines', (select count(*) from incoming_detail where source = 'AMZ'),
    'y4a_lines', (select count(*) from incoming_detail where source = 'Y4A'),
    'inventory_rows', (select count(*) from inventory_sellable),
    'amz_asin_rows', (select count(*) from amz_inventory_asin),
    'asin_inventory_rows', n_asin,
    'amz_log_date', d_amz, 'y4a_log_date', d_y4a, 'inventory_as_of', d_inv) into c;
  insert into inventory_uploads (file_name, log_date, counts, uploaded_by) values (p_file_name, coalesce(d_amz, d_y4a), c, coalesce(p_uploaded_by, p_source));
  insert into ingest_runs (source, status, file_hash, days, rows_in, rows_loaded, message)
  values (coalesce(p_source, 'upload: ' || coalesce(p_file_name, 'tracker')), 'ok', p_hash, array[coalesce(d_amz, d_y4a)],
          (c->>'amz_lines')::int + (c->>'y4a_lines')::int, (c->>'inventory_rows')::int,
          format('tracker %s: AMZ %s dòng, Y4A %s dòng, tồn %s SKU, asin_inventory %s', coalesce(d_amz, d_y4a), c->>'amz_lines', c->>'y4a_lines', c->>'inventory_rows', coalesce(n_asin::text, 'bỏ qua')));
  return c;
end $$;

revoke execute on function inv_check_key(text) from public, anon, authenticated;
revoke execute on function inv_upload(text, text, jsonb, boolean) from public;
revoke execute on function inv_upload_finish(text, text, text, text, text) from public;
grant execute on function inv_upload(text, text, jsonb, boolean) to anon, authenticated, service_role;
grant execute on function inv_upload_finish(text, text, text, text, text) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- ETA accuracy from the history: per PO line, first ETA seen, last ETA seen,
-- how many times it moved, and the last file it was in (after that it arrived
-- or was cancelled).
-- ----------------------------------------------------------------------------
create or replace view incoming_eta_changes with (security_invoker = true) as
select source, country, po_name, sku, asin, container_number,
       min(log_date) first_seen, max(log_date) last_seen,
       (array_agg(eta_salable_date order by log_date))[1] first_eta,
       (array_agg(eta_salable_date order by log_date desc))[1] last_eta,
       (array_agg(eta_salable_date order by log_date desc))[1] - (array_agg(eta_salable_date order by log_date))[1] slip_days,
       count(distinct eta_salable_date) - 1 eta_changes,
       (array_agg(qty order by log_date desc))[1] qty
from incoming_eta_log group by 1, 2, 3, 4, 5, 6;
grant select on incoming_eta_changes to anon, authenticated;

-- AI chat (ai_reader role from supabase_schema_v3.sql) may read the new tables
do $$ declare t text; begin
  foreach t in array array['incoming_detail','incoming_eta_log','inventory_sellable','amz_inventory_asin','inventory_uploads','incoming_eta_changes'] loop
    execute format('grant select on %I to ai_reader', t);
  end loop;
exception when undefined_object then null; end $$;
