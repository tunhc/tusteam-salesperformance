// Pure parsing / aggregation of the sales exports. No Deno APIs here (tested with Node).
// Same mapping as ingest_v2.py (hourly_month_rows / hourly_hour_sql / load_daily),
// so a manual load and an automatic load produce identical rows.
//
// Three exports, told apart by their header (matched case-insensitively,
// "Ordered GMV" = "ordered_gmv"):
//  - "SSO Data Extraction Hourly": one row per SKU per day (date), ordered_gmv, total_ads, total_promo
//  - "usa_amz_sso_hourly -- usa": one row per SKU per hour (date_time_local), glance_view,
//    no ordered_gmv (GMV falls back to ordered_nmv), no totals (ads/promo summed from their parts).
//    Also gives hour-level rows for sales_hourly (live race).
//  - "Yes4All_data_tusteam_<year>_daily" (kind "daily"): one row per SKU per day (Day), Ordered GMV,
//    Total ADS / Total Promo, Glance_views, Ordered_revenue, dsp/aff spend, product_line.

export type Row = Record<string, unknown>;
export type Cell = string | number | null;
export type DayRow = {
  sku: string; date: string; units: number; gmv: number; ordered_nmv: number; ads: number; promo: number;
  ads_gmv: number; ads_units: number; total_clicks: number; total_impressions: number; glance_views: number;
  ordered_revenue: number; sp_spend: number; sb_spend: number; sd_spend: number; dsp_spend: number; aff_spend: number;
  promo_deal: number; promo_coupon: number; promo_discount: number; category: string | null; source_file: string;
};
export type HourRow = { sku: string; ts: string; date: string; hour: number; units: number; gmv: number; ads: number; promo: number;
  ads_gmv: number; clicks: number; impressions: number; glance_views: number };

const n = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};

// "Ordered GMV " → "ordered_gmv"
export const normKey = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, "_");

// Excel stores times as fractions of a day and 01:00 can come back as 00:59:59.999:
// snap to the minute before taking the day or the hour.
const snapSerial = (v: number) => Math.round(v * 1440) / 1440;
const pad = (x: number) => String(x).padStart(2, "0");

