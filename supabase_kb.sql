-- ============================================================================
-- AI knowledge hub: reference articles the "Hỏi AI" chat reads before answering
-- questions about Amazon programs and policies. Run once in the SQL Editor (safe
-- to re-run: every article is an upsert). Each article links to its page on the
-- dashboard (page_url) and to the original source (source_url); the chat cites both.
-- To add an article: insert a row with a new slug; the chat finds it by tags/title/content.
-- ============================================================================

create table if not exists kb_articles (
  slug        text primary key,
  title       text not null,
  tags        text[] not null default '{}',
  page_url    text,                 -- page on the dashboard site (with #anchors per section)
  source_url  text,                 -- original source of the knowledge
  source_note text,
  content     text not null,        -- markdown, Vietnamese
  updated_at  timestamptz not null default now()
);

alter table kb_articles enable row level security;
drop policy if exists "public read kb_articles" on kb_articles;
create policy "public read kb_articles" on kb_articles for select using (true);
do $$ begin grant select on kb_articles to ai_reader; exception when undefined_object then null; end $$;

insert into kb_articles (slug, title, tags, page_url, source_url, source_note, content) values (
'born-to-run',
'Amazon Born to Run (BTR) Program Policy',
array['btr','born to run','born-to-run','retention','retention fee','surcharge','base fee','sell-through','sell through','disposition path','returns','ad spend commitment','recommended quantity','flex','vendor central','coop'],
'https://tunhc.github.io/tusteam-salesperformance/born-to-run.html',
'https://vendorcentral.amazon.com/hz/vendor/members/support/help/node/G3UQ6PHPZRCUYHYS',
'Amazon Vendor Central · Born to Run Program Policy + FAQ (đọc ngày 10/11/2026)',
$kb$
# Amazon Born to Run (BTR)
Các mục của trang (page_url + anchor): #tong-quan, #tier, #offer, #sell-through, #disposition, #retention, #calculator, #returns, #ad-spend, #recommended, #dashboard, #faq, #thuat-ngu.

## Tổng quan (#tong-quan)
- Chương trình của Amazon Vendor Central, chỉ tham gia khi được mời. Vendor gửi Offer đề nghị Amazon đặt PO khi tồn kho Amazon không đủ cho nhu cầu 10 tuần (launch, chiến dịch marketing).
- Offer khai ASIN, số unit dự kiến bán hết trong Sell-through Period. Amazon mua tối đa số đó. Phần không bán hết bị xử lý theo Disposition Path vendor chọn lúc gửi Offer.
- Rủi ro tồn kho chuyển về vendor.

## Tier (#tier)
- Standard (mặc định): Disposition Path = Retention Fees hoặc Returns.
- Flex (theo lời mời): thêm Ad Spend Commitment và Recommended Quantity, chỉ cho ASIN mới.

## Offer và PO (#offer)
- Tối đa 50 ASIN/Offer; khai số lượng, Ship Window, Delivery Window, Disposition Path. Phải có đủ hàng tại kho trước khi đưa ASIN vào Offer.
- Amazon có thể từ chối không cần lý do, duyệt một phần ASIN hoặc số lượng khác. PO phát hành trong 1 ngày làm việc sau khi duyệt; confirm PO trong 72 giờ; được confirm số thấp hơn.
- Không sửa, không rút Offer sau khi gửi. Mọi ASIN trong Offer dùng chung một Disposition Path.
- Window giống PO thường, freight theo điều khoản hiện có. Amazon vẫn có thể đặt PO thường thêm trong kỳ.

## Sell-through Period (#sell-through)
- Tính riêng từng ASIN. ST Start = ngày FC nhận hàng đầu tiên (sớm nhất trong mọi PO BTR của Offer) + 7 ngày; kéo dài 70 ngày.
- Hàng về trước Street Date (Release Date trên New Item Setup): ST Start = Street Date, kéo dài 77 ngày.
- Ví dụ: nhận 01/06 → ST 08/06 → 17/08. Lô trễ > 7 ngày vì lý do ngoài tầm kiểm soát: mở case Contact Us để dời ngày.

## Disposition Path (#disposition)
- Retention Fees (Standard), Returns (Standard), Ad Spend Commitment (Flex). Phí trừ vào accounts payable qua COOP agreement tạo tự động.

## Retention Fee (#retention)
- Tính trên giá vốn (cost Amazon mua) của unit chưa bán khi hết kỳ. Tỷ lệ khóa lúc gửi Offer (xem BTR → Offer Details → Go to Details).
- Công thức (Q = Vendor responsible qty, Sold = bán trong kỳ, ST% = Sold/Q, Unsold = Q − Sold):
  - Base Fee = Base% × Unsold × Cost.
  - Surcharge = 0 nếu ST% ≥ 50%; nếu ST% < 50%: Surcharge% × min(Unsold, 50% × Q) × Cost = Surcharge% × 50% × Q × Cost.
  - Retention = Base + Surcharge.
- Câu chữ policy ("unsold units below the 50% threshold") có thể hiểu là phần hụt so với mốc 50%, nhưng ví dụ FAQ 14 của Amazon và số Est. Retention trong file Born-to-run Alert đều tính Surcharge trên 50% × Q × Cost (đã đối chiếu khớp từng cent với mọi offer). Dùng cách này.
- Vách 50%: dưới 50% phí nhảy bậc thêm Surcharge% × 50% × Q × Cost. Gần hết kỳ mà ST% 45–49% thì nên đẩy bán vài unit cuối.
- Ví dụ FAQ 14 (Base 20%, Surcharge 20%, cost $4,000): ASIN A bán 75%, chưa bán $1,000 → $200. ASIN B bán 25%, chưa bán $3,000 → Base $600 + Surcharge $400 = $1,000.
- Cột "tỷ lệ retention" suy ra từ file Alert (Est. Retention ÷ ((Q − Est. Sold) × Cost)) là tỷ lệ gộp tại mức ST Amazon dự báo, không phải Base%; không nhân tỷ lệ gộp này với số dự báo mới.

## Returns (#returns)
- Vendor nhận lại hàng chưa bán, hoàn Amazon 100% cost + phí shipping & handling 10% cost hàng bị trả. Ghi đè giới hạn trả hàng thông thường.
- Amazon quyết định có trả hay không (inventory health); có thể trả từ ngay sau ST End và kéo dài.
- Điều kiện: return address cùng quốc gia với vendor code; không từ chối quá 2 lô hàng trả BTR trong 12 tháng. Từ chối ≥ 3 lô/12 tháng → khóa 3 tháng; tái phạm → khóa vĩnh viễn (appeal qua Contact Us). Không áp dụng Direct Imports.

## Ad Spend Commitment (#ad-spend) — Flex, ASIN mới
- Cam kết chi Ad Spend Amount (Amazon ấn định) cho SP/SB/SD/Sponsored TV từng ASIN trong kỳ. Chi thiếu thì phần thiếu trừ vào AP qua COOP. Không chuyển dư giữa ASIN; chi ngoài kỳ không tính. Theo dõi: Advertising Performance Tracker.
- Không chọn path này thì quảng cáo không bắt buộc (Amazon khuyến nghị).

## Recommended Quantity (#recommended) — Flex, ASIN mới
- Amazon dự báo theo proxy ASIN (cùng vendor code, cùng category/subcategory, cost chênh ≤ 10%).
- Đặt ≤ Recommended Qty: không chịu Disposition Path. Vượt: chỉ phần Additional Quantity chịu phí; số bán trừ vào Recommended trước. Ví dụ: Recommended 1,500, đặt 2,000, bán 1,700 → 300 unit chịu phí.

## Cách dashboard dùng số (#dashboard)
- Tab BTR Tracking: thông tin chiến dịch từ file Amazon "Born-to-run Alert" (bảng btr_offers: st_start, st_end, submitted_qty, vendor_resp_qty, product_cost, est_sold_end, est_retention); Sold = số bán thực tế của mình (sales_daily theo SKU, sales_asin_daily theo ASIN) trong kỳ.
- Rủi ro: Amazon đo sell-through trên ASIN được submit BTR, unit bán trên ASIN khác của cùng SKU nhiều khả năng không được tính. Sold của Amazon thường thấp hơn ordered units của mình (hủy, trả, trễ) → chừa biên an toàn khi gần 50%.
- Phí cuối cùng là COOP agreement sau khi hết kỳ (Vendor Central → Offer Details → Completed Offers).

## FAQ (#faq)
- Không tạo ASIN mới bằng BTR. Theo dõi Offer: BTR landing → Search filters "Under Review" / "Active Offers" → Go to Details.
- ASIN BTR Out of Stock dù đã ship: nhu cầu cao hơn tồn, sẽ in-stock khi FC nhận PO còn mở.
- Bị loại khỏi BTR: Offer đang chạy giữ nguyên điều khoản. Amazon báo trước 30 ngày khi chấm dứt; thay đổi policy có hiệu lực sau 15 ngày.
$kb$)
on conflict (slug) do update set title = excluded.title, tags = excluded.tags, page_url = excluded.page_url, source_url = excluded.source_url,
  source_note = excluded.source_note, content = excluded.content, updated_at = now();
