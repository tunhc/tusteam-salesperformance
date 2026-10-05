// Pure parsing / aggregation of the "SSO Data Extraction Hourly" sheet.
// Same mapping as ingest_v2.py (hourly_month_rows), so a manual load and an
// automatic load produce identical rows. No Deno APIs here (tested with Node).

export type Row = Record<string, unknown>;
export type DayRow = {
  sku: string; date: string; units: number; gmv: number; ordered_nmv: number; ads: number; promo: number;
  ads_gmv: number; ads_units: number; total_clicks: number; total_impressions: number;
  sp_spend: number; sb_spend: number; sd_spend: number; promo_deal: number; promo_coupon: number; promo_discount: number;
  glance_views?: number; category: string | null; source_file: string;
};

const n = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

// Excel serial number, Date, or "YYYY-MM-DD..." / "M/D/YYYY" text → "YYYY-MM-DD"
// Excel times come back as floats (e.g. 00:59:59.999 for 01:00); snap to the minute.
const snap = (d: Date) => new Date(Math.round(d.getTime() / 60000) * 60000);
export function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    v = snap(v);
    const d = v as Date;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v + 1e-6) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

const r2 = (x: number) => Math.round(x * 10000) / 10000;

// Works with both exports:
//  - "SSO Data Extraction Hourly": one row per SKU per day, ordered_gmv / total_ads / total_promo
//  - "usa_amz_sso_hourly -- usa": one row per SKU per hour (date_time_local), glance_view,
//    no ordered_gmv (GMV falls back to ordered_nmv), ads/promo summed from their parts
export type Info = { rowsIn: number; skipped: number; gmvFrom: string; columns: string[] };
export function aggregate(rawRows: Row[], managed: Set<string>, sourceFile: string): { out: DayRow[] } & Info {
  const rows = rawRows.map((r) => { const o: Row = {}; for (const [k, v] of Object.entries(r)) o[k.trim().toLowerCase().replace(/\s+/g, "_")] = v; return o; });
  const cols = new Set(rows.length ? Object.keys(rows[0]) : []);
  const has = (c: string) => cols.has(c);
  const dateCol = ["date", "date_time_local", "datetime", "day"].find(has);
  const gmvCol = ["ordered_gmv", "ordered_revenue_gmv", "ordered_nmv"].find(has);
  const missing = [!has("sku") && "sku", !dateCol && "date/date_time_local", !has("ordered_units") && "ordered_units", !gmvCol && "ordered_gmv/ordered_nmv"].filter(Boolean);
  if (missing.length) throw new Error("File thiếu cột: " + missing.join(", ") + ". Cột hiện có: " + [...cols].join(", "));
  const sum = (r: Row, ...ks: string[]) => ks.reduce((t, k) => t + n(r[k]), 0);
  const agg = new Map<string, DayRow & { glance_views: number }>();
  let skipped = 0;
  for (const r of rows) {
    const sku = String(r.sku ?? "").trim();
    const date = isoDate(r[dateCol!]);
    if (has("country") && !/^(usa|us)$/i.test(String(r.country ?? "").trim())) { skipped++; continue; }
    if (!sku || !date || !managed.has(sku)) { skipped++; continue; }
    const k = sku + "|" + date;
    let a = agg.get(k);
    if (!a) {
      a = { sku, date, units: 0, gmv: 0, ordered_nmv: 0, ads: 0, promo: 0, ads_gmv: 0, ads_units: 0, total_clicks: 0, total_impressions: 0,
        sp_spend: 0, sb_spend: 0, sd_spend: 0, promo_deal: 0, promo_coupon: 0, promo_discount: 0, glance_views: 0,
        category: r.main_category ? String(r.main_category) : null, source_file: sourceFile };
      agg.set(k, a);
    }
    a.units += n(r.ordered_units); a.gmv += n(r[gmvCol!]); a.ordered_nmv += n(r.ordered_nmv);
    a.ads += has("total_ads") ? n(r.total_ads) : sum(r, "sb_spend", "sd_spend", "sp_spend");
    a.promo += has("total_promo") ? n(r.total_promo) : sum(r, "coupon_spend", "price_discount_spend", "lightning_deal_spend", "best_deal_spend", "vm_promo_spend");
    a.ads_gmv += sum(r, "sb_ordered_nmv", "sd_ordered_nmv", "sp_ordered_nmv");
    a.ads_units += sum(r, "sb_ordered_units", "sd_ordered_units", "sp_ordered_units");
    a.total_clicks += sum(r, "sb_clicks", "sd_clicks", "sp_clicks");
    a.total_impressions += sum(r, "sb_impressions", "sd_impressions", "sp_impressions");
    a.sp_spend += n(r.sp_spend); a.sb_spend += n(r.sb_spend); a.sd_spend += n(r.sd_spend);
    a.promo_deal += sum(r, "best_deal_spend", "lightning_deal_spend", "vm_promo_spend");
    a.promo_coupon += n(r.coupon_spend); a.promo_discount += n(r.price_discount_spend);
    a.glance_views += n(r.glance_views ?? r.glance_view);
  }
  const out = [...agg.values()].map((a) => {
    const o = { ...a } as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (typeof v === "number") o[k] = r2(v);
    return o as DayRow;
  });
  return { out, rowsIn: rows.length, skipped, gmvFrom: gmvCol!, columns: [...cols] };
}

