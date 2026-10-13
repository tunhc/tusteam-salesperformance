// Supabase Edge Function: pull-inventory
//
// Loads the "Yes4All_US_Inventory" Excel (sheet report, updated hourly by the source),
// and writes one inventory snapshot per day via replace_inventory_snapshot
// (supabase_inventory_auto.sql):
//   inventory_snapshot  salable Y4A / AMZ per SKU per day (history)
//   skus                current salable_y4a / salable_amz / asin_status / inventory_as_of
//   incoming_weekly     incoming Y4A / AMZ per SKU per week (week starting Sunday)
//   asin_inventory      per SKU × ASIN (BTR tab), when supabase_btr.sql has been run
// Parsing is the same as ingest_v2.py --inventory / --asin-inventory (see inventory.ts).
//
// Two ways to get the file (same as pull-hourly):
//   1. POST the .xlsx as the request body (Power Automate: SharePoint "Get file content" → HTTP).
//      Optional headers: x-file-name, x-dry-run: 1 (parse only, write nothing), x-force: 1 (load an unchanged file).
//   2. Empty body: download INVENTORY_FILE_URL (pg_cron, see supabase_inventory_auto.sql).
//
// Deploy with "Verify JWT" OFF; every request must send x-pull-secret = PULL_SECRET.
// Secrets:
//   PULL_SECRET          same secret as pull-hourly
//   INVENTORY_FILE_URL   only for mode 2: SharePoint/OneDrive sharing link ("Anyone with the link",
//                        or MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET with Files.Read.All),
//                        or a Google Sheets link shared "Anyone with the link" (exported as .xlsx)
// Optional: INVENTORY_SHEET (default "report").
import { createClient } from "npm:@supabase/supabase-js@2";
import { makeInventoryParser } from "./inventory.ts";
import { readSheetRows } from "./xlsx.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isXlsx = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b; // "PK" zip
const shareId = (link: string) => "u!" + btoa(link.trim()).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");

