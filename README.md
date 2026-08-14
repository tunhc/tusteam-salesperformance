# Yes4All Sales Performance Dashboard

Live Amazon Vendor/Seller sales dashboard for Yes4All — targets vs. actuals by PIC/Product Line, inventory health, Product Diary (action log), and Projects tracking. Reads and writes a Supabase (Postgres) backend directly from the browser.

**Live site:** `https://tunhc.github.io/tusteam-salesperformance/` (enable in repo Settings → Pages → source: `main` / root, if not already on).

## Files

| File | Purpose |
|---|---|
| `index.html` | The dashboard itself. Self-contained — open directly in a browser, or serve via GitHub Pages. |
| `supabase_schema.sql` | Table definitions + Row Level Security policies. Run once per Supabase project. |
| `ingest.py` | Loads new source files (follow-up Excel, target HTML, sales Excel) into Supabase. |
| `SETUP_DATABASE.md` | Full setup walkthrough — Supabase project, keys, first data load. |

## Security — read before touching this repo

This repo is **public**. That's fine for `index.html` — it only contains the Supabase **anon** key, which is meant to be public and is restricted by Row Level Security (read-only on sales data, read+write only on the Diary/Projects tabs).

**Never commit any of the following:**
- The Supabase `service_role` key (bypasses all security — only used locally/by Claude when running `ingest.py`, never in this repo).
- Generated `*_upsert.sql` files (`followup_upsert.sql`, `target_upsert.sql`, `sales_upsert.sql`) — these contain real SKU-level sales and target figures. They're one-time-use files you paste into the Supabase SQL Editor and discard; the database is the source of truth, not git history.
- Raw source files (the Amazon Follow-up Excel, SSO planning HTML/Excel exports) — same reason.

## Updating data

Attach the new Excel/HTML export in a Cowork chat with Claude and ask it to ingest — Claude runs `ingest.py` and hands back a `.sql` file to paste into Supabase's SQL Editor. See `SETUP_DATABASE.md` for details.