// SharePoint / OneDrive share link → direct-download candidates (no login)
export function downloadUrls(link: string): string[] {
  const u = link.trim();
  const urls: string[] = [];
  if (/1drv\.ms|onedrive\.live\.com/i.test(u)) {
    const b64 = btoa(u).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    urls.push(`https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`);
  }
  urls.push(u.includes("download=1") ? u : u + (u.includes("?") ? "&" : "?") + "download=1");
  return urls;
}

// Graph share id for a sharing link
export function graphShareId(link: string): string {
  return "u!" + btoa(link.trim()).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}


// Hour-level rows (only when the export has a time of day), activity only.
export type HourRow = { sku: string; ts: string; date: string; hour: number; units: number; gmv: number; ads: number; promo: number;
  ads_gmv: number; clicks: number; impressions: number; glance_views: number };
export function hourOf(v: unknown): number | null {
  if (v instanceof Date && !isNaN(v.getTime())) return snap(v).getHours();
  const m = String(v ?? "").match(/[ T](\d{1,2}):\d{2}/);
  return m ? +m[1] : null;
}
export function aggregateHourly(rawRows: Row[], managed: Set<string>): HourRow[] {
  const rows = rawRows.map((r) => { const o: Row = {}; for (const [k, v] of Object.entries(r)) o[k.trim().toLowerCase().replace(/\s+/g, "_")] = v; return o; });
  const cols = new Set(rows.length ? Object.keys(rows[0]) : []);
  const dateCol = ["date_time_local", "datetime", "date_time"].find((c) => cols.has(c));
  if (!dateCol) return [];
  const gmvCol = cols.has("ordered_gmv") ? "ordered_gmv" : "ordered_nmv";
  const sum = (r: Row, ...ks: string[]) => ks.reduce((t, k) => t + n(r[k]), 0);
  const agg = new Map<string, HourRow>();
  for (const r of rows) {
    const sku = String(r.sku ?? "").trim(); const date = isoDate(r[dateCol]); const hour = hourOf(r[dateCol]);
    if (!sku || !date || hour === null || !managed.has(sku)) continue;
    if (cols.has("country") && !/^(usa|us)$/i.test(String(r.country ?? "").trim())) continue;
    const x = { units: n(r.ordered_units), gmv: n(r[gmvCol]), ads: cols.has("total_ads") ? n(r.total_ads) : sum(r, "sb_spend", "sd_spend", "sp_spend"),
      promo: cols.has("total_promo") ? n(r.total_promo) : sum(r, "coupon_spend", "price_discount_spend", "lightning_deal_spend", "best_deal_spend", "vm_promo_spend"),
      ads_gmv: sum(r, "sb_ordered_nmv", "sd_ordered_nmv", "sp_ordered_nmv"), clicks: sum(r, "sb_clicks", "sd_clicks", "sp_clicks"),
      impressions: sum(r, "sb_impressions", "sd_impressions", "sp_impressions"), glance_views: n(r.glance_views ?? r.glance_view) };
    const ts = `${date} ${String(hour).padStart(2, "0")}:00:00`; const k = sku + "|" + ts;
    let a = agg.get(k);
    if (!a) { a = { sku, ts, date, hour, units: 0, gmv: 0, ads: 0, promo: 0, ads_gmv: 0, clicks: 0, impressions: 0, glance_views: 0 }; agg.set(k, a); }
    for (const key of Object.keys(x) as (keyof typeof x)[]) a[key] = r2(a[key] + x[key]);
  }
  // keep hours with some activity (impressions alone do not count)
  return [...agg.values()].filter((a) => a.units || a.gmv || a.ads || a.promo || a.clicks || a.glance_views);
}
