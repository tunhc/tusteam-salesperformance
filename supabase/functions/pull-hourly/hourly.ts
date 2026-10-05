// Pure parsing / aggregation of the "SSO Data Extraction Hourly" sheet.
// Same mapping as ingest_v2.py (hourly_month_rows), so a manual load and an
// automatic load produce identical rows. No Deno APIs here (tested with Node).
//
// Headers are matched case-insensitively ("Ordered_units" = "ordered_units").
// Newer exports have no ordered_gmv column: gmv then falls back to ordered_nmv.

export type Row = Record<string, unknown>;
export type DayRow = {
  sku: string; date: string; units: number; gmv: number; ordered_nmv: number; ads: number; promo: number;
  ads_gmv: number; ads_units: number; total_clicks: number; total_impressions: number; glance_views: number;
  sp_spend: number; sb_spend: number; sd_spend: number; promo_deal: number; promo_coupon: number; promo_discount: number;
  category: string | null; source_file: string;
};

const n = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

// "Ordered Units " → "ordered_units"
const normKey = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, "_");
export const normalize = (rows: Row[]): Row[] =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normKey(k), v])));

// Excel serial number, Date, or "YYYY-MM-DD..." / "M/D/YYYY" text → "YYYY-MM-DD"
export function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
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
const first = (r: Row, keys: string[]) => { for (const k of keys) if (k in r) return r[k]; return undefined; };
const DATE_KEYS = ["date", "order_date", "report_date", "day"];
const GLANCE_KEYS = ["glance_views", "glance_view", "glanceviews"];

// Streaming version: feed rows one at a time (keys already normalized).
export function makeAggregator(managed: Set<string>, sourceFile: string, hasGmv: boolean) {
  const agg = new Map<string, DayRow>();
  let rowsIn = 0, skipped = 0;
  const add = (r: Row) => {
    rowsIn++;
    const sku = String(r.sku ?? "").trim();
    const date = isoDate(first(r, DATE_KEYS));
    if (!sku || !date || !managed.has(sku)) { skipped++; return; }
    const k = sku + "|" + date;
    let a = agg.get(k);
    if (!a) {
      a = { sku, date, units: 0, gmv: 0, ordered_nmv: 0, ads: 0, promo: 0, ads_gmv: 0, ads_units: 0, total_clicks: 0, total_impressions: 0,
        glance_views: 0, sp_spend: 0, sb_spend: 0, sd_spend: 0, promo_deal: 0, promo_coupon: 0, promo_discount: 0,
        category: r.main_category ? String(r.main_category) : null, source_file: sourceFile };
      agg.set(k, a);
    }
    a.units += n(r.ordered_units); a.ordered_nmv += n(r.ordered_nmv);
    a.gmv += n(hasGmv ? r.ordered_gmv : r.ordered_nmv);
    a.ads += n(r.total_ads); a.promo += n(r.total_promo);
    a.ads_gmv += n(r.sb_ordered_nmv) + n(r.sd_ordered_nmv) + n(r.sp_ordered_nmv);
    a.ads_units += n(r.sb_ordered_units) + n(r.sd_ordered_units) + n(r.sp_ordered_units);
    a.total_clicks += n(r.sb_clicks) + n(r.sd_clicks) + n(r.sp_clicks);
    a.total_impressions += n(r.sb_impressions) + n(r.sd_impressions) + n(r.sp_impressions);
    a.glance_views += n(first(r, GLANCE_KEYS));
    a.sp_spend += n(r.sp_spend); a.sb_spend += n(r.sb_spend); a.sd_spend += n(r.sd_spend);
    a.promo_deal += n(r.best_deal_spend) + n(r.lightning_deal_spend) + n(r.vm_promo_spend);
    a.promo_coupon += n(r.coupon_spend); a.promo_discount += n(r.price_discount_spend);
  };
  const finish = () => {
    const out = [...agg.values()].map((a) => {
      const o = { ...a } as Record<string, unknown>;
      for (const [k, v] of Object.entries(o)) if (typeof v === "number") o[k] = r2(v);
      return o as DayRow;
    });
    return { out, rowsIn, skipped, gmvColumn: hasGmv ? "ordered_gmv" : "ordered_nmv" };
  };
  return { add, finish };
}

// Header names (normalized) the aggregator reads; other columns are ignored.
export const USED_KEYS = new Set([
  "sku", "main_category", "ordered_units", "ordered_gmv", "ordered_nmv", "total_ads", "total_promo",
  "sb_ordered_nmv", "sd_ordered_nmv", "sp_ordered_nmv", "sb_ordered_units", "sd_ordered_units", "sp_ordered_units",
  "sb_clicks", "sd_clicks", "sp_clicks", "sb_impressions", "sd_impressions", "sp_impressions",
  "sp_spend", "sb_spend", "sd_spend", "best_deal_spend", "lightning_deal_spend", "vm_promo_spend", "coupon_spend", "price_discount_spend",
  ...DATE_KEYS, ...GLANCE_KEYS,
]);
export { normKey };

// rows must already be normalize()d
export function aggregate(rows: Row[], managed: Set<string>, sourceFile: string) {
  const a = makeAggregator(managed, sourceFile, rows.length > 0 && "ordered_gmv" in rows[0]);
  for (const r of rows) a.add(r);
  return a.finish();
}

// Totals per day, for the dry-run response
export function perDay(out: DayRow[]) {
  const m = new Map<string, { date: string; skus: number; units: number; gmv: number; ads: number; promo: number; glance_views: number }>();
  for (const r of out) {
    const d = m.get(r.date) ?? { date: r.date, skus: 0, units: 0, gmv: 0, ads: 0, promo: 0, glance_views: 0 };
    d.skus++; d.units += r.units; d.gmv += r.gmv; d.ads += r.ads; d.promo += r.promo; d.glance_views += r.glance_views;
    m.set(r.date, d);
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, units: Math.round(d.units), gmv: Math.round(d.gmv * 100) / 100, ads: Math.round(d.ads * 100) / 100, promo: Math.round(d.promo * 100) / 100, glance_views: Math.round(d.glance_views) }));
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
