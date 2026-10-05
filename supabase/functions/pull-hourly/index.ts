// Supabase Edge Function: pull-hourly
//
// Downloads the "SSO Data Extraction Hourly" Excel straight from its
// SharePoint / OneDrive link, aggregates it to one row per SKU per day and
// replaces those days in sales_daily (replace_sales_days, one transaction).
// Two ways to call it:
//  - push: POST the Excel file as the body (Power Automate: SharePoint "Get file
//    content" → HTTP). Works with view-only access to the file.
//  - pull: POST with an empty body; the function downloads HOURLY_FILE_URL
//    (pg_cron schedule in supabase_auto_ingest.sql).
// Headers: x-pull-secret (required), x-dry-run: 1 (parse only, write nothing),
// x-force: 1 (load even if the file is unchanged), x-file-name (shown in the log).
//
// Deploy with "Verify JWT" OFF (pg_cron authenticates with x-pull-secret).
// Secrets:
//   PULL_SECRET       random string sent in the x-pull-secret header
//   HOURLY_FILE_URL   (pull mode only) the Excel sharing link
//   Either the link is shared as "Anyone with the link" (no login), or set
//   MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET of an Azure app with
//   Microsoft Graph application permission Files.Read.All (or Sites.Selected).
// Optional: HOURLY_SHEET (default "hourly", else the first sheet).
import * as XLSX from "npm:xlsx@0.18.5";
import { createClient } from "npm:@supabase/supabase-js@2";
import { aggregate, downloadUrls, graphShareId, type Row } from "./hourly.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  const isXlsx = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b; // "PK" zip
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

// Body of a pushed file: raw bytes (application/octet-stream), Power Automate's
// file object {"$content-type": ..., "$content": "<base64>"}, or {"file": "<base64>"}.
async function pushedFile(req: Request): Promise<Uint8Array | null> {
  if (req.method !== "POST") return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b) return buf; // xlsx (zip)
  try {
    const j = JSON.parse(new TextDecoder().decode(buf));
    const b64 = j?.["$content"] ?? j?.file ?? j?.body?.["$content"];
    if (typeof b64 === "string") return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch { /* not JSON */ }
  return new Uint8Array(0); // something was sent but it is not a file
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("PULL_SECRET");
  if (!secret || req.headers.get("x-pull-secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const force = req.headers.get("x-force") === "1";
  const dryRun = req.headers.get("x-dry-run") === "1";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const name = req.headers.get("x-file-name") || Deno.env.get("HOURLY_SOURCE_NAME") || "SSO hourly";
  const source = "auto: " + name;
  const logError = async (message: string) => { if (!dryRun) await db.from("ingest_runs").insert({ source, status: "error", message: message.slice(0, 1000) }); };

  try {
    let bytes = await pushedFile(req);
    if (bytes && !bytes.length) throw new Error("Body không phải file Excel. Trong Power Automate, đặt Body = File Content của bước Get file content.");
    if (!bytes) {
      const link = Deno.env.get("HOURLY_FILE_URL");
      if (!link) throw new Error("Không có file trong body và HOURLY_FILE_URL chưa được cấu hình");
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
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const want = Deno.env.get("HOURLY_SHEET");
    const sheetName = want && wb.SheetNames.includes(want) ? want : wb.SheetNames.includes("hourly") ? "hourly" : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName], { defval: null, raw: true });

    const { data: skus, error: skuErr } = await db.from("skus").select("sku");
    if (skuErr) throw new Error(skuErr.message);
    const managed = new Set((skus ?? []).map((s: { sku: string }) => s.sku));
    const { out, rowsIn, skipped, gmvFrom } = aggregate(rows, managed, source);
    const byDay: Record<string, { skus: number; gmv: number; units: number }> = {};
    out.forEach((r) => { const d = byDay[r.date] ??= { skus: 0, gmv: 0, units: 0 }; d.skus++; d.gmv = Math.round((d.gmv + r.gmv) * 100) / 100; d.units += r.units; });
    if (dryRun) return json({ ok: true, dryRun: true, sheet: sheetName, rowsIn, skippedUnmanaged: skipped, gmvFrom, days: byDay });
    if (!out.length) { await logError(`Không có dòng nào của SKU đang quản lý (${rowsIn} dòng trong file)`); return json({ ok: false, rowsIn }, 422); }

    const { data, error } = await db.rpc("replace_sales_days", { p_rows: out, p_source: source, p_hash: hash });
    if (error) throw new Error(error.message);
    return json({ ok: true, rowsIn, skippedUnmanaged: skipped, gmvFrom, days: byDay, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
