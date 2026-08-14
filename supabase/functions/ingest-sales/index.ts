// Supabase Edge Function: ingest-sales
//
// Receives hourly sales rows pushed by a Power Automate flow (reading the
// "SSO Data Extraction Hourly" Excel table straight from SharePoint) and
// upserts them into sales_daily — no Claude/Cowork session involved, so this
// can run unattended on a schedule.
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function ->
//   name it "ingest-sales" -> paste this file -> when deploying, DISABLE
//   "Verify JWT" (this function is authenticated by the X-Ingest-Secret
//   header below instead, since Power Automate can't send a Supabase JWT).
//
// Then: Edge Functions -> ingest-sales -> Secrets -> add INGEST_SECRET with
// a long random value of your choosing. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase — you
// don't need to set those yourself.
//
// Expected POST body: { "rows": [ { sku, date, ordered_units, ordered_gmv,
// total_ads, total_promo, sb_ordered_nmv, sd_ordered_nmv, sp_ordered_nmv,
// sb_ordered_units, sd_ordered_units, sp_ordered_units }, ... ] } — one
// entry per source row; this function aggregates by (sku, date) itself, so
// raw un-aggregated rows are fine to send straight from the Excel table.
// The sb_/sd_/sp_ fields feed the Ads Performance tab (ads_gmv = sum of the
// three *_ordered_nmv fields, ads_units = sum of the three *_ordered_units
// fields) — same math as ingest.py's ingest_sales_excel.
//
// Only SKUs that already exist in the `skus` table (i.e. Rachel's managed
// list, populated by the follow-up ingest) are upserted — everything else
// is silently skipped, same scoping rule as ingest.py's --skus-from.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INGEST_SECRET = Deno.env.get("INGEST_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function safeNum(v: unknown, def = 0): number {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : def;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (INGEST_SECRET) {
    const provided = req.headers.get("x-ingest-secret");
    if (provided !== INGEST_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: { rows?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (rawRows.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no rows received" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // Only ingest SKUs already known to `skus` (Rachel's managed list — this
  // function never adds new SKUs, only sales for ones already tracked).
  const { data: skuRows, error: skuErr } = await supabase.from("skus").select("sku");
  if (skuErr) {
    return new Response(JSON.stringify({ ok: false, error: skuErr.message }), { status: 500 });
  }
  const managed = new Set((skuRows ?? []).map((r: { sku: string }) => r.sku));

  type Agg = {
    sku: string; date: string; units: number; gmv: number; ads: number; promo: number;
    ads_gmv: number; ads_units: number; source_file: string;
  };
  const agg = new Map<string, Agg>();
  let skipped = 0;

  for (const raw of rawRows) {
    const r = raw as Record<string, unknown>;
    const sku = String(r.sku ?? "").trim();
    const date = String(r.date ?? "").slice(0, 10);
    if (!sku || !date || !managed.has(sku)) {
      skipped++;
      continue;
    }
    const key = `${sku}|${date}`;
    const cur = agg.get(key) ?? {
      sku, date, units: 0, gmv: 0, ads: 0, promo: 0, ads_gmv: 0, ads_units: 0,
      source_file: "power-automate-hourly",
    };
    cur.units += safeNum(r.ordered_units);
    cur.gmv += safeNum(r.ordered_gmv);
    cur.ads += safeNum(r.total_ads);
    cur.promo += safeNum(r.total_promo);
    cur.ads_gmv += safeNum(r.sb_ordered_nmv) + safeNum(r.sd_ordered_nmv) + safeNum(r.sp_ordered_nmv);
    cur.ads_units += safeNum(r.sb_ordered_units) + safeNum(r.sd_ordered_units) + safeNum(r.sp_ordered_units);
    agg.set(key, cur);
  }

  const out = Array.from(agg.values()).map((r) => ({
    ...r,
    units: Math.round(r.units * 100) / 100,
    gmv: Math.round(r.gmv * 100) / 100,
    ads: Math.round(r.ads * 100) / 100,
    promo: Math.round(r.promo * 100) / 100,
    ads_gmv: Math.round(r.ads_gmv * 100) / 100,
    ads_units: Math.round(r.ads_units * 100) / 100,
    ingested_at: new Date().toISOString(),
  }));

  const { error: upErr } = await supabase.from("sales_daily").upsert(out, { onConflict: "sku,date" });
  if (upErr) {
    return new Response(JSON.stringify({ ok: false, error: upErr.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, received: rawRows.length, skipped_unmanaged: skipped, upserted: out.length }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});