// Excel serial number, Date, or "YYYY-MM-DD..." / "M/D/YYYY" text → "YYYY-MM-DD"
export function isoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const d = new Date(Math.round(v.getTime() / 60000) * 60000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(snapSerial(v)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

// Hour of day (0-23) from an Excel serial, Date or "… HH:MM" text; null if there is no time.
export function hourOf(v: unknown): number | null {
  if (v instanceof Date && !isNaN(v.getTime())) return new Date(Math.round(v.getTime() / 60000) * 60000).getHours();
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const t = snapSerial(v);
    return Math.floor((t - Math.floor(t)) * 24 + 1e-9);
  }
  const m = String(v ?? "").match(/[ T](\d{1,2}):\d{2}/);
  return m ? +m[1] : null;
}

const r2 = (x: number) => Math.round(x * 10000) / 10000;

// SKU match ignores case and invisible characters (some skus rows carry a zero-width space).
export const skuKey = (v: unknown) => String(v ?? "").replace(/[​-‍﻿\s]/g, "").toUpperCase();

const DATE_KEYS = ["date", "day", "order_date", "report_date"];
const TIME_KEYS = ["date_time_local", "datetime", "date_time"];

// Header names (normalized) the aggregator reads; other columns are not parsed.
const USED_KEYS = new Set([
  "sku", "country", "main_category", "product_line", "ordered_units", "ordered_gmv", "ordered_revenue_gmv", "ordered_nmv",
  "ordered_revenue", "total_ads", "total_promo", "glance_views", "glance_view",
  "sb_ordered_nmv", "sd_ordered_nmv", "sp_ordered_nmv", "sb_ordered_units", "sd_ordered_units", "sp_ordered_units",
  "sb_clicks", "sd_clicks", "sp_clicks", "sb_impressions", "sd_impressions", "sp_impressions",
  "sp_spend", "sb_spend", "sd_spend", "dsp_spend", "aff_spend",
  "best_deal_spend", "lightning_deal_spend", "vm_promo_spend", "coupon_spend", "price_discount_spend",
]);

export type Layout = {
  kind: "hourly" | "daily"; dateKey: string; timeKey: string | null; gmvKey: string;
  hasTotals: { ads: boolean; promo: boolean }; hasCountry: boolean; columns: string[];
};

// Header row → layout, or a list of what is missing.
export function layoutOf(keys: string[]): Layout | { missing: string[] } {
  const has = (k: string) => keys.includes(k);
  const timeKey = TIME_KEYS.find(has) ?? null;
  const dateKey = DATE_KEYS.find(has) ?? timeKey ?? keys.find((k) => k.includes("date"));
  const gmvKey = ["ordered_gmv", "ordered_revenue_gmv", "ordered_nmv"].find(has);
  const missing = [!has("sku") && "sku", !dateKey && "date/day/date_time_local", !has("ordered_units") && "ordered_units",
    !gmvKey && "ordered_gmv/ordered_nmv"].filter((x): x is string => !!x);
  if (missing.length) return { missing };
  // the tusteam daily export: a "day" column and the product_line / ordered_revenue columns
  const kind = !timeKey && has("day") && (has("product_line") || has("ordered_revenue")) ? "daily" : "hourly";
  return { kind, dateKey: dateKey!, timeKey, gmvKey: gmvKey!, hasCountry: has("country"),
    hasTotals: { ads: has("total_ads"), promo: has("total_promo") }, columns: keys };
}

// Column indexes worth parsing for this layout.
export const wantedColumns = (L: Layout) =>
  L.columns.map((k, i) => [i, k] as const).filter(([, k]) => USED_KEYS.has(k) || k === L.dateKey || k === L.timeKey);

// Streaming aggregator: add() each row (keys normalized), then finish().
// managed: our SKU codes; file SKUs are matched with skuKey and stored under our spelling.
// Skips are counted per reason, with the first skipped row per reason, so a 0-row load says why.
export function makeAggregator(managedSkus: Iterable<string>, sourceFile: string, L: Layout) {
  const managed = new Map<string, string>();
  for (const s of managedSkus) if (!managed.has(skuKey(s))) managed.set(skuKey(s), s);
  const days = new Map<string, DayRow>();
  const hours = new Map<string, HourRow>();
  let rowsIn = 0, skipped = 0;
  const why = { notUsa: 0, noSku: 0, noDate: 0, unmanagedSku: 0 };
  const sample: Record<string, Row> = {};
  const sum = (r: Row, ...ks: string[]) => { let t = 0; for (const k of ks) t += n(r[k]); return t; };
  const daily = L.kind === "daily";

  const add = (r: Row) => {
    rowsIn++;
    const raw = skuKey(r.sku);
    const sku = managed.get(raw);
    const date = isoDate(r[L.dateKey]);
    const reason = L.hasCountry && !/^(usa|us)$/i.test(String(r.country ?? "").trim()) ? "notUsa"
      : !raw ? "noSku" : !sku ? "unmanagedSku" : !date ? "noDate" : null;
    if (reason) { skipped++; why[reason]++; sample[reason] ??= r; return; }

    const units = n(r.ordered_units), gmv = n(r[L.gmvKey]);
    const ads = L.hasTotals.ads ? n(r.total_ads) : sum(r, "sb_spend", "sd_spend", "sp_spend");
    const promo = L.hasTotals.promo ? n(r.total_promo)
      : sum(r, "coupon_spend", "price_discount_spend", "lightning_deal_spend", "best_deal_spend", "vm_promo_spend");
    const adsGmv = sum(r, "sb_ordered_nmv", "sd_ordered_nmv", "sp_ordered_nmv");
    const clicks = sum(r, "sb_clicks", "sd_clicks", "sp_clicks");
    const impressions = sum(r, "sb_impressions", "sd_impressions", "sp_impressions");
    const gv = n(r.glance_views ?? r.glance_view);

    const k = sku + "|" + date;
    let a = days.get(k);
    if (!a) {
      const cat = daily ? r.product_line : r.main_category;
      a = { sku: sku!, date: date!, units: 0, gmv: 0, ordered_nmv: 0, ads: 0, promo: 0, ads_gmv: 0, ads_units: 0, total_clicks: 0,
        total_impressions: 0, glance_views: 0, ordered_revenue: 0, sp_spend: 0, sb_spend: 0, sd_spend: 0, dsp_spend: 0, aff_spend: 0,
        promo_deal: 0, promo_coupon: 0, promo_discount: 0, category: cat ? String(cat) : null, source_file: sourceFile };
      days.set(k, a);
    }
    a.units += units; a.gmv += gmv; a.ordered_nmv += n(r.ordered_nmv); a.ads += ads; a.promo += promo;
    a.ads_gmv += adsGmv; a.ads_units += sum(r, "sb_ordered_units", "sd_ordered_units", "sp_ordered_units");
    a.total_clicks += clicks; a.total_impressions += impressions; a.glance_views += gv;
    a.sp_spend += n(r.sp_spend); a.sb_spend += n(r.sb_spend); a.sd_spend += n(r.sd_spend);
    a.promo_coupon += n(r.coupon_spend);
    if (daily) { // ingest_v2.load_daily
      a.ordered_revenue += n(r.ordered_revenue); a.dsp_spend += n(r.dsp_spend); a.aff_spend += n(r.aff_spend);
      a.promo_deal += sum(r, "best_deal_spend", "lightning_deal_spend");
      a.promo_discount += sum(r, "price_discount_spend", "vm_promo_spend");
    } else {     // ingest_v2.hourly_month_rows
      a.promo_deal += sum(r, "best_deal_spend", "lightning_deal_spend", "vm_promo_spend");
      a.promo_discount += n(r.price_discount_spend);
    }

    if (L.timeKey) {
      const hour = hourOf(r[L.timeKey]);
      if (hour === null) return;
      const ts = `${date} ${pad(hour)}:00:00`, hk = sku + "|" + ts;
      let h = hours.get(hk);
      if (!h) { h = { sku: sku!, ts, date: date!, hour, units: 0, gmv: 0, ads: 0, promo: 0, ads_gmv: 0, clicks: 0, impressions: 0, glance_views: 0 }; hours.set(hk, h); }
      h.units += units; h.gmv += gmv; h.ads += ads; h.promo += promo; h.ads_gmv += adsGmv;
      h.clicks += clicks; h.impressions += impressions; h.glance_views += gv;
    }
  };

  const round = <T extends object>(o: T): T => {
    const x = { ...o } as Record<string, unknown>;
    for (const [k, v] of Object.entries(x)) if (typeof v === "number" && k !== "hour") x[k] = r2(v);
    return x as T;
  };
  const finish = () => ({
    out: [...days.values()].map(round),
    // hours with some activity only (impressions alone do not count), as ingest_v2.hourly_hour_sql
    hours: [...hours.values()].filter((h) => h.units || h.gmv || h.ads || h.promo || h.clicks || h.glance_views).map(round),
    rowsIn, skipped, why, sample,
  });
  return { add, finish };
}

// Whole-array convenience wrapper (tests, small files).
export function aggregate(rawRows: Row[], managed: Iterable<string>, sourceFile: string) {
  const rows = rawRows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normKey(k), v])));
  const L = layoutOf(rows.length ? Object.keys(rows[0]) : []);
  if ("missing" in L) throw new Error("File thiếu cột: " + L.missing.join(", "));
  const a = makeAggregator(managed, sourceFile, L);
  for (const r of rows) a.add(r);
  return { ...a.finish(), layout: L };
}

// Totals per day, for the response and the log.
export function perDay(out: DayRow[]) {
  const m = new Map<string, { date: string; skus: number; units: number; gmv: number; ads: number; promo: number; glance_views: number }>();
  for (const r of out) {
    const d = m.get(r.date) ?? { date: r.date, skus: 0, units: 0, gmv: 0, ads: 0, promo: 0, glance_views: 0 };
    d.skus++; d.units += r.units; d.gmv += r.gmv; d.ads += r.ads; d.promo += r.promo; d.glance_views += r.glance_views;
    m.set(r.date, d);
  }
  const c = (x: number) => Math.round(x * 100) / 100;
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, units: Math.round(d.units), gmv: c(d.gmv), ads: c(d.ads), promo: c(d.promo), glance_views: Math.round(d.glance_views) }));
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
