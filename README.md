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
| `supabase_weekly_targets.sql` | Weekly targets for the Weekly Review (`targets_weekly`) and `freeze_review_week` using them (the last week of a month runs to the month end). Safe to re-run. |
| `supabase_btr.sql` | BTR Tracking tab (Amazon Born To Run): `btr_offers`, `asin_inventory`, `sales_asin_daily` + `replace_sales_asin_days`. Safe to re-run. |
| `inventory.js` + `supabase_inventory_tracking.sql` + `supabase/functions/pull-inventory/` | Inventory Tracking tab: stock, incoming by the new ETA logic (Amazon vs Y4A warehouse), delayed POs/containers, per-SKU forecast + stock projection, AI suggestions; the tracker file is uploaded from the tab. |
| `born-to-run.html` | Reference page on Amazon Born to Run (program, Sell-through Period, Retention Fee formula, Returns, Flex), linked from the BTR Tracking tab. Source: Vendor Central Born to Run Program Policy. |
| `supabase_kb.sql` | AI knowledge hub: `kb_articles` (one article per topic, with its dashboard page and source link) read by the chat before answering policy questions. Starts with the Born to Run article. Safe to re-run; re-run after editing an article. |
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

## Monthly target, weekly target and PIC (from the target file + follow-up)

1. Run `supabase_weekly_targets.sql` once.
2. `python ingest_v2.py --out sql_out --month-target "SSO_US_<Mon>.<year>_Target_<date>_Team_*.xlsx" --target-month 2026-11-01 --pic-followup y4a_follow_up.xlsx [--pic-sheet Tracking_0925]`
   → `21_skus_pic_<yyyy_mm>.sql` (PIC + lifecycle per SKU from the follow-up; new SKUs added; rows without a PIC left out),
   `22_targets_<yyyy_mm>.sql` (columns AD units / AE GMV / AF Ads / AG Promo; replaces the month),
   `23_targets_weekly_<yyyy_mm>.sql` (the file's weekly split of units / Ads / Promo; weekly GMV follows weekly units).
   Run them in that order.
- Weeks are Sunday → Saturday, numbered from the first full week of the year (01/11/2026 → W44). The last week of a month runs to the month end, as in the file ("W47 (incl 29&30/11)": W47 = 22/11 → 30/11); the week after it starts the next day (01/12). Due date and auto-freeze follow the week's last day.
- Weekly Review: the "Target theo tuần" table lists the month's weeks with target vs actual GMV / Ads / Promo / units; the weekly snapshot groups its columns by what they are measured against (GMV vs target, Ads vs ads budget, Promo vs promo budget). Months without weekly targets fall back to the monthly target prorated per day.


## Inventory Tracking tab (tồn kho + incoming theo ETA mới)

Source: `For_Sales_Incoming_Tracker.xlsx` — sheets `01_AMZ_incoming_details` (hàng về kho Amazon, bán AVC), `02_Y4A_incoming_details` (hàng về kho Y4A — control được, request kéo về sớm), `04_AMZ_sellable details`, `06_ USA_Sellable INV`, `07_INT Sellable INV`. Sheet 03 (Wayfair) is not loaded.

**Setup (one time)**
1. Run `supabase_inventory_tracking.sql` in the SQL Editor (safe to re-run).
2. Optional: redeploy `supabase/functions/ai-chat` so the chat box knows the new tables.

**One source for stock + incoming, loaded automatically.** The tracker file is the only source for `skus.salable_*`, `inventory_snapshot`, `incoming_weekly`, `asin_inventory` (BTR tab) and the new tables. There is no upload button: the data only comes in through the Edge Function `pull-inventory`, which writes through `inv_upload` → `inv_upload_finish`.
- **Power Automate flow "Y4A Inventory → Supabase"** (hourly): Power Automate posts the file (SharePoint *Get file content* → HTTP POST `https://<project>.supabase.co/functions/v1/pull-inventory`, headers `x-pull-secret: <INVENTORY_SECRET>`, `x-file-name: For_Sales_Incoming_Tracker.xlsx`, body = file content), or set secret `INVENTORY_FILE_URL` to the sharing link and call it with an empty body. The function detects the format from the sheet names (it still reads the old `USA Inventory Y4A-AMZ.xlsx` / sheet `report`, only for rollback). Test first with header `x-dry-run: 1` (parses, writes nothing, returns row counts). Unchanged files are skipped (`ingest_runs`, source `auto: tracker …`). If the function ever hits the Edge CPU limit, set `INVENTORY_COUNTRIES=USA` to load fewer rows.
- Do not load the old inventory file any more (old Power Automate flow, or `ingest_v2.py --inventory`): it would write `incoming_weekly` / `skus` with the old ETA logic.
- Check: `select ran_at, source, status, message from ingest_runs where source like 'auto: tracker%' order by ran_at desc limit 10;`

**What a load does**: each load replaces the previous file; USA lines are also appended to `incoming_eta_log` (one row per PO line per file date) so ETA changes are kept over time (`incoming_eta_changes`). It also refreshes `skus.salable_*`, `inventory_snapshot` and `incoming_weekly` (USA, team SKUs) so DOC / incoming on Tracking Target use the same data. Lines already past their ETA are counted in the week of the file date.

**How the tab counts**
- `on_time_status` from the file: `normal`; `delay vs expected` = current ETA later than the original ETA (slip days = ETA now − ETA original); `delay vs current` = ETA already passed and the goods are not sellable yet (days past ETA = file date − ETA).
- ETA for projections: "ETA trong file", or "ETA thận trọng" = ETA + the average slip seen in the file for the same source × physical status (overdue lines: file date + 7 days).
- Forecast (USA only; `sales_daily` is Amazon US): per SKU, 78 complete weeks of units → 5 models (MA4, MA8, SES, Holt damped, Seasonal = MA8 level × last year's shape), rolling-origin backtest over the last 8 weeks with a 4-week horizon, lowest WAPE wins (accuracy = 1 − WAPE). SKUs out of stock now whose last 4 weeks fell below half of weeks 5–12 use the pre-stock-out level (`OOS-adjusted`). Past stock-outs are not detected, so their weeks pull forecasts down.
- Projection (16 weeks): stock AMZ + Amazon incoming in the week − forecast → OOS week and lost units; a second line adds Y4A stock and Y4A incoming. Risk: OOS ≤ 2 weeks / within 8 weeks, PO past ETA, ETA slipped, high stock (> 26 weeks of total cover). Suggestions are rule-based; "🤖 AI phân tích" sends the risk SKUs and delayed POs to the `ai-recommend` Edge Function.

## Tracking Target: lost sales / tồn cao (replaces the DOC table)

Always measured against the **target** (`targets_weekly`, the weekly split of the month target; the monthly target spread evenly when a SKU has no weekly split). Price = target GMV ÷ target units of the month.

- **Lost sales theo product line** (expand to SKUs; the SKU code opens the Amazon listing, the row filters the dashboard):
  - Day by day from tomorrow to month end: the target units that current stock + incoming per week cannot cover. Incoming comes from the incoming tracker (new ETA). **ETA thận trọng** (default) moves goods already past their ETA / due this week one week later, because ETAs keep slipping; "ETA theo tracker" uses them as they are.
  - **Mốc forecast**: the inventory file the target was built on, stored per month in `forecast_baseline_inventory` / `forecast_baseline_incoming` (Nov-2026 = `Yes4All_US_Inventory_10282026.xlsx`, 28/10 09:05); daily inventory snapshots can be picked instead. The same simulation on the baseline gives the lost "if goods had come as planned": **Do hàng trễ** = lost − that; the rest is short even on plan.
  - **Δ tồn** = (current stock + incoming in the month + sold since the baseline) − (baseline stock + incoming in the month at the baseline).
  - Units whose original ETA was inside the month but moved past month end, and units past ETA, are tagged per SKU.
  - Nov-2026 check on real data (108 SKUs with a target, $419K target left from 11/11): even spread $11.3K · weekly target + tracker ETA $9.3K · **weekly target + cautious ETA $10.5K** (used) · if goods had come as the 28/10 file planned $4.2K.
- **Tồn cao theo product line**: stock left at month end in the same simulation, potential GMV at the target price, DOC for reference.
- **Issue monitor** (below the two tables): *Ineligible ads* (target file), block zipcode / long shipping / listing (PIC notes), **Nhảy giá** = current Buy Box (Keepa, column Z, matched by ASIN in column E) more than ±10% from **RRP tham chiếu** (Optimal Pricing, column U; the target-file RRP when a SKU is not in the pricing file), glance views −30% WoW.
  - Each card shows **Lost $X (Y% impact)**: the PIC's estimate when a Weekly Review note has one for the SKU on a line naming that issue ("Lost ~$1,000", "Hụt $1106", "sức bán giảm khoảng 75%" × target GMV MTD), else the gap to the target GMV MTD; % impact = lost ÷ target GMV MTD of those SKUs.

**Loading the price files and the forecast baseline** (Edge Function `pull-inventory`, same URL and `x-pull-secret` as the tracker flow; `supabase_pricing_baseline.sql` creates the tables, run once):
- Keepa export (its link is updated continuously): a Power Automate flow like the tracker one — *Get file content* of `US_Keepa_Raw_Auto.xlsx` → HTTP POST, header `x-file-name: US_Keepa_Raw_Auto.xlsx`. Detected from its first row; replaces `keepa_prices`.
- Optimal Pricing (`Yes4All_Optimal_Pricing_SKU.xlsx`, sheet *Optimal pricing*): POST it whenever the fixed prices change; replaces `price_reference`.
- Forecast baseline of a new month: POST the inventory file used for the target (old *report* format) with header `x-forecast-month: 2026-12`.
