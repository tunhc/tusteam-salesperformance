// Parsing of the new "For_Sales_Incoming_Tracker" workbook. No Deno APIs (tested with Node).
// Writes through inv_upload() / inv_upload_finish() (supabase_inventory_tracking.sql); the mapping
// below is the single definition of how each sheet becomes table rows.
//
//   01_AMZ_incoming_details   → amz_incoming        (hàng về kho Amazon)
//   02_Y4A_incoming_details   → y4a_incoming        (hàng về kho Y4A)
//   04_AMZ_sellable details   → amz_asin            (Vendor Central per ASIN)
//   06_ USA_Sellable INV,
//   07_INT Sellable INV       → inventory_sellable  (row 1 = as-of dates of inv_y4a / inv_amz, row 2 = header)
import { type Cell, openWorkbook, readSheetRows } from "./xlsx.ts";

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function xlDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1 ? null : iso(new Date(Math.round((Math.floor(v) - 25569) * DAY)));
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return xlDate(+s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}
const xlNum = (v: unknown): number | null => (v === null || v === undefined || v === "" || isNaN(+v!) ? null : +v!);
const xlTxt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && !/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?)$/.test(s) ? s : null;
};

type Obj = Record<string, Cell>;
export type TrackerRows = Record<string, Record<string, unknown>[]>;

const incoming = (rows: Obj[], src: "AMZ" | "Y4A") => rows.map((r) => ({
  log_date: xlDate(r.log_date), country: xlTxt(r.country), channel: xlTxt(src === "AMZ" ? r.channel : r.warehouse), po_type: xlTxt(r.po_type),
  po_name: xlTxt(r.po_name), vendor_code: xlTxt(r.vendor_code), sku: xlTxt(r.sku), asin: xlTxt(r.asin), qty: xlNum(src === "AMZ" ? r.qty_incoming : r.incoming_qty),
  eta_salable_date: xlDate(r.eta_salable_date), eta_salable_original: xlDate(r.eta_salable_original), physical_status: xlTxt(r.physical_status),
  on_time_status: xlTxt(r.on_time_status), ordered_date: xlDate(r.ordered_date), container_number: xlTxt(r.container_number), container_type: xlTxt(r.container_type),
  expected_ship_date: xlDate(r.expected_ship_date), actual_ship_date: xlDate(r.actual_ship_date), etd_pol: xlDate(r.etd_pol), atd_pol: xlDate(r.atd_pol),
  eta_pod: xlDate(r.eta_pod), ata_pod: xlDate(src === "AMZ" ? r.actual_port_arrival : r.ata_pod), department: xlTxt(r.department ?? r.dept),
  product_name: xlTxt(r.product_name), product_line: xlTxt(r.product_line), selling_type: xlTxt(r.selling_type), incoming_week: xlTxt(r.incoming_week),
})).filter((r) => r.sku && r.po_name && r.country && r.log_date);

const amzAsin = (rows: Obj[]) => rows.map((r) => ({
  country: xlTxt(r.country), asin: xlTxt(r.asin), sku: xlTxt(r.SKU ?? r.sku), department: xlTxt(r.Department ?? r.department), log_date: xlDate(r.log_date), currency: xlTxt(r.currency),
  sellable_on_hand_units: xlNum(r.sellable_on_hand_inventory_units), sellable_on_hand_value: xlNum(r.sellable_on_hand_inventory_value),
  sellable_in_transit_units: xlNum(r.sellable_in_transit_units), unsellable_on_hand_units: xlNum(r.unsellable_on_hand_inventory_units),
  in_transit_units: xlNum(r.in_transit_units), open_po_units: xlNum(r.open_purchase_order_units), total_sellable: xlNum(r["Total sellable"]),
  net_received_units: xlNum(r.net_received_inventory_units), unfilled_customer_ordered_units: xlNum(r.unfilled_customer_ordered_units),
  confirmed_units: xlNum(r.confirmed_units), aged_90_units: xlNum(r.aged_90_plus_days_sellable_inventory_units),
  procurable_oos_rate: xlNum(r.procurable_product_oos_rate), sourceable_oos_rate: xlNum(r.sourceable_product_oos_rate),
  vendor_confirmation_rate: xlNum(r.vendor_confirmation_rate), receive_fill_rate: xlNum(r.receive_fill_rate), vendor_lead_time_days: xlNum(r.overall_vendor_lead_time_days),
})).filter((r) => r.asin && r.country);

