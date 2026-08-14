# Yes4All Sales Dashboard — Database Setup (Supabase)

Three files make this work together:

| File | What it is |
|---|---|
| `supabase_schema.sql` | Creates the tables. Run once. |
| `ingest.py` | Pushes Excel/HTML source files into the database. Run whenever you have new data. |
| `Yes4All_Sales_Dashboard_Supabase.html` | The live dashboard. Reads/writes the database directly — open it in any browser. |

The old `Yes4All_Sales_Dashboard.html` (static version) still works and needs nothing — keep it as an offline backup. The new `_Supabase` version is the one that will stay up to date automatically once connected.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → sign up (free tier is enough) → **New project**.
2. Pick any name/region, set a database password (save it somewhere — you likely won't need it day to day, Supabase's API keys are what matter here).
3. Wait ~2 minutes for it to finish provisioning.

## 2. Create the tables

1. In the Supabase dashboard: **SQL Editor** → **New query**.
2. Paste the entire contents of `supabase_schema.sql` → **Run**.
3. You should see 7 new tables under **Table Editor**: `skus`, `targets_monthly`, `sales_daily`, `diary_entries`, `diary_followups`, `projects`, `project_log`.

## 3. Get your API keys

**Project Settings → API.** You need two different keys — they are not interchangeable:

| Key | Where it goes | Notes |
|---|---|---|
| **anon / public** | Inside the dashboard HTML file, and safe to publish on GitHub | Read-only on sales data; read+write on Diary/Projects only (enforced by Row Level Security, see `supabase_schema.sql`) |
| **service_role** | Only ever used locally when running `ingest.py` (as an environment variable) | Full read/write access, bypasses all security rules. **Never** put this in the HTML file or commit it to GitHub. |

## 4. Connect the dashboard

Open `Yes4All_Sales_Dashboard_Supabase.html` in a text editor, find near the top of the `<script>` section:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Replace both with your project's URL and **anon** key, save, then open the file in a browser. If it's still not connected you'll see a banner telling you what's missing instead of a blank page.

## 5. Load your data in

`ingest.py` runs in **two modes**:

- **`sql` (default, what Claude uses)** — Claude runs it against your files inside its sandbox, which has no direct network access to Supabase. Instead of pushing over the network, it writes a `.sql` file (`followup_upsert.sql`, `target_upsert.sql`, `sales_upsert.sql`) full of `INSERT ... ON CONFLICT ... DO UPDATE` statements. You paste that file's contents into **SQL Editor → New query → Run** in Supabase, same as the schema in step 2. This is the normal day-to-day workflow — just attach the new Excel/HTML file in chat and ask Claude to ingest it; it'll hand you back a ready-to-paste `.sql` file (or run it for you if you'd rather not copy/paste).
- **`api` mode** — only if *you* run `ingest.py` yourself from a machine with real internet access (not Claude's sandbox). Set `export INGEST_MODE=api` plus the `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` env vars first, then it pushes straight to Supabase over the network, no copy/paste needed:

```bash
export INGEST_MODE=api
export SUPABASE_URL=https://xxxxxxxx.supabase.co
export SUPABASE_SERVICE_KEY=eyJ...        # service_role key, step 3

python ingest.py followup "Amazon Follow up_2026.xlsx"
python ingest.py target   "SSO_US_Aug.2026.html" --skus-from "Amazon Follow up_2026.xlsx"
python ingest.py sales    "SSO Data Extraction Hourly -- hourly.xlsx" --skus-from "Amazon Follow up_2026.xlsx"
```

**Always pass `--skus-from`** on `target` and `sales`. The SSO planning/sales exports cover Amazon's entire catalog for the company, not just the SKUs Rachel's team manages — `--skus-from` points at the follow-up/tracking Excel file so only the ~150-160 managed SKUs get ingested, instead of hundreds of unrelated SKUs showing up as PIC=Unassigned / Main PL=Unclassified placeholders in the dashboard. `followup` never needs the flag — it *is* the managed SKU list.

Order doesn't actually matter either way — each command creates any missing SKU rows it needs, so nothing fails if you run `sales` before `followup`, for example. Every statement is a safe upsert (SKU / SKU+date / SKU+month), so re-running with the same or overlapping data just overwrites the matching rows instead of duplicating them.

Reload the dashboard — the **Month** dropdown (top-left of Sales Performance) will now list every month you've loaded target data for, and all the KPIs/charts/table populate live from the database.

## 6. Going forward — new data each week/month

Whenever there's a new Excel/HTML export, attach it in a Cowork chat and ask Claude to ingest it — it'll hand back the matching `.sql` file to paste into the SQL Editor. Re-uploading overlapping dates/months is always safe (upsert, not insert).

## 7. Publishing to GitHub / GitHub Pages

Since you mentioned you're already pushing to GitHub:

- It's fine to make the repo **public** — the anon key embedded in the HTML is *designed* to be public; Row Level Security is what actually protects the data (see table above).
- **Never** commit the `SUPABASE_SERVICE_KEY` anywhere in the repo — it isn't needed by the HTML at all, only by `ingest.py` run locally/by Claude.
- To host it: push the repo → repo **Settings → Pages** → set source to your branch/root → you'll get a `https://<you>.github.io/<repo>/Yes4All_Sales_Dashboard_Supabase.html` URL that always shows live data, no server required.

## Notes / current limits

- Product Diary and Projects now save for real (instant, shared across anyone with the link) — no more "export and re-send" step.
- Sales Performance still reads one calendar month at a time via the Month selector; nothing stops you from loading many months over time, the dashboard just shows one at a time for clarity.
- I could not test this end-to-end against a live Supabase project since one didn't exist yet — the join/aggregation logic was verified with equivalent mock data, but once you've completed steps 1–5, it's worth a quick pass together to confirm real numbers look right.
