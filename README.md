# Yes4All Sales Performance Dashboard

Live Amazon Vendor/Seller sales dashboard for Yes4All — targets vs. actuals by PIC/Product Line, inventory health, weekly review + action tracker, market research, an AI chat box, and Projects tracking. Reads and writes a Supabase (Postgres) backend directly from the browser.

**Live site:** `https://tunhc.github.io/tusteam-salesperformance/` (enable in repo Settings → Pages → source: `main` / root, if not already on).

## Files

| File | Purpose |
|---|---|
| `index.html` | The dashboard itself. Self-contained — open directly in a browser, or serve via GitHub Pages. |
| `supabase_schema.sql` | Table definitions + Row Level Security policies. Run once per Supabase project. |
| `ingest.py` | Loads new source files (follow-up Excel, target HTML, sales Excel) into Supabase. |
| `SETUP_DATABASE.md` | Full setup walkthrough — Supabase project, keys, first data load. |
| `v2.js` | v2 modules loaded by `index.html`: global quick search, Tracking extras (DOC value, issue monitor, action labels), Sales Performance, Weekly Review, Ads recommendations, Market. |
| `v3.js` | v3 modules: AI chat box (bottom-right), Product Performance BI charts, CM3 price calculator (Market tab), Projects quick entry. |
| `supabase_schema_v2.sql` | v2 tables, history lock, weekly snapshot function, aggregate RPCs. Run once after `supabase_schema.sql`; safe to re-run. |
| `supabase_schema_v3.sql` | v3 tables: chat sessions/messages, read-only `ai_query` for the chat, action logs, `project_updates`, `cm3_cost_stack`. Run after v2; safe to re-run. |
| `market_research.py` | Extracts every table and written analysis from the Strategy Plan workbooks and HTML market reports (used by `ingest_v2.py --market-dir`). Cost/CM3 columns are dropped. |
| `ingest_v2.py` | Bulk loader: turns the source Excel/HTML files into numbered `.sql` files to paste into the SQL Editor (see below). |
| `supabase/functions/ai-recommend/` | Edge Function behind the “Hỏi AI” buttons (Claude API). |
| `supabase/functions/pull-hourly/` + `supabase_auto_ingest.sql` | Hourly auto-load of the SSO Data Extraction Hourly Excel from its SharePoint/OneDrive link (pg_cron → Edge Function → `replace_sales_days`). |
| `supabase_btr.sql` | BTR Tracking tab (Amazon Born To Run): `btr_offers`, `asin_inventory`, `sales_asin_daily` + `replace_sales_asin_days`. Safe to re-run. |
| `supabase/functions/ai-chat/` | Edge Function behind the chat box: answers data questions with read-only SQL, other questions as an Amazon specialist. |
| `prototype/redesign.html` | Early layout proposal with generated sample data (kept for reference). |

## Security — read before touching this repo

This repo is **public**. That's fine for `index.html` — it only contains the Supabase **anon** key, which is meant to be public and is restricted by Row Level Security (read-only on sales data, read+write only on notes, actions, projects and chat logs).

**Never commit any of the following:**
- The Supabase `service_role` key (bypasses all security — only used locally/by Claude when running `ingest.py`, never in this repo).
- Generated `*_upsert.sql` files (`followup_upsert.sql`, `target_upsert.sql`, `sales_upsert.sql`) — these contain real SKU-level sales and target figures. They're one-time-use files you paste into the Supabase SQL Editor and discard; the database is the source of truth, not git history.
- Raw source files (the Amazon Follow-up Excel, SSO planning HTML/Excel exports) — same reason.

## Updating data

Attach the new Excel/HTML export in a Cowork chat with Claude and ask it to ingest — Claude runs `ingest.py` and hands back a `.sql` file to paste into Supabase's SQL Editor. See `SETUP_DATABASE.md` for details.


## v2 setup (one time)

