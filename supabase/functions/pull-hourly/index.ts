// Supabase Edge Function: pull-hourly
//
// Loads a sales export (Excel), aggregates it per SKU per day (and per hour when
// the export has a time of day) and replaces exactly the days present in the file:
//   sales_daily  via replace_sales_days (one transaction, other days untouched)
//   sales_hourly via replace_sales_hours (live race on the Tracking tab)
//   sales_asin_daily via replace_sales_asin_days (BTR tab), when the export has an ASIN column;
//   skipped with a note if supabase_btr.sql has not been run yet
// Exports understood (see hourly.ts): "SSO Data Extraction Hourly",
// "usa_amz_sso_hourly -- usa" (hourly, Power Automate every hour) and the
// tusteam daily export ("Yes4All_data_tusteam_<year>_daily", Power Automate daily).
//
// Data the hourly flow never overwrites:
//   - days before data_locks.lock_before (final monthly data; the lock trigger also skips them)
//   - days already loaded from a daily export (source_file containing "daily"): the
//     daily file is the final number with glance views / ordered revenue / DSP.
//
// Two ways to get the file:
//   1. POST the .xlsx as the request body (Power Automate: SharePoint "Get file content"
//      → HTTP, Body = body('Get_file_content_using_path')?['$content']). Optional headers:
//        x-file-name   name stored in sales_daily.source_file (and the ingest_runs log)
//        x-dry-run: 1  parse and return per-day totals, write nothing
//        x-force: 1    load even if the file is unchanged since its last load
//   2. Empty body: download HOURLY_FILE_URL (pg_cron, see supabase_auto_ingest.sql).
//
// Deploy with "Verify JWT" OFF; every request must send x-pull-secret = PULL_SECRET.
// Secrets:
//   PULL_SECRET       random string, required
//   HOURLY_FILE_URL   only for mode 2: the Excel sharing link. Either shared as
//   "Anyone with the link", or set MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET
//   of an Azure app with Microsoft Graph application permission Files.Read.All.
// Optional: HOURLY_SHEET (default: the first sheet with a "sku" column).
// The workbook is read with the streaming reader in xlsx.ts (SheetJS ran out of memory).
import { createClient } from "npm:@supabase/supabase-js@2";
import { downloadUrls, graphShareId, layoutOf, type Layout, makeAggregator, normKey, perDay, type Row, wantedColumns } from "./hourly.ts";
import { readSheetRows } from "./xlsx.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isXlsx = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b; // "PK" zip

