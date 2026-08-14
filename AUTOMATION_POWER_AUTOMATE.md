# Hourly auto-sync: SharePoint -> Supabase (Power Automate, no Claude involved)

Runs entirely inside Microsoft 365 + Supabase — nothing depends on a Claude/Cowork session being open, so it keeps running even when you're not chatting with Claude.

Two pieces: a small Supabase Edge Function (`ingest-sales`, already written — see `ingest-sales/index.ts`) that knows how to aggregate and upsert rows, and a Power Automate flow that reads the Excel file every hour and calls it.

## 1. Turn the sheet into an Excel Table (one-time)

Power Automate's "List rows present in a table" action only works on a formatted Excel Table, not a plain range.

1. Open `SSO Data Extraction Hourly -- hourly.xlsx` on SharePoint.
2. Select the header row + all data rows on the `hourly` sheet.
3. **Insert -> Table** (make sure "My table has headers" is checked).
4. Name the table (Table Design -> Table Name), e.g. `hourly`. Save.

New rows added to the bottom of this table each hour will automatically be picked up next sync — no need to redo this step.

## 2. Deploy the Edge Function

1. Supabase Dashboard -> **Edge Functions** -> **Deploy a new function**.
2. Name it `ingest-sales`, paste the contents of `ingest-sales/index.ts`.
3. Before deploying, **disable "Verify JWT"** for this function (Power Automate can't send a Supabase login token — this function checks its own secret instead, see next step).
4. Deploy. Note the function URL, shown as something like:
   `https://zlksfonvnxqxdumwlysf.supabase.co/functions/v1/ingest-sales`
5. Go to the function's **Secrets** tab -> add `INGEST_SECRET` = any long random string you make up (e.g. a password generator, 32+ characters). Save it somewhere — you'll paste the same value into the Power Automate flow.
   (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by Supabase — you don't set those.)

## 3. Build the Power Automate flow

**Create -> Scheduled cloud flow**
- Run this flow: every `1` `Hour`.

**+ New step -> Excel Online (Business) -> List rows present in a table**
- Location: SharePoint site (Data Sciences - Data Analytics Partner)
- Document Library: wherever the file lives
- File: `SSO Data Extraction Hourly -- hourly.xlsx`
- Table: `hourly` (the table you named in step 1)

**+ New step -> Select**
- From: `value` (output of the List rows step)
- Map each field:
  | Map to | Formula |
  |---|---|
  | `sku` | `item()?['sku']` |
  | `date` | `formatDateTime(item()?['date'], 'yyyy-MM-dd')` |
  | `ordered_units` | `item()?['ordered_units']` |
  | `ordered_gmv` | `item()?['ordered_gmv']` |
  | `total_ads` | `item()?['total_ads']` |
  | `total_promo` | `item()?['total_promo']` |

**+ New step -> HTTP**
- Method: `POST`
- URI: the function URL from step 2.4 (`.../functions/v1/ingest-sales`)
- Headers:
  | Key | Value |
  |---|---|
  | `Content-Type` | `application/json` |
  | `x-ingest-secret` | the `INGEST_SECRET` value you set in step 2.5 |
- Body (switch to raw/expression mode):
  ```
  {
    "rows": @{body('Select')}
  }
  ```

Save, then **Test -> Manually** once to confirm it runs. The HTTP action's response body will show `{"ok":true,"received":...,"upserted":...}` if it worked — `upserted` should roughly match how many (sku, date) combinations exist in the current file, scoped to Rachel's managed SKUs.

## What this does and doesn't do

- Only touches `sales_daily` (and never adds new SKUs — rows for SKUs not already in the `skus` table are silently skipped, same rule as `ingest.py --skus-from`).
- Safe to run every hour indefinitely — it's an upsert keyed on (sku, date), so re-processing the same rows just overwrites that day's totals with the latest numbers from the file.
- Does **not** touch `targets_monthly` or the follow-up-derived identity fields (PIC, Main PL, etc.) — those still update manually via `ingest.py` when Rachel sends a new follow-up/target file, since those don't change hourly.
- If the flow ever fails silently, check Power Automate's run history (Interruptable — "28-day run history") and the Supabase Edge Function's **Logs** tab for the actual error.
