// Minimal streaming .xlsx reader for Edge Functions (256 MB memory, ~2 s CPU).
// SheetJS builds the whole workbook in memory and runs out on the ~5 MB hourly
// export, so this reads the zip directly: shared strings are loaded once, then
// the worksheet XML is inflated as a stream and handed over row by row.
// Works in Deno and Node 18+ (DecompressionStream, TextDecoder).

export type Cell = string | number | null;

type Entry = { name: string; method: number; offset: number; size: number };

function zipEntries(b: Uint8Array): Map<string, Entry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("File không phải .xlsx hợp lệ (không đọc được zip)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Entry>();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    // data starts after the local header, whose name/extra lengths may differ from the central one
    const offset = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.set(name, { name, method, offset, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryStream(b: Uint8Array, e: Entry): ReadableStream<string> {
  const raw = new Blob([b.subarray(e.offset, e.offset + e.size) as BlobPart]).stream();
  const bytes = e.method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw;
  return bytes.pipeThrough(new TextDecoderStream());
}

async function entryText(b: Uint8Array, e: Entry): Promise<string> {
  let s = "";
  const reader = entryStream(b, e).getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; s += value; }
  return s;
}

const unescape = (s: string) => s.indexOf("&") < 0 ? s : s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, "&");

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const si = /<si>([\s\S]*?)<\/si>/g, t = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = si.exec(xml))) {
    let s = "", x: RegExpExecArray | null;
    t.lastIndex = 0;
    while ((x = t.exec(m[1]))) s += x[1];
    out.push(unescape(s));
  }
  return out;
}

// Worksheets in workbook order: [{name, path}]
async function sheetList(b: Uint8Array, zip: Map<string, Entry>): Promise<{ name: string; path: string }[]> {
  const wb = zip.get("xl/workbook.xml"), rels = zip.get("xl/_rels/workbook.xml.rels");
  if (!wb || !rels) return [...zip.keys()].filter((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)).sort().map((path) => ({ name: path, path }));
  const relXml = await entryText(b, rels), wbXml = await entryText(b, wb);
  const target = new Map<string, string>();
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1], t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : "xl/" + t);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? m[0].match(/\bid="([^"]+)"/)?.[1];
    const path = rid ? target.get(rid) : undefined;
    if (path && zip.has(path)) out.push({ name, path });
  }
  return out;
}

/**
 * Streams the rows of the first sheet (or `wanted`) whose first row is accepted:
 * `accept(header)` returns false to skip the sheet, or the column indexes to read.
 * onRow gets each later row as an array aligned with the header (unread columns empty).
 * Returns the chosen sheet name and its header, or null if no sheet matched.
 */
export async function readSheetRows(
  b: Uint8Array,
  accept: (header: string[]) => false | number[],
  onRow: (cells: Cell[]) => void,
  wanted?: string,
): Promise<{ sheet: string; header: string[]; sheets: string[] } | null> {
  const zip = zipEntries(b);
  const sstEntry = zip.get("xl/sharedStrings.xml");
  const sst = sstEntry ? sharedStrings(await entryText(b, sstEntry)) : [];
  const sheets = await sheetList(b, zip);
  const order = wanted && sheets.some((s) => s.name === wanted) ? sheets.filter((s) => s.name === wanted) : sheets;

  // Cells of one <row>…</row> body. indexOf scanning, not regex: this loop is the
  // CPU hot spot (tens of MB of XML) and Edge Functions get ~2 s of CPU.
  const parseRow = (xml: string, need: Uint8Array | null): Cell[] => {
    const cells: Cell[] = [];
    let pos = 0, next = 0;
    for (;;) {
      const i = xml.indexOf("<c", pos);
      if (i < 0) break;
      const gt = xml.indexOf(">", i);
      if (gt < 0) break;
      const self = xml.charCodeAt(gt - 1) === 47; // "/>"
      const attrs = xml.slice(i + 2, self ? gt - 1 : gt);
      let idx = next;
      const ri = attrs.indexOf('r="');
      if (ri >= 0) {
        idx = 0;
        for (let k = ri + 3; k < attrs.length; k++) {
          const c = attrs.charCodeAt(k);
          if (c < 65 || c > 90) break;
          idx = idx * 26 + (c - 64);
        }
        idx--;
      }
      next = idx + 1;
      if (self) { pos = gt + 1; continue; }
      const end = xml.indexOf("</c>", gt);
      if (end < 0) break;
      pos = end + 4;
      if (need && !need[idx]) continue;
      const body = xml.slice(gt + 1, end);
      const ti = attrs.indexOf('t="');
      const t = ti >= 0 ? attrs.slice(ti + 3, attrs.indexOf('"', ti + 3)) : "";
      if (t === "inlineStr") {
        let s = "";
        for (const x of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += x[1];
        cells[idx] = unescape(s);
        continue;
      }
      const vs = body.indexOf("<v>");
      if (vs < 0) { cells[idx] = null; continue; }
      const v = body.slice(vs + 3, body.indexOf("</v>", vs));
      if (t === "s") cells[idx] = sst[+v] ?? null;
      else if (t === "str" || t === "e") cells[idx] = unescape(v);
      else if (t === "b") cells[idx] = v === "1" ? 1 : 0;
      else { const x = +v; cells[idx] = Number.isFinite(x) ? x : unescape(v); }
    }
    return cells;
  };

  for (const s of order) {
    const reader = entryStream(b, zip.get(s.path)!).getReader();
    let buf = "", header: string[] | null = null, need: Uint8Array | null = null, rejected = false;
    const flush = () => {
      let start = 0;
      for (;;) {
        const open = buf.indexOf("<row", start);
        if (open < 0) break;
        const gt = buf.indexOf(">", open);
        if (gt < 0) break;
        if (buf.charCodeAt(gt - 1) === 47) { start = gt + 1; continue; } // <row …/> (empty)
        const close = buf.indexOf("</row>", gt);
        if (close < 0) break;
        start = close + 6;
        const cells = parseRow(buf.slice(gt + 1, close), need);
        if (!header) {
          header = Array.from(cells, (c) => (c === null || c === undefined ? "" : String(c)));
          const cols = accept(header);
          if (!cols) { rejected = true; return; }
          need = new Uint8Array(header.length + 1);
          for (const c of cols) need[c] = 1;
        } else if (cells.length) onRow(cells);
      }
      buf = buf.slice(start);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      flush();
      if (rejected) { await reader.cancel(); break; }
    }
    if (header && !rejected) return { sheet: s.name, header, sheets: sheets.map((x) => x.name) };
  }
  return null;
}