1. **Generate the SQL files** (locally or ask Claude in chat — never commit the output, it contains real figures):

   ```bash
   python ingest_v2.py --out ./sql_out \
     --followup "Yes4all_follow_up.xlsx" --tracking-sheet Tracking_0925 \
     --inventory "USA_Inventory_Y4A-AMZ.xlsx" \
     --target "SSO_US_Oct_Target_20260922.xlsx" --target-month 2026-10-01 --team "Team Cẩm Tú" \
     --daily "Yes4All_data_tusteam_2023-2024_daily.xlsx" "Yes4All_data_tusteam_2025_daily.xlsx" "Yes4All_data_tusteam_2026_daily.xlsx" \
     --market-dir ./Markets --cm3-html "Y4A_CM3_by_Lane_V98_v73_Sep21_2026.html" \
     --kpi-tracker "SSO_Sales_KPI_Tracker_Sep2026_ver2.0.xlsx"
   ```

2. **Paste them into Supabase → SQL Editor in this order:** `00_schema_v2.sql`, `00b_schema_v3.sql` (= `supabase_schema_v3.sql`), `01_skus.sql`, `02_targets_*.sql`, `03_inventory_incoming.sql`, `04_demand_forecast.sql`, `05_market*.sql`, `06_cm3.sql`, `08_cm3_cost_stack.sql`, `09_market_research.sql`, every `10_sales_history_NN.sql`, then `07_weekly_notes.sql` (it snapshots weeks, so it needs the sales rows first). Every file is an upsert: re-running is safe. Every file is kept under 600 KB because the SQL Editor rejects large scripts (“Query is too large”); sales history is written in a compact one-line-per-row format for the same reason. Lower `--max-part-kb` if the editor still complains.

3. **History lock.** Rows in `sales_daily` dated before `data_locks.lock_before` (2026-09-01) are read-only: inserts, updates and deletes on them are skipped silently, so the hourly Power Automate sync can never overwrite final months. The history files unlock only their own session. To move the lock forward after a month closes: `update data_locks set lock_before = '2026-10-01' where table_name = 'sales_daily';`

4. **Weekly snapshot.** `00_schema_v2.sql` schedules `freeze_review_week` every Monday 06:00 Vietnam time with `pg_cron` (enable it under Database → Extensions if the notice says it is missing). The dashboard also freezes an ended week the first time someone opens it after Monday 06:00. Notes saved after the deadline (default Tuesday 12:00) are flagged Late; every save is kept in `weekly_review_versions`.

5. **AI recommendations (optional).** Deploy `supabase/functions/ai-recommend/index.ts` as an Edge Function named `ai-recommend`, keep “Verify JWT” on, and add the secret `ANTHROPIC_API_KEY` (and optionally `AI_DAILY_LIMIT`, default 150 answers per 24 h). If your key is not scoped to a workspace (the API answers “must include the anthropic-workspace-id header”), also add `ANTHROPIC_WORKSPACE_ID` (Claude Console → Settings → Workspaces). Answers are cached per SKU / product line / day in `ai_recommendations`. Without it, the rule-based recommendations still work and the “Hỏi AI” buttons show a setup message.

6. **AI chat box.** Deploy `supabase/functions/ai-chat/index.ts` as an Edge Function named `ai-chat` (Verify JWT on, same secrets as above; `AI_DAILY_LIMIT` there defaults to 300 questions per 24 h). Users enter name + team before chatting; every question and answer is stored in `chat_sessions` / `chat_messages` (not readable with the anon key). Data questions run through `ai_query()`, which accepts a single SELECT, runs as the SELECT-only role `ai_reader`, returns at most 300 rows and times out after 8 s.

7. **RRP.** Issue flags such as “Bung giá” compare the 7-day ASP with `skus.rrp`. Keep RRP fresh: `update skus set rrp = … where sku = …;` (or regenerate `01_skus.sql` from a new target file).

### Data notes

- CM3 is an estimate: `units × cm3_unit_base − Ads × 0.985 − Promo` (non-SPT lanes), where `cm3_unit_base` is the V9.8 lane cost stack evaluated without marketing. `08_cm3_cost_stack.sql` stores the per-SKU cost inputs (FOB, duty, freight, fees) used by the Market tab's price calculator. The table has no RLS policy; the dashboard reads one SKU at a time through `cm3_inputs()`, which anyone with the anon key can call. If cost data must stay internal, turn on Supabase Auth and revoke `cm3_inputs` from `anon`.
- The hourly sales file has no glance-view column, so glance views and CR show “nguồn chưa có” for days loaded only from it.
- The Product Diary tab was removed; its old tables are untouched. Projects now use `project_updates` (old `project_log` rows are copied over once by the v3 schema).
- Market tab: charts come from `market_variation` / `market_brand_monthly` / `market_asin_weekly` / `market_variation_monthly`; the research library below them (all SWOT, conclusions, action plans and data tables per category) comes from `market_reports` / `market_insights` / `market_tables`. Re-running `09_market_research.sql` replaces the library.
- Market tab data comes from the research files in `Markets.zip` (variation × brand tables, Tricep Rope weekly ASIN price/units, Soft Kettlebell brand revenue). Categories show whatever each file contains.

