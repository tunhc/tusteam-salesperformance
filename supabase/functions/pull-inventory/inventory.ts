// Pure parsing of the "Yes4All_US_Inventory" workbook, sheet "report". No Deno APIs here (tested with Node).
// Same mapping as ingest_v2.py (load_inventory_report / asin_inventory_rows), so a manual
// load and an automatic load produce identical rows.
//
// Sheet layout (header on row 4):
//   row 1  "Page refreshed at 2026-10-08 19:56" · group labels "incoming_y4a" / "incoming_amazon_asin"
//   row 2  update time of Y4A stock (under "SALABLE Y4A") and AMZ stock · week start (Sunday) per incoming column
//   row 3  week end (Saturday)
//   row 4  SKU | ASIN | ASIN STATUS | DEP. | … | SALABLE Y4A | SALABLE AMZ | … | Incoming Y4A | Incoming AMZ | … | incoming_YYYY_WW × 2
//   row 5+ one row per SKU × ASIN. Y4A stock / incoming are per SKU and repeated on every ASIN row;
//          AMZ stock / incoming are per ASIN.

export type Cell = string | number | null;
export type SkuInv = { sku: string; salable_y4a: number; salable_amz: number; asin_status: string | null };
export type IncomingRow = { sku: string; week_start: string; qty_y4a: number; qty_amz: number };
export type AsinInv = { sku: string; asin: string; asin_status: string | null; dep: string; salable_y4a: number; salable_amz: number;
  incoming_y4a: number; incoming_amz: number; snapshot_at: string | null };

const n = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return 0;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};
const t = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/ /g, " ").trim();
  return s && s !== "<NA>" ? s : null;
};

// Excel serial (date + time) or "YYYY-MM-DD[ HH:MM]" text → "YYYY-MM-DD HH:MM:SS" / null
export function isoStamp(v: unknown): string | null {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 1440) * 60000);
    return d.toISOString().slice(0, 19).replace("T", " ");
  }
  const m = String(v ?? "").match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return m ? `${m[1]} ${m[2] ?? "00:00"}:00` : null;
}

/** Collects the sheet rows (header row included) and turns them into table rows. */
export function makeInventoryParser() {
  const top: Cell[][] = [];                   // rows before the header
  let head: string[] | null = null;
  let col: Record<string, number> = {}, y4aCols: number[] = [], amzCols: number[] = [], week: (string | null)[] = [];
  const perSku = new Map<string, SkuInv>();
  const incoming = new Map<string, IncomingRow>();
  const asins: AsinInv[] = [];
  const asinSeen = new Set<string>();
  let rowsIn = 0, snapshotAt: string | null = null, amzAt: string | null = null;

  const addInc = (sku: string, c: number, q: number, k: "qty_y4a" | "qty_amz") => {
    const wk = week[c];
    if (!q || !wk) return;
    const key = sku + "|" + wk;
    const r = incoming.get(key) ?? { sku, week_start: wk, qty_y4a: 0, qty_amz: 0 };
    r[k] += q;
    incoming.set(key, r);
  };

  function setHeader(h: string[]) {
    head = h;
    h.forEach((x, i) => { if (x && !x.startsWith("incoming_")) col[x] ??= i; });
    for (const need of ["SKU", "ASIN", "SALABLE Y4A", "SALABLE AMZ"]) if (!(need in col)) throw new Error(`Sheet report thiếu cột ${need}`);
    const inc = h.flatMap((x, i) => (x.startsWith("incoming_") ? [i] : []));
    // Y4A block first, then AMZ; the AMZ block starts under the "incoming_amazon…" group label
    const amzStart = top[0]?.findIndex((x) => /^incoming_am/i.test(String(x ?? "")));
    const split = amzStart !== undefined && amzStart > 0 && inc.includes(amzStart) ? inc.indexOf(amzStart) : inc.length / 2;
    y4aCols = inc.slice(0, split); amzCols = inc.slice(split);
    // week start: first row above the header with a date in every incoming column
    const wr = top.find((r) => inc.length > 0 && inc.every((c) => isoStamp(r[c])));
    week = [];
    for (const c of inc) week[c] = wr ? isoStamp(wr[c])!.slice(0, 10) : null;
    const pageRefresh = isoStamp(top[0]?.[0]);
    const timeRow = top.find((r) => isoStamp(r[col["SALABLE Y4A"]]));
    snapshotAt = (timeRow && isoStamp(timeRow[col["SALABLE Y4A"]])) || pageRefresh;
    amzAt = timeRow ? isoStamp(timeRow[col["SALABLE AMZ"]]) : null;
  }

  return {
    add(cells: Cell[]) {
      if (!head) {
        const s = cells.map((c) => (c === null || c === undefined ? "" : String(c).trim()));
        if (s.includes("SKU") && s.includes("SALABLE Y4A")) setHeader(s);
        else top.push(cells);
        return;
      }
      const sku = t(cells[col["SKU"]]);
      if (!sku) return;
      rowsIn++;
      const status = col["ASIN STATUS"] !== undefined ? t(cells[col["ASIN STATUS"]]) : null;
      let rec = perSku.get(sku);
      if (!rec) {
        rec = { sku, salable_y4a: n(cells[col["SALABLE Y4A"]]), salable_amz: 0, asin_status: null };
        perSku.set(sku, rec);
        for (const c of y4aCols) addInc(sku, c, n(cells[c]), "qty_y4a");
      }
      rec.salable_amz += n(cells[col["SALABLE AMZ"]]);
      if (status === "active" || rec.asin_status === null) rec.asin_status = status;
      for (const c of amzCols) addInc(sku, c, n(cells[c]), "qty_amz");

      const asin = t(cells[col["ASIN"]]);
      const dep = col["DEP."] !== undefined ? t(cells[col["DEP."]]) : null;
      if (asin && /^B0[0-9A-Z]{8}$/.test(asin) && dep === "SSO" && !asinSeen.has(sku + "|" + asin)) {
        asinSeen.add(sku + "|" + asin);
        asins.push({ sku, asin, asin_status: status, dep, salable_y4a: n(cells[col["SALABLE Y4A"]]), salable_amz: n(cells[col["SALABLE AMZ"]]),
          incoming_y4a: n(cells[col["Incoming Y4A"]]), incoming_amz: n(cells[col["Incoming AMZ"]]), snapshot_at: null });
      }
    },
    finish() {
      if (!head) throw new Error("Không tìm thấy dòng tiêu đề (SKU, SALABLE Y4A) trong sheet report");
      const pageRefresh = isoStamp(top[0]?.[0]);
      for (const a of asins) a.snapshot_at = pageRefresh ?? snapshotAt;
      return {
        snapshotDate: (snapshotAt ?? new Date().toISOString()).slice(0, 10),
        snapshotAt, amzAt, pageRefresh, rowsIn,
        weeks: [...new Set(week.filter(Boolean))].sort() as string[],
        skus: [...perSku.values()],
        incoming: [...incoming.values()],
        asins,
      };
    },
  };
}
