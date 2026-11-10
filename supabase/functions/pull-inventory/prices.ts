// Price files for the "Nhảy giá" check on Tracking Target. No Deno APIs (tested with Node).
//
//  • Keepa export (US_Keepa_Raw_Auto.xlsx, sheet "Data"): row 1 "Page refreshed at …", row 2 header.
//    Column E = ASIN of the listing, column Z = "Buy Box: Current" (the price on the listing now).
//    Column A = SKU, column C = "Last update". → replace_keepa_prices()
//  • Optimal pricing (Yes4All_Optimal_Pricing_SKU.xlsx, sheet "Optimal pricing"): column B = SKU,
//    C = ASIN, A = PIC, U = "RRP tham chiếu" (the fixed reference price). → replace_price_reference()
import { type Cell, type Workbook, readSheetRows } from "./xlsx.ts";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
};
const txt = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
const stamp = (v: unknown): string | null => {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 1440) * 60000).toISOString().slice(0, 19);
  const m = String(v ?? "").match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return m ? `${m[1]}T${m[2] ?? "00:00"}:00` : null;
};
const ASIN = /^B0[0-9A-Z]{8}$/;
const COLS = Array.from({ length: 80 }, (_, i) => i);

async function sheetArrays(bytes: Uint8Array, wb: Workbook, name: string, maxRows = Infinity): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  await readSheetRows(bytes, (h) => { rows.push(h.map((x) => (x === "" ? null : x))); return COLS; }, (c) => { if (rows.length < maxRows) rows.push(c); }, name, wb);
  return rows;
}

/** Name of the sheet that looks like a Keepa export, or null. Reads only the first row of each sheet
 *  (the export starts with "Commercial Input … Page refreshed at …", or directly with the header). */
export async function findKeepaSheet(bytes: Uint8Array, wb: Workbook): Promise<string | null> {
  for (const s of wb.sheets) {
    let first: string[] = [];
    await readSheetRows(bytes, (h) => { first = h; return false; }, () => {}, s.name, wb);   // false: stop after the first row
    if (first.some((c) => /^(Buy Box: Current|Commercial Input)$/.test(String(c ?? "").trim()))) return s.name;
  }
  return null;
}

export async function parseKeepa(bytes: Uint8Array, wb: Workbook, sheet: string) {
  const a = await sheetArrays(bytes, wb, sheet);
  const hi = a.findIndex((r) => r && r.some((c) => String(c ?? "").trim() === "Buy Box: Current"));
  if (hi < 0) throw new Error("Không thấy dòng tiêu đề có 'Buy Box: Current'");
  const h = a[hi].map((c) => String(c ?? "").trim());
  const at = (name: string, fallback: number) => { const i = h.indexOf(name, name === "ASIN" ? 2 : 0); return i >= 0 ? i : fallback; };
  // column E (index 4) = listing ASIN, column Z (index 25) = Buy Box: Current, as agreed; header names win when they moved
  const cA = h[4] === "ASIN" ? 4 : at("ASIN", 4), cZ = h[25] === "Buy Box: Current" ? 25 : at("Buy Box: Current", 25);
  const c = { sku: at("SKU", 0), upd: at("Last update", 2), bb30: at("Buy Box: 30 days avg.", -1), bb90: at("Buy Box: 90 days avg.", -1), seller: at("Buy Box: Buy Box Seller", -1),
    amz: at("Amazon: Current", -1), newc: at("New: Current", -1), rank: at("Sales Rank: Current", -1), rating: at("Reviews: Rating", -1), rc: at("Reviews: Rating Count", -1) };
  const refreshed = txt(a.slice(0, hi).flat().find((x) => /refreshed/i.test(String(x ?? ""))));
  const g = (r: Cell[], i: number) => (i >= 0 ? r[i] : null);
  const rows = a.slice(hi + 1).map((r) => ({
    asin: txt(r[cA]), sku: txt(g(r, c.sku)), buybox_current: num(r[cZ]), buybox_30d: num(g(r, c.bb30)), buybox_90d: num(g(r, c.bb90)),
    buybox_seller: txt(g(r, c.seller)), amazon_current: num(g(r, c.amz)), new_current: num(g(r, c.newc)), sales_rank: num(g(r, c.rank)),
    rating: num(g(r, c.rating)), rating_count: num(g(r, c.rc)), keepa_updated_at: stamp(g(r, c.upd)),
  })).filter((r) => r.asin && ASIN.test(r.asin));
  return { rows, refreshed, asinCol: cA, priceCol: cZ };
}

export const isPricing = (sheets: string[]) => sheets.some((n) => /^optimal pricing$/i.test(n.trim()));

export async function parsePricing(bytes: Uint8Array, wb: Workbook) {
  const name = wb.sheets.find((s) => /^optimal pricing$/i.test(s.name.trim()))!.name;
  const a = await sheetArrays(bytes, wb, name);
  const h = (a[0] || []).map((c) => String(c ?? "").trim());
  const at = (n: string, fb: number) => { const i = h.indexOf(n); return i >= 0 ? i : fb; };
  // column U (index 20) = "RRP tham chiếu"
  const cU = h[20] === "RRP tham chiếu" ? 20 : at("RRP tham chiếu", 20);
  const c = { pic: at("PIC", 0), sku: at("SKU", 1), asin: at("ASIN", 2), low: at("RRP lựa chọn - thấp", 21), high: at("RRP lựa chọn - cao", 22), opt: at("ASP phương án (optimal)", 18) };
  const rows = a.slice(1).map((r) => ({ sku: txt(r[c.sku]), asin: txt(r[c.asin]), pic: txt(r[c.pic]), rrp_ref: num(r[cU]), rrp_low: num(r[c.low]), rrp_high: num(r[c.high]), asp_optimal: num(r[c.opt]) }))
    .filter((r) => r.sku);
  return { rows, refCol: cU };
}