## Automatic hourly load (no manual upload)

**Power Automate (push, works with view-only access):** Scheduled cloud flow every hour →
SharePoint *Get file content* (the `usa_amz_sso_hourly -- usa.xlsx` file) → *HTTP* POST to
`https://<project>.supabase.co/functions/v1/pull-hourly` with headers `x-pull-secret: <PULL_SECRET>`,
`x-file-name: usa_amz_sso_hourly -- usa.xlsx`, body = *File Content*. Add `x-dry-run: 1` for a test run
that writes nothing. The file has no `ordered_gmv`; GMV is taken from `ordered_nmv` until that column exists.

**Pull (function downloads the link itself):**

1. Run `supabase_auto_ingest.sql` in the SQL Editor (creates `ingest_runs` and `replace_sales_days`).
2. Deploy `supabase/functions/pull-hourly/` (both files) as Edge Function `pull-hourly` with **Verify JWT off**.
3. Edge Function secrets: `PULL_SECRET` (any long random string), `HOURLY_FILE_URL` (the Excel sharing link).
   The link must download without a Microsoft login ("Anyone with the link", view only). If company policy blocks that,
   register an Azure app with Microsoft Graph application permission `Files.Read.All` (admin consent) and add
   `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` instead.
4. Enable the `pg_net` extension, then run the schedule block at the end of `supabase_auto_ingest.sql` (every hour at :07).
5. Check: `select * from ingest_runs order by ran_at desc limit 20;` — `ok` = loaded, `skipped` = file unchanged, `error` = message says why.

Each run replaces exactly the days present in the file (one transaction); days before `data_locks.lock_before` are never touched.

## BTR Tracking tab (Amazon Born To Run)

1. Run `supabase_btr.sql` once.
2. Turn the two exports into SQL (files land in the `--out` folder; paste them in the SQL Editor, never commit them):
   `python ingest_v2.py --out sql_out --btr "Born-to-run Alert - SSO.xlsx" --asin-inventory Yes4All_US_Inventory_<date>.xlsx`
   → `18_asin_inventory.sql` (run first: it also maps BTR ASINs to SKUs) and `17_btr_offers.sql`.
   Re-run with a newer alert file / inventory file whenever they change.
3. Redeploy `pull-hourly`: every hourly load then also writes sales per ASIN (`product_id`) to `sales_asin_daily`, shown per ASIN under each SKU.

How the tab counts:
- The alert file only gives the campaign: ST Start / ST End, submitted (and vendor responsible) quantity, product cost and Amazon's retention estimate. Sales, MKT and inventory are our own numbers.
- **Sold** = actual units of the SKU (`sales_daily`, all its ASINs, refreshed every hour) from ST Start to ST End. The part sold on the BTR ASIN (`sales_asin_daily`) is shown under it; a SKU's second ASIN (an Amazon listing error) is listed for its stock and sales.
  ASIN history before the hourly load started: `python ingest_v2.py --out sql_out --btr … --asin-inventory … --asin-backfill <daily export> <hourly files…> --asin-from 2026-08-22 --asin-to <last full day>` → `20_sales_asin_backfill.sql` (files oldest first; a later file wins for the days it covers).
- **Run-rate**: Est End Qty = Sold ÷ days passed × ST days (both inclusive; the current day counts by the hours loaded); Est % = Est End Qty ÷ Submitted qty.
- **Est. Retention** = (Vendor responsible qty − Est End Qty) × product cost × retention rate; the rate per offer is taken from Amazon's own estimate in the alert file (median of the other offers when missing).
- **Current MKT fee** = actual ads + promo of the SKU (`sales_daily`) in the same window.
- One row per SKU (its BTR ASIN); the SKU's other ASINs are listed under it for their stock. Inactive ASINs without stock are hidden.