// Sharing link → direct-download candidates (no login)
function downloadUrls(link: string): string[] {
  const u = link.trim();
  const g = u.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (g) return [`https://docs.google.com/spreadsheets/d/${g[1]}/export?format=xlsx`];
  const urls: string[] = [];
  if (/1drv\.ms|onedrive\.live\.com/i.test(u)) urls.push(`https://api.onedrive.com/v1.0/shares/${shareId(u)}/root/content`);
  urls.push(u.includes("download=1") ? u : u + (u.includes("?") ? "&" : "?") + "download=1");
  return urls;
}

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
  const token = /docs\.google\.com/.test(link) ? null : await graphToken();
  if (token) {
    const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId(link)}/driveItem/content`, { headers: { Authorization: `Bearer ${token}` } });
    const b = new Uint8Array(await res.arrayBuffer());
    if (res.ok && isXlsx(b)) return b;
    throw new Error(`Graph không tải được file (${res.status}). Kiểm tra quyền Files.Read.All / link.`);
  }
  for (const url of downloadUrls(link)) {
    const res = await fetch(url, { redirect: "follow" });
    const b = new Uint8Array(await res.arrayBuffer());
    if (res.ok && isXlsx(b)) return b;
  }
  throw new Error("Link yêu cầu đăng nhập nên không tải được. Cần chia sẻ link dạng 'Anyone with the link' (chỉ xem), hoặc cấu hình MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.");
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Request body → xlsx bytes (raw bytes, bare base64, or Power Automate's {"$content": base64}); null → download.
function bodyFile(b: Uint8Array): Uint8Array | null {
  if (!b.length) return null;
  if (isXlsx(b)) return b;
  const text = new TextDecoder().decode(b).trim().replace(/^"|"$/g, "");
  if (text.startsWith("UEsDB")) {
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
  throw new Error(`Body không phải file .xlsx (bắt đầu bằng "${text.slice(0, 40)}") (${b.length} bytes).`);
}

const ALL_COLUMNS = Array.from({ length: 400 }, (_, i) => i); // header is on row 4, so read every column

Deno.serve(async (req) => {
  const secret = Deno.env.get("PULL_SECRET");
  if (!secret || req.headers.get("x-pull-secret") !== secret) return json({ error: "Unauthorized" }, 401);
  const flag = (h: string) => ["1", "true", "yes"].includes((req.headers.get(h) ?? "").trim().toLowerCase());
  const dryRun = flag("x-dry-run");
  let force = flag("x-force");

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const source = "auto: inventory " + (req.headers.get("x-file-name")?.trim() || "Yes4All_US_Inventory");
  const logError = async (message: string) => {
    if (!dryRun) await db.from("ingest_runs").insert({ source, status: "error", message: message.slice(0, 1000) });
  };

  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    let bytes = bodyFile(raw);
    if (!bytes) {
      const link = Deno.env.get("INVENTORY_FILE_URL");
      if (!link) throw new Error("Body rỗng và chưa đặt secret INVENTORY_FILE_URL");
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

    const p = makeInventoryParser();
    const found = await readSheetRows(bytes, (first) => { p.add(first); return ALL_COLUMNS; }, (cells) => p.add(cells),
      Deno.env.get("INVENTORY_SHEET") || "report");
    if (!found) throw new Error("File không có sheet nào");
    if (found.sheet !== (Deno.env.get("INVENTORY_SHEET") || "report")) throw new Error(`Không có sheet "report" (có: ${found.sheets.join(", ")})`);
    const inv = p.finish();
    if (!inv.skus.length) throw new Error("Sheet report không có dòng SKU nào");

    // Managed SKUs only (the RPC also filters); match ignoring case / invisible chars, write the stored spelling
    const { data: skus, error: skuErr } = await db.from("skus").select("sku").limit(100000);
    if (skuErr) throw new Error(skuErr.message);
    const key = (s: string) => s.replace(/[​-‍﻿\s]/g, "").toUpperCase();
    const managed = new Map((skus ?? []).map((s: { sku: string }) => [key(s.sku), s.sku]));
    const canon = <T extends { sku: string }>(rows: T[]) => rows.flatMap((r) => { const s = managed.get(key(r.sku)); return s ? [{ ...r, sku: s }] : []; });
    const skuRows = canon(inv.skus), incRows = canon(inv.incoming);

    const info = { sheet: found.sheet, snapshotDate: inv.snapshotDate, y4aUpdatedAt: inv.snapshotAt, amzUpdatedAt: inv.amzAt, pageRefreshedAt: inv.pageRefresh,
      rowsIn: inv.rowsIn, skusInFile: inv.skus.length, managedSkus: skuRows.length, incomingRows: incRows.length, asinRows: inv.asins.length,
      weeks: inv.weeks.length ? `${inv.weeks[0]} → ${inv.weeks.at(-1)}` : null,
      totals: { salableY4A: skuRows.reduce((s, r) => s + r.salable_y4a, 0), salableAMZ: skuRows.reduce((s, r) => s + r.salable_amz, 0),
        incomingY4A: incRows.reduce((s, r) => s + r.qty_y4a, 0), incomingAMZ: incRows.reduce((s, r) => s + r.qty_amz, 0) } };
    if (dryRun) return json({ ok: true, dryRun: true, fileHash: hash, ...info });
    if (!skuRows.length) {
      await logError(`Không SKU nào trong file khớp bảng skus (${inv.skus.length} SKU trong file)`);
      return json({ ok: false, ...info }, 422);
    }

    const { data, error } = await db.rpc("replace_inventory_snapshot", {
      p_date: inv.snapshotDate, p_skus: skuRows, p_incoming: incRows, p_asins: inv.asins, p_source: source, p_hash: hash });
    if (error) throw new Error(error.message);
    return json({ ok: true, ...info, result: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logError(msg);
    return json({ ok: false, error: msg }, 500);
  }
});
