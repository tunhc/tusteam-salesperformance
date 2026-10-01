// Supabase Edge Function: ai-chat
//
// Backs the chat box in the bottom-right corner of the dashboard.
// - Data questions ("tháng 9 năm ngoái Dumbbell Neoprene bán bao nhiêu units")
//   are answered by Claude writing one read-only SELECT, executed through the
//   ai_query() database function (owned by a SELECT-only role).
// - Other questions are answered as an Amazon specialist, using data when useful.
// - Every question and answer is stored in chat_messages.
//
// Deploy: Edge Functions → new function "ai-chat", paste this file, keep
// "Verify JWT" ON. Secrets: ANTHROPIC_API_KEY (required), ANTHROPIC_WORKSPACE_ID
// (only for API keys that are not scoped to a workspace), AI_DAILY_LIMIT
// (optional, default 300 questions per 24 h).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SCHEMA = `Database (PostgreSQL, schema public). All money in USD.
- skus(sku PK, product_name, asin, pic, main_pl, sub_pl, category, lifecycle, selling_type, asin_status, salable_y4a, salable_amz, channel, portfolio, moc, moc_band, rrp, block_ads, labels, war_plan, normal_asp, cm3_unit_base, cm3_lane, inventory_as_of)
  · main_pl = "Main PL"/"New Product line" (e.g. Standard Dumbbells, Tricep Ropes); sub_pl = "Old Product Line" (e.g. Dumbbell Neoprene, Cable Attachments). pic = person in charge.
- sales_daily(sku, date, units, gmv, ads, promo, ads_gmv, ads_units, total_clicks, total_impressions, glance_views, ordered_revenue, ordered_nmv, sp_spend, sb_spend, sd_spend, dsp_spend, aff_spend, promo_deal, promo_coupon, promo_discount)
  · one row per SKU per day, Jan-2023 → today. units = ordered units, gmv = ordered GMV, ads = total ads spend, promo = total promo spend, ads_gmv = ads-attributed sales, glance_views may be 0 for days loaded from the hourly file.
- targets_monthly(sku, month [first day], target_units, target_gmv, ads_target, promo_target)
- inventory_snapshot(sku, snapshot_date, salable_y4a, salable_amz); incoming_weekly(sku, week_start [Sunday], qty_y4a, qty_amz, snapshot_date) — use the latest snapshot_date
- demand_forecast_monthly(sku, month, units, gmv)
- review_snapshot(week_start [Sunday], sku, units, gmv, ads, promo, ads_gmv, ads_units, clicks, impressions, glance_views, prev_units, prev_gmv, prev_ads, prev_promo, prev_ads_gmv, prev_glance_views, target_units, target_gmv, ads_budget, promo_budget, salable_y4a, salable_amz, rrp)
- weekly_reviews(week_start, main_pl, owner, status, issue_text, action_text, is_late, updated_at) — PIC explanations per product line per week
- review_actions(id, week_start, main_pl, owner, text, due_date, status [Open/Done/Cancel], done_by, done_note, done_at, skus text[]); review_action_logs(action_id, pic, note, status, created_at)
- project_updates(topic, product_group, status, content, update_date, author)
- market_variation(category, variation, brand, metric [revenue|price], value, period); market_brand_monthly(category, month, brand, revenue); market_asin_weekly(category, asin, brand, title, week_start, price, units); market_variation_monthly(category, attribute, variation, month, value)
- Market research library (Strategy Plans + market reports, Vietnamese text): market_reports(source, category, kind, title, pic, product_line, plan_date); market_insights(category, source, sheet, section, label, content) — SWOT, conclusions, discount patterns, customer insight, action plans, pricing recommendations; market_tables(category, source, sheet, section, title, columns jsonb [names], rows jsonb [array of arrays]) — competitor/variation/price/NPD/timeline tables. Search with content ILIKE '%keyword%' and filter by category (e.g. 'Balance Boards', 'Soft Kettlebells', 'Tricep Ropes'); expand table rows with jsonb_array_elements(rows).
Metric definitions: ASP = gmv/units; MKT = ads+promo; %MKT/GMV = (ads+promo)/gmv; TACOS = ads/gmv; ACOS = ads/ads_gmv; CR = units/glance_views; CM3 ≈ units*cm3_unit_base − ads*0.985 − promo (cm3_lane 'SPT': units*cm3_unit_base); CM3% = CM3/gmv for SKUs with cm3_unit_base.
Helper functions you may call inside SELECT: sales_by_sku(p_from date, p_to date), sales_trend(p_from, p_to, p_grain 'day'|'week'|'month', p_skus text[]).`;

const SYSTEM = `Bạn là trợ lý dữ liệu và chuyên gia Amazon (Vendor Central và Seller Central, ngành dụng cụ thể thao, thị trường Mỹ) của team sales Yes4All.
- Câu hỏi cần số liệu: dùng tool run_sql để truy vấn, rồi trả lời bằng con số cụ thể kèm phạm vi (ngày, SKU/nhóm) đã dùng. Có thể gọi tool nhiều lần. Tìm tên nhóm/SKU bằng ILIKE khi người dùng gõ không chính xác (ví dụ "dumbbell neoprene" → sub_pl ILIKE '%neoprene%').
- Câu hỏi không cần truy xuất: trả lời như chuyên gia Amazon, dựa trên dữ liệu khi có ích (giá, ads, promo, listing, tồn kho, deal, ranking).
- "Năm ngoái", "tháng trước"... tính theo ngày hôm nay được cung cấp.
- Trả lời bằng tiếng Việt, ngắn gọn, dùng gạch đầu dòng hoặc bảng markdown nhỏ khi so sánh. Không bịa số; nếu dữ liệu không có thì nói rõ.
- Câu hỏi về thị trường, đối thủ, giá đối thủ, chiến lược, action plan: tra market_insights / market_tables trước, trích nguồn (tên file).
- Khi hỏi "chỉ số nào có vấn đề", so sánh với kỳ trước/cùng kỳ, target, tồn kho, và nêu hành động đề xuất kèm mức ưu tiên.

