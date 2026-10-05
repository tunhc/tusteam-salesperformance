// Supabase Edge Function: pull-hourly
//
// Loads the "SSO Data Extraction Hourly" Excel, aggregates it to one row per
// SKU per day and replaces those days in sales_daily (replace_sales_days, one
// transaction). Other days are left untouched.
//
// Two ways to get the file:
//   1. POST the .xlsx bytes as the request body (Power Automate: SharePoint
//      "Get file content" → HTTP action, Body = File Content). Optional headers:
//        x-file-name   name stored in sales_daily.source_file
//        x-dry-run: 1  parse and return per-day totals, write nothing
//        x-force: 1    load even if the file is unchanged since the last load
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
import { downloadUrls, graphShareId, makeAggregator, normKey, perDay, pickDateKey, USED_KEYS, type Row } from "./hourly.ts";
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
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
    if (!force && !dryRun) {
      const { data: last } = await db.from("ingest_runs").select("file_hash").eq("status", "ok").order("ran_at", { ascending: false }).limit(1);
      if (last?.[0]?.file_hash === hash) {
        await db.from("ingest_runs").insert({ source, status: "skipped", file_hash: hash, message: "file không đổi" });
        return json({ ok: true, skipped: "file không đổi" });
      }
    }

    const { data: skus, error: skuErr } = await db.from("skus").select("sku");
    if (skuErr) throw new Error(skuErr.message);
    const managed = (skus ?? []).map((s: { sku: string }) => s.sku);

    // Stream the sheet: only the columns the aggregator reads are kept per row.
    let agg: ReturnType<typeof makeAggregator> | null = null, cols: [number, string][] = [], columns: string[] = [], dateKey = "";
    const found = await readSheetRows(bytes, (header) => {
      const keys = header.map(normKey);
      if (!keys.includes("sku")) return false;
      if (!keys.includes("ordered_units") || !(keys.includes("ordered_gmv") || keys.includes("ordered_nmv"))) {
        throw new Error(`Sheet thiếu cột ordered_units / ordered_gmv / ordered_nmv (có: ${keys.join(", ")})`);
      }
      dateKey = pickDateKey(keys) ?? "";
      if (!dateKey) throw new Error(`Sheet không có cột ngày (có: ${keys.join(", ")})`);
      columns = keys;
      cols = keys.map((k, i) => [i, k] as [number, string]).filter(([, k]) => USED_KEYS.has(k) || k === dateKey);
      agg = makeAggregator(managed, source, keys.includes("ordered_gmv"), dateKey);
      return cols.map(([i]) => i);
    }, (cells) => {
      const r: Row = {};
      for (const [i, k] of cols) r[k] = cells[i] ?? null;
      agg!.add(r);
    }, Deno.env.get("HOURLY_SHEET") || undefined);
    if (!found || !agg) throw new Error("Không tìm thấy sheet nào có cột sku");
    const { out, rowsIn, skipped, why, sample, gmvColumn } = (agg as ReturnType<typeof makeAggregator>).finish();
    const sheetName = found.sheet;
    const info = { sheet: sheetName, dateColumn: dateKey, gmvColumn, rowsIn, skipped, skippedWhy: why, skuDays: out.length, days: perDay(out) };
    if (dryRun) return json({ ok: true, dryRun: true, fileHash: hash, columns, sampleSkipped: sample, ...info });
    if (!out.length) {
      await logError(`Không có dòng nào nạp được (${rowsIn} dòng; thiếu sku ${why.noSku}, không đọc được ngày ${why.noDate}, SKU không quản lý ${why.unmanagedSku}). ` +
        `Cột ngày: ${dateKey}. Dòng mẫu: ${JSON.stringify(sample)}. Cột: ${columns.join(", ")}`);
      return json({ ok: false, columns, sampleSkipped: sample, ...info }, 422);
    }

    const { data, error } = await db.rpc("replace_sales_days", { p_rows: out, p_source: source, p_hash: hash });
    if (error) throw new Error(error.message);
    return json({ ok: true, ...info, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
