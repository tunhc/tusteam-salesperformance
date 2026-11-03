-- ============================================================================
-- Weekly targets (Weekly Review). Run once in the SQL Editor (safe to re-run).
--   targets_weekly: target per SKU per review week, from the monthly target file's weekly split
--   (ingest_v2.py --month-target → 23_targets_weekly_<yyyy_mm>.sql).
--   week_start is the Sunday of the review week; period_start / period_end are the days the
--   target covers. The last week of a month runs to the month end, e.g. Nov 2026:
--   W47 = 22/11 → 30/11 (9 days, as in the target file).
-- freeze_review_week uses these targets when a week has them and freezes exactly the period's
-- days; the week after an extended week starts the day after it (01/12 after W47 of Nov).
-- Weeks without weekly targets behave as before (monthly target prorated per day, 7 days).
-- ============================================================================

create table if not exists targets_weekly (
  sku           text not null references skus(sku) on delete cascade,
  week_start    date not null,          -- Sunday of the review week
  period_start  date not null,
  period_end    date not null,
  target_units  numeric default 0,
  target_gmv    numeric default 0,
  ads_target    numeric default 0,
  promo_target  numeric default 0,
  source        text,
  updated_at    timestamptz not null default now(),
  primary key (sku, period_start)
);
create index if not exists idx_targets_weekly_week on targets_weekly(week_start);
create index if not exists idx_targets_weekly_period on targets_weekly(period_start);
alter table targets_weekly enable row level security;
drop policy if exists "public read targets_weekly" on targets_weekly;
create policy "public read targets_weekly" on targets_weekly for select using (true);
do $$ begin grant select on targets_weekly to ai_reader; exception when undefined_object then null; end $$;

create or replace function freeze_review_week(p_week_start date, p_force boolean default false,
                                              p_due_dow int default 2, p_due_time time default '17:00')
returns int language plpgsql security definer set search_path = public as $$
declare v_ws date := p_week_start - extract(dow from p_week_start)::int;  -- snap to Sunday
        v_from date; v_we date; v_weekly boolean; v_frozen timestamptz; v_n int;
begin
  -- days of the week: the weekly target's period when there is one, else Sunday → Saturday;
  -- a week that follows an extended week (last week of a month) starts the day after it
  select min(period_start), max(period_end) into v_from, v_we from targets_weekly where week_start = v_ws;
  v_weekly := v_we is not null;
  if not v_weekly then
    select max(period_end) + 1 into v_from from targets_weekly where week_start = v_ws - 7 and period_end >= v_ws;
    v_from := coalesce(v_from, v_ws);
    v_we := v_ws + 6;
  end if;
  if p_force and coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'Only an admin can re-freeze a week'; end if;
  -- the week is locked once the second day after it has data (its last days' numbers have settled):
  -- Monday for a Saturday end; the hourly cron calls this too, so an extended week waits for its end
  if not p_force and not exists (select 1 from sales_daily where date > greatest(v_ws + 7, v_we + 1)) then return 0; end if;
  -- due: p_due_dow days after the day following the week's last day (Tuesday 17:00 for a Saturday end)
  insert into review_weeks (week_start, week_end, due_at)
  values (v_ws, v_we, ((v_we + 1 + p_due_dow)::timestamp + p_due_time) at time zone 'Asia/Ho_Chi_Minh')
  on conflict (week_start) do update set week_end = excluded.week_end, due_at = excluded.due_at where review_weeks.frozen_at is null;
  select frozen_at into v_frozen from review_weeks where week_start = v_ws;
  if v_frozen is not null and not p_force then return 0; end if;

  delete from review_snapshot where week_start = v_ws;
  with cur as (
    select sku, sum(units) units, sum(gmv) gmv, sum(ads) ads, sum(promo) promo, sum(ads_gmv) ads_gmv,
           sum(ads_units) ads_units, sum(total_clicks) clicks, sum(total_impressions) impressions, sum(glance_views) glance_views
    from sales_daily where date between v_from and v_we group by sku),
  prev as (
    select sku, sum(units) units, sum(gmv) gmv, sum(ads) ads, sum(promo) promo, sum(ads_gmv) ads_gmv,
           sum(glance_views) glance_views, sum(total_clicks) clicks
    from sales_daily where date between v_ws - 7 and v_ws - 1 group by sku),
  tgt as (
    select sku, sum(target_units) target_units, sum(target_gmv) target_gmv, sum(ads_target) ads_budget, sum(promo_target) promo_budget
    from targets_weekly where v_weekly and week_start = v_ws group by sku
    union all
    select t.sku,
           sum(t.target_units / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))),
           sum(t.target_gmv   / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))),
           sum(t.ads_target   / extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))),
           sum(t.promo_target / extract(day from (date_trunc('month', d) + interval '1 month - 1 day')))
    from generate_series(v_from, v_we, interval '1 day') d
    join targets_monthly t on t.month = date_trunc('month', d)::date
    where not v_weekly
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
-- same access as before (supabase_schema_v2.sql / v3.sql)
revoke execute on function freeze_review_week(date, boolean, int, time) from public;
do $$ begin
  grant execute on function freeze_review_week(date, boolean, int, time) to anon, authenticated, service_role;
exception when undefined_object then null; end $$;