${SCHEMA}`;

const TOOLS: Anthropic.Beta.BetaTool[] = [{
  name: "run_sql",
  description: "Run ONE read-only PostgreSQL SELECT (or WITH … SELECT) against the dashboard database and get up to 300 rows as JSON. Aggregate in SQL (SUM/GROUP BY) instead of pulling raw daily rows.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single SELECT statement, no semicolons." },
      purpose: { type: "string", description: "One short line: what this query answers." },
    },
    required: ["sql", "purpose"],
    additionalProperties: false,
  },
  strict: true,
}];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let body: { session_id?: string; message?: string };
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const sessionId = body.session_id, message = (body.message || "").trim();
  if (!sessionId || !message) return json({ error: "session_id and message are required" }, 400);
  if (message.length > 4000) return json({ error: "Câu hỏi quá dài (tối đa 4.000 ký tự)." }, 413);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: session } = await db.from("chat_sessions").select("id, user_name, team").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Phiên chat không tồn tại. Bấm Bắt đầu lại." }, 404);

  const limit = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "300");
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db.from("chat_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since);
  if ((count ?? 0) >= limit) return json({ error: `Đã dùng hết ${limit} câu hỏi trong 24 giờ qua.` }, 429);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY chưa được cấu hình trong Edge Function secrets." }, 500);
  const workspace = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const client = new Anthropic({ apiKey, defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined });

  // store the question first so nothing is lost if the model call fails
  await db.from("chat_messages").insert({ session_id: sessionId, role: "user", content: message });

  // previous turns of this session (text only)
  const { data: hist } = await db.from("chat_messages").select("role, content").eq("session_id", sessionId).order("id", { ascending: false }).limit(13);
  const prior = (hist || []).reverse().slice(0, -1); // drop the question we just stored
  while (prior.length && prior[0].role !== "user") prior.shift();
  const { data: bounds } = await db.rpc("sales_date_bounds");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
  const context = `Hôm nay: ${today} (giờ Việt Nam). Dữ liệu sales có tới ${bounds?.[0]?.max_date ?? "?"}. Người hỏi: ${session.user_name}${session.team ? " · " + session.team : ""}.`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: `${context}\n\n${message}` },
  ];
  const sqlUsed: string[] = [];
  let answer = "", model = "";

  try {
    for (let step = 0; step < 8; step++) {
      const response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      model = response.model;
      if (response.stop_reason === "refusal") { answer = "Xin lỗi, mình không trả lời được câu hỏi này."; break; }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      const calls = response.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlock[];
      if (response.stop_reason !== "tool_use" || !calls.length) {
        answer = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
        if (response.stop_reason === "max_tokens") answer += "\n\n(Câu trả lời bị cắt vì quá dài.)";
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        const input = call.input as { sql?: string };
        if (call.name !== "run_sql" || typeof input?.sql !== "string") {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Unknown tool or missing sql", is_error: true });
          continue;
        }
        sqlUsed.push(input.sql);
        const { data, error } = await db.rpc("ai_query", { q: input.sql });
        results.push(error
          ? { type: "tool_result", tool_use_id: call.id, content: `SQL error: ${error.message}`, is_error: true }
          : { type: "tool_result", tool_use_id: call.id, content: JSON.stringify(data).slice(0, 60000) });
      }
      messages.push({ role: "user", content: results });
    }
    if (!answer) answer = "Mình chưa tìm ra câu trả lời sau nhiều bước truy vấn. Thử hỏi cụ thể hơn (SKU, nhóm sản phẩm, khoảng thời gian).";
  } catch (err) {
    let msg = String(err);
    if (err instanceof Anthropic.RateLimitError) msg = "Claude API đang giới hạn tốc độ, thử lại sau ít phút.";
    else if (err instanceof Anthropic.AuthenticationError) msg = "API key không hợp lệ.";
    else if (err instanceof Anthropic.APIError) msg = `Claude API lỗi ${err.status}: ${err.message}`;
    return json({ error: msg }, 502);
  }

  await db.from("chat_messages").insert({ session_id: sessionId, role: "assistant", content: answer, sql_used: sqlUsed, model });
  return json({ answer, sql: sqlUsed, model });
});
