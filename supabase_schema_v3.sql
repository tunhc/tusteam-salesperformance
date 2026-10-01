-- ============================================================================
-- YES4ALL SALES DASHBOARD — SCHEMA V3 (run after supabase_schema_v2.sql)
-- Adds: AI chat log, read-only SQL access for the AI, action-tracker logs and
-- manual actions, quick-entry Projects, CM3 calculator inputs. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) AI chat: every question and answer is stored
-- ----------------------------------------------------------------------------
create table if not exists chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_name   text not null,
  team        text,
  started_at  timestamptz not null default now()
);
create table if not exists chat_messages (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references chat_sessions(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  sql_used    text[] default '{}',
  model       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_chat_messages_session on chat_messages(session_id, id);

-- The AI answers data questions by writing one SELECT that runs through
-- ai_query(). The function is owned by ai_reader, a role that can only SELECT
-- the dashboard tables, so even a crafted statement cannot change data.
do $$ begin create role ai_reader nologin; exception when duplicate_object then null; end $$;
grant ai_reader to current_user;
grant usage on schema public to ai_reader;

create or replace function ai_query(q text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  body text := regexp_replace(btrim(q), ';\s*$', '');
  r jsonb;
begin
  if length(body) > 6000 then raise exception 'Query too long'; end if;
  if body !~* '^\s*(select|with)\s' then raise exception 'Only a single SELECT (or WITH … SELECT) statement is allowed'; end if;
  if position(';' in body) > 0 then raise exception 'Only one statement is allowed'; end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) s limit 300) t', body) into r;
  return r;
end $$;
alter function ai_query(text) set statement_timeout = '8s';
-- On Supabase "postgres" is not a superuser: a new owner needs CREATE on the
-- schema, so grant it just for the ownership change and take it back.
grant create on schema public to ai_reader;
alter function ai_query(text) owner to ai_reader;
revoke create on schema public from ai_reader;
revoke all on function ai_query(text) from public;
do $$ begin
  revoke all on function ai_query(text) from anon, authenticated;
  grant execute on function ai_query(text) to service_role;
exception when undefined_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2) Action tracker: manual actions, progress log, who closed it and when
-- ----------------------------------------------------------------------------
alter table review_actions alter column review_id drop not null;
alter table review_actions add column if not exists done_by text;
alter table review_actions add column if not exists done_note text;
alter table review_actions add column if not exists created_by text;
alter table review_actions add column if not exists created_at timestamptz default now();

create table if not exists review_action_logs (
  id          bigint generated always as identity primary key,
  action_id   bigint not null references review_actions(id) on delete cascade,
  pic         text,
  note        text,
  status      text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_action_logs_action on review_action_logs(action_id, created_at);

-- ----------------------------------------------------------------------------
-- 3) Projects: one row per update, entered in one text block
-- ----------------------------------------------------------------------------
create table if not exists project_updates (
  id             uuid primary key default gen_random_uuid(),
  topic          text not null,
  product_group  text,
  status         text,
  content        text,
  update_date    date not null default current_date,
  author         text,
  raw_text       text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_project_updates_topic on project_updates(topic, update_date desc);

-- carry over the old Projects log once
insert into project_updates (topic, status, content, update_date, raw_text)
select p.name, case l.log_type when 'issues' then 'Issue' else 'In progress' end, l.text, l.log_date, l.text
from project_log l join projects p on p.id = l.project_id
where not exists (select 1 from project_updates);

-- ----------------------------------------------------------------------------
-- 4) CM3 calculator inputs (V9.8 cost stack per SKU)
--    No direct table access for the dashboard; one SKU at a time via RPC.
--    NOTE: anyone with the dashboard link can call cm3_inputs(); turn on
--    Supabase Auth and grant it to "authenticated" only if FOB must stay private.
-- ----------------------------------------------------------------------------
create table if not exists cm3_cost_stack (
  sku         text primary key,
  lane        text,
  fob         numeric,
  duty        numeric,
  weight_lb   numeric,
  cbm         numeric,
  asp_canon   numeric,
  rev_di      numeric,
  rev_ds      numeric,
  rev_spt     numeric,
  source      text,
  updated_at  timestamptz not null default now()
);
alter table cm3_cost_stack enable row level security;

create or replace function cm3_inputs(p_sku text)
returns setof cm3_cost_stack language sql stable security definer set search_path = public as $$
  select * from cm3_cost_stack where sku = p_sku
$$;
grant execute on function cm3_inputs(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5) RLS + grants
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['chat_sessions','chat_messages','review_action_logs','project_updates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read %1$s" on %1$I', t);
    execute format('create policy "public read %1$s" on %1$I for select using (true)', t);
  end loop;
  -- sessions, logs and projects are written from the browser; chat messages only by the Edge Function
  foreach t in array array['chat_sessions','review_action_logs','project_updates'] loop
    execute format('drop policy if exists "public insert %1$s" on %1$I', t);
    execute format('create policy "public insert %1$s" on %1$I for insert with check (true)', t);
  end loop;
  execute 'drop policy if exists "public update project_updates" on project_updates';
  execute 'create policy "public update project_updates" on project_updates for update using (true)';
end $$;

-- AI reader: read-only access to the business tables (not chat logs)
do $$
declare t text;
begin
  foreach t in array array['skus','targets_monthly','sales_daily','inventory_snapshot','incoming_weekly','demand_forecast_monthly',
                           'review_weeks','review_snapshot','weekly_reviews','review_actions','review_action_logs','project_updates',
                           'market_variation','market_brand_monthly','market_asin_weekly','market_variation_monthly','data_locks'] loop
    execute format('grant select on %I to ai_reader', t);
  end loop;
end $$;

-- functions that write must not be callable by ai_reader (it inherits PUBLIC)
revoke execute on function freeze_review_week(date, boolean, int, time) from public;
do $$ begin
  grant execute on function freeze_review_week(date, boolean, int, time) to anon, authenticated, service_role;
exception when undefined_object then null; end $$;
