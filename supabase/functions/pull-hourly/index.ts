// Supabase Edge Function: pull-hourly
//
// Downloads the "SSO Data Extraction Hourly" Excel straight from its
// SharePoint / OneDrive link, aggregates it to one row per SKU per day and
// replaces those days in sales_daily (replace_sales_days, one transaction).
// Called every hour by pg_cron (see supabase_auto_ingest.sql), or by hand.
//
// Deploy with "Verify JWT" OFF (pg_cron authenticates with x-pull-secret).
// Secrets:
//   PULL_SECRET       random string; the cron job sends it in x-pull-secret
//   HOURLY_FILE_URL   the Excel sharing link
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

Deno.serve(async (req) => {
  const secret = Deno.env.get("PULL_SECRET");
  if (!secret || req.headers.get("x-pull-secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const link = Deno.env.get("HOURLY_FILE_URL");
  if (!link) return json({ error: "HOURLY_FILE_URL chưa được cấu hình" }, 500);
  let force = false;
  try { force = !!(await req.json())?.force; } catch { /* empty body */ }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const source = "auto: " + (Deno.env.get("HOURLY_SOURCE_NAME") ?? "SSO Data Extraction Hourly");
  const logError = async (message: string) => { await db.from("ingest_runs").insert({ source, status: "error", message: message.slice(0, 1000) }); };

  try {
    const bytes = await download(link);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
    if (!force) {
      const { data: last } = await db.from("ingest_runs").select("file_hash").eq("status", "ok").order("ran_at", { ascending: false }).limit(1);
      if (last?.[0]?.file_hash === hash) {
        await db.from("ingest_runs").insert({ source, status: "skipped", file_hash: hash, message: "file không đổi" });
        return json({ ok: true, skipped: "file không đổi" });
      }
    }
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames.includes(Deno.env.get("HOURLY_SHEET") ?? "hourly") ? (Deno.env.get("HOURLY_SHEET") ?? "hourly") : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName], { defval: null, raw: true });
    if (!rows.length || !("sku" in rows[0]) || !("ordered_gmv" in rows[0])) throw new Error(`Sheet "${sheetName}" không có cột sku / ordered_gmv`);

    const { data: skus, error: skuErr } = await db.from("skus").select("sku");
    if (skuErr) throw new Error(skuErr.message);
    const managed = new Set((skus ?? []).map((s: { sku: string }) => s.sku));
    const { out, rowsIn, skipped } = aggregate(rows, managed, source);
    if (!out.length) { await logError(`Không có dòng nào của SKU đang quản lý (${rowsIn} dòng trong file)`); return json({ ok: false, rowsIn }, 422); }

    const { data, error } = await db.rpc("replace_sales_days", { p_rows: out, p_source: source, p_hash: hash });
    if (error) throw new Error(error.message);
    return json({ ok: true, rowsIn, skippedUnmanaged: skipped, ...data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