function sellable(arrays: Cell[][]) {
  const out: Record<string, unknown>[] = [];
  const hi = arrays.findIndex((r) => r && r.includes("sku") && r.includes("inv_amz"));
  if (hi < 0) return out;
  const h = arrays[hi], c = (k: string) => h.indexOf(k), top = arrays[hi - 1] || [];
  const y4aAt = xlDate(top[c("inv_y4a")]), amzAt = xlDate(top[c("inv_amz")]);
  for (const r of arrays.slice(hi + 1)) {
    const sku = xlTxt(r[c("sku")]), country = xlTxt(r[c("country")]);
    if (!sku || !country) continue;
    out.push({ country, sku, product_name: xlTxt(r[c("product_name")]), department: xlTxt(r[c("department")]),
      inv_y4a: xlNum(r[c("inv_y4a")]) || 0, inv_amz: xlNum(r[c("inv_amz")]) || 0, y4a_as_of: y4aAt, amz_as_of: amzAt });
  }
  return out;
}

export const isTracker = (sheetNames: string[]) => sheetNames.some((n) => /^01_?AMZ_incoming/i.test(n.trim()));

const COLS = Array.from({ length: 60 }, (_, i) => i);

/** countries: keep only these (null = all). */
export async function parseTracker(bytes: Uint8Array, countries: Set<string> | null = null) {
  const wb = await openWorkbook(bytes);
  const names = wb.sheets.map((s) => s.name);
  const find = (re: RegExp) => names.find((n) => re.test(n.trim()));
  // whole sheet as arrays (first row included)
  const arrays = async (name: string | undefined): Promise<Cell[][]> => {
    if (!name) return [];
    const rows: Cell[][] = [];
    await readSheetRows(bytes, (h) => { rows.push(h.map((x) => (x === "" ? null : x))); return COLS; }, (c) => rows.push(c), name, wb);
    return rows;
  };
  const objects = async (name: string | undefined): Promise<Obj[]> => {
    const a = await arrays(name);
    if (!a.length) return [];
    const head = a[0].map((x) => (x === null || x === undefined ? "" : String(x)));
    return a.slice(1).map((r) => { const o: Obj = {}; head.forEach((k, i) => { if (k) o[k] = r[i] ?? null; }); return o; });
  };
  const warn: string[] = [];
  const rows: TrackerRows = {};
  const keep = <T extends Record<string, unknown>>(l: T[]) => (countries ? l.filter((r) => countries.has(String(r.country))) : l);
  const sA = find(/^01_?AMZ_incoming/i), sY = find(/^02_?Y4A_incoming/i), sZ = find(/^04_?AMZ_sellable/i);
  if (sA) rows.amz_incoming = keep(incoming(await objects(sA), "AMZ")); else warn.push("Không thấy sheet 01_AMZ_incoming_details");
  if (sY) rows.y4a_incoming = keep(incoming(await objects(sY), "Y4A")); else warn.push("Không thấy sheet 02_Y4A_incoming_details");
  const sell = [...sellable(await arrays(find(/^06_?\s*USA_?Sellable/i))), ...sellable(await arrays(find(/^07_?\s*INT_?Sellable/i)))];
  if (sell.length) rows.inventory_sellable = keep(sell); else warn.push("Không thấy sheet 06/07 Sellable INV");
  if (sZ) rows.amz_asin = keep(amzAsin(await objects(sZ)));
  return { rows, warn, sheets: names };
}
