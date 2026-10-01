// Supabase Edge Function: ai-recommend
//
// Called by the dashboard's "Hỏi AI" buttons (Weekly Review, SKU detail,
// Ads by product line). Sends the data context the dashboard already has
// to Claude and returns Vietnamese recommendations. Answers are cached in
// ai_recommendations per (scope, scope_key, as_of) so repeated clicks on the
// same day cost nothing.
//
// Deploy: Supabase → Edge Functions → Deploy new function "ai-recommend",
// paste this file. Keep "Verify JWT" ON (the dashboard sends the anon key).
// Secrets (Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   your Claude API key (never put it in index.html)
//   ANTHROPIC_WORKSPACE_ID  only for API keys not scoped to a workspace
//   AI_DAILY_LIMIT      optional, max new answers per day (default 150)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `Bạn là chuyên gia vận hành Amazon (Vendor Central và Seller Central) cho ngành dụng cụ thể thao tại thị trường Mỹ, làm việc cùng team sales của Yes4All.
Bạn nhận dữ liệu JSON của một SKU, một product line hoặc một tuần: GMV, units, ASP, RRP, glance views, CR, CTR, Ads spend, ACOS, TACOS, Promo, tồn kho, incoming, target và ghi chú của PIC.
Nhiệm vụ: đưa ra khuyến nghị hành động cụ thể để đẩy số bán hoặc bảo vệ margin, và những điểm cần kiểm tra.
Quy tắc:
- Trả lời bằng tiếng Việt, ngắn gọn, dạng gạch đầu dòng. Giữ nguyên thuật ngữ Amazon (ACOS, TACOS, glance view, Best Deal, Lightning Deal, coupon, buy box, suppressed listing, zip code...).
- Mỗi khuyến nghị nêu: việc cần làm, SKU liên quan, lý do dựa trên số liệu trong dữ liệu (trích số), và mức ưu tiên (Cao/Trung bình/Thấp).
- Phân biệt rõ điều số liệu cho thấy và điều chỉ là giả thuyết cần kiểm tra (ví dụ glance view giảm có thể do mất ranking, campaign hết budget, listing bị suppressed hoặc OOS).
- Không bịa số liệu không có trong dữ liệu. Nếu thiếu dữ liệu để kết luận, nói rõ cần kiểm tra gì.
- Nếu tồn kho thấp (cover < 2 tuần) thì không khuyến nghị tăng ads cho SKU đó.
- Tối đa 8 khuyến nghị, sắp theo mức ưu tiên.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  let payload: { scope?: string; scope_key?: string; as_of?: string; question?: string; context?: unknown; force?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const { scope, scope_key, as_of, question, context, force } = payload;
  if (!scope || !scope_key || !as_of || !context) {
    return json({ error: "scope, scope_key, as_of and context are required" }, 400);
  }
  const contextText = JSON.stringify(context);
  if (contextText.length > 60000) return json({ error: "Context too large (max 60k chars)" }, 413);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (!force) {
    const { data: cached } = await db.from("ai_recommendations").select("answer, model, created_at")
      .eq("scope", scope).eq("scope_key", scope_key).eq("as_of", as_of)
      .order("created_at", { ascending: false }).limit(1);
    if (cached && cached.length) return json({ ...cached[0], cached: true });
  }

  const limit = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "150");
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db.from("ai_recommendations").select("id", { count: "exact", head: true }).gte("created_at", since);
  if ((count ?? 0) >= limit) return json({ error: `Đã dùng hết ${limit} lượt AI trong 24 giờ qua.` }, 429);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY chưa được cấu hình trong Edge Function secrets." }, 500);
  const workspace = Deno.env.get("ANTHROPIC_WORKSPACE_ID");
  const client = new Anthropic({ apiKey, defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined });

  const userText = `${question || "Dựa trên dữ liệu dưới đây, bạn khuyến nghị hành động gì để đẩy số bán, và cần kiểm tra gì?"}

Phạm vi: ${scope} = ${scope_key}, dữ liệu tính đến ${as_of}.
Dữ liệu (JSON):
${contextText}`;

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    });
    if (response.stop_reason === "refusal") {
      return json({ error: "Claude từ chối yêu cầu này.", detail: response.stop_details ?? null }, 422);
    }
    const answer = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    if (!answer) return json({ error: "Claude không trả về nội dung." }, 502);
    await db.from("ai_recommendations").insert({ scope, scope_key, as_of, question: question ?? null, answer, model: response.model });
    return json({ answer, model: response.model, cached: false });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Claude API đang giới hạn tốc độ, thử lại sau ít phút." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "ANTHROPIC_API_KEY không hợp lệ." }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `Claude API lỗi ${err.status}: ${err.message}` }, 502);
    return json({ error: String(err) }, 500);
  }
});