async function graphToken(): Promise<string | null> {
  const tenant = Deno.env.get("MS_TENANT_ID"), id = Deno.env.get("MS_CLIENT_ID"), secret = Deno.env.get("MS_CLIENT_SECRET");
  if (!tenant || !id || !secret) return null;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Microsoft login lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function download(link: string): Promise<Uint8Array> {
  const token = await graphToken();
  if (token) {
    const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${graphShareId(link)}/driveItem/content`, { headers: { Authorization: `Bearer ${token}` } });
    const b = new Uint8Array(await res.arrayBuffer());
    if (res.ok && isXlsx(b)) return b;
    throw new Error(`Graph không tải được file (${res.status}). Kiểm tra quyền Files.Read.All / link.`);
  }
  for (const url of downloadUrls(link)) {
    const res = await fetch(url, { redirect: "follow" });
    const b = new Uint8Array(await res.arrayBuffer());
    if (res.ok && isXlsx(b)) return b;
  }
  throw new Error("Link yêu cầu đăng nhập Microsoft nên không tải được. Cần chia sẻ link dạng 'Anyone with the link' (chỉ xem), hoặc cấu hình MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.");
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Request body → xlsx bytes. Accepts raw bytes, bare base64 text, or the
// {"$content": base64} JSON Power Automate sends when the file content is wrapped in an object.
// Empty body or other JSON (pg_cron's {"force": …}) → null: download instead.
function bodyFile(b: Uint8Array): Uint8Array | null {
  if (!b.length) return null;
  if (isXlsx(b)) return b;
  const text = new TextDecoder().decode(b).trim().replace(/^"|"$/g, "");
  if (text.startsWith("UEsDB")) { // bare base64 of the xlsx: body('…')?['$content']
    const bytes = b64ToBytes(text);
    if (isXlsx(bytes)) return bytes;
  }
  let j: unknown;
  try { j = JSON.parse(text); } catch { j = undefined; }
  if (j && typeof j === "object") {
    const o = j as { $content?: unknown; body?: { $content?: unknown } };
    const c = o.$content ?? o.body?.$content;
    if (typeof c !== "string") return null;
    const bytes = b64ToBytes(c);
    if (isXlsx(bytes)) return bytes;
  }
  throw new Error(`Body không phải file .xlsx (bắt đầu bằng "${text.slice(0, 40)}") (${b.length} bytes). Ở action HTTP, Body phải là File Content của bước Get file content.`);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("PULL_SECRET");
  if (!secret || req.headers.get("x-pull-secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const flag = (h: string) => ["1", "true", "yes"].includes((req.headers.get(h) ?? "").trim().toLowerCase());
  const dryRun = flag("x-dry-run");
  let force = flag("x-force");

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const fileName = req.headers.get("x-file-name")?.trim();
  const source = "auto: " + (fileName || Deno.env.get("HOURLY_SOURCE_NAME") || "SSO Data Extraction Hourly");
  const logError = async (message: string) => {
    if (!dryRun) await db.from("ingest_runs").insert({ source, status: "error", message: message.slice(0, 1000) });
  };

  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    let bytes = bodyFile(raw);
    if (!bytes) {
      const link = Deno.env.get("HOURLY_FILE_URL");
      if (!link) throw new Error("Body rỗng: request không kèm file. Ở action HTTP, Body = biểu thức body('Get_file_content_using_path')?['$content']");
      try { force ||= !!JSON.parse(new TextDecoder().decode(raw))?.force; } catch { /* empty body */ }
      bytes = await download(link);
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    const hash = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
    if (!force && !dryRun) {
      const { data: last } = await db.from("ingest_runs").select("file_hash").eq("source", source).eq("status", "ok").order("ran_at", { ascending: false }).limit(1);
      if (last?.[0]?.file_hash === hash) {
        await db.from("ingest_runs").insert({ source, status: "skipped", file_hash: hash, message: "file không đổi" });
        return json({ ok: true, skipped: "file không đổi" });
      }
    }

    const [{ data: skus, error: skuErr }, { data: lock }] = await Promise.all([
      db.from("skus").select("sku"),
      db.from("data_locks").select("lock_before").eq("table_name", "sales_daily").maybeSingle(),
    ]);
    if (skuErr) throw new Error(skuErr.message);
    const managed = (skus ?? []).map((s: { sku: string }) => s.sku);
    const lockBefore: string = lock?.lock_before ?? "0000-01-01";

    // Stream the sheet: only the columns the aggregator reads are parsed.
    let agg: ReturnType<typeof makeAggregator> | null = null, L: Layout | null = null, cols: (readonly [number, string])[] = [];
    const found = await readSheetRows(bytes, (header) => {
      const keys = header.map(normKey);
      if (!keys.includes("sku")) return false;
      const lay = layoutOf(keys);
      if ("missing" in lay) throw new Error(`File thiếu cột: ${lay.missing.join(", ")} (có: ${keys.join(", ")})`);
      L = lay;
      cols = wantedColumns(lay);
      agg = makeAggregator(managed, source, lay);
      return cols.map(([i]) => i);
    }, (cells) => {
      const r: Row = {};
      for (const [i, k] of cols) r[k] = cells[i] ?? null;
      agg!.add(r);
    }, Deno.env.get("HOURLY_SHEET") || undefined);
    if (!found || !agg || !L) throw new Error("Không tìm thấy sheet nào có cột sku");
    const layout = L as Layout;
    const res = (agg as ReturnType<typeof makeAggregator>).finish();

    // Days this run must not touch: locked history, and (hourly files only) days the daily export already gave.
    let out = res.out.filter((r) => r.date >= lockBefore);
    const lockedDays = [...new Set(res.out.filter((r) => r.date < lockBefore).map((r) => r.date))].sort();
    let dailyDays: string[] = [];
    if (layout.kind === "hourly" && out.length) {
      const fileDays = [...new Set(out.map((r) => r.date))];
      const { data: kept, error } = await db.from("sales_daily").select("date").in("date", fileDays).ilike("source_file", "%daily%").limit(10000);
      if (error) throw new Error(error.message);
      dailyDays = [...new Set((kept ?? []).map((k: { date: string }) => k.date))].sort();
      out = out.filter((r) => !dailyDays.includes(r.date));
    }
    const info = { sheet: found.sheet, kind: layout.kind, dateColumn: layout.dateKey, gmvColumn: layout.gmvKey,
      rowsIn: res.rowsIn, skipped: res.skipped, skippedWhy: res.why, keptLockedDays: lockedDays.length ? `${lockedDays[0]} → ${lockedDays.at(-1)}` : null,
      keptDailyDays: dailyDays, skuDays: out.length, hourRows: res.hours.length, asinDayRows: res.asinDays.length, days: perDay(out) };
    if (dryRun) return json({ ok: true, dryRun: true, fileHash: hash, columns: layout.columns, sampleSkipped: res.sample, ...info });
    if (!res.out.length) {
      const w = res.why;
      await logError(`Không có dòng nào nạp được (${res.rowsIn} dòng; ngoài USA ${w.notUsa}, thiếu sku ${w.noSku}, SKU không quản lý ${w.unmanagedSku}, không đọc được ngày ${w.noDate}). ` +
        `Cột ngày: ${layout.dateKey}. Dòng mẫu: ${JSON.stringify(res.sample)}. Cột: ${layout.columns.join(", ")}`);
      return json({ ok: false, columns: layout.columns, sampleSkipped: res.sample, ...info }, 422);
    }

    // hour-level rows first: the live race reads them even when the daily rows are kept
    let hourRows: number | string = 0;
    if (res.hours.length) {
      const h = await db.rpc("replace_sales_hours", { p_rows: res.hours, p_source: source });
      if (h.error) throw new Error("sales_hourly: " + h.error.message);
      hourRows = h.data as number;
    }
    // ASIN-days (BTR tab): never blocks the sales load
    let asinRows: number | string = 0;
    if (res.asinDays.length) {
      const a = await db.rpc("replace_sales_asin_days", { p_rows: res.asinDays, p_source: source });
      asinRows = a.error ? "chưa ghi (" + a.error.message.slice(0, 120) + ")" : a.data as number;
    }
    if (!out.length) {
      await db.from("ingest_runs").insert({ source, status: "ok", file_hash: hash, rows_in: 0, rows_loaded: 0,
        message: `sales_hourly ${hourRows} dòng; sales_asin_daily ${asinRows}; sales_daily giữ nguyên (ngày đã có từ file daily / đã khóa)` });
      return json({ ok: true, ...info, hourRows, asinRows });
    }
    const { data, error } = await db.rpc("replace_sales_days", { p_rows: out, p_source: source, p_hash: hash });
    if (error) throw new Error(error.message);
    return json({ ok: true, ...info, hourRows, asinRows, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
