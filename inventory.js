// =====================================================================
// Inventory Tracking tab — Commercial · US · Team Tú
// Mục tiêu: PIC xem nhanh tồn, biết hàng về tuần nào, tìm đúng PO cần follow.
//
// Data (supabase_inventory_tracking.sql), loaded automatically every hour from
// "For_Sales_Incoming_Tracker.xlsx" by the Edge Function pull-inventory (Power Automate):
//   incoming_detail     01_AMZ_incoming_details (source AMZ: hàng về kho Amazon, AVC)
//                       02_Y4A_incoming_details (source Y4A: hàng về kho mình, kéo sớm được)
//   inventory_sellable  06_ USA_Sellable INV + 07_INT Sellable INV (tồn Y4A / AMZ per SKU)
//   amz_inventory_asin  04_AMZ_sellable details (Vendor Central per ASIN: sellable on-hand)
//   incoming_eta_log    USA lines of every load → ETA history (cột Lịch sử ETA của danh sách lô)
// Sales: sales_daily (RPC sales_trend_by_sku, day + week grain).
// PIC / Main PL / SKU: follow-up (ROWS, table skus).
//
// Layout (top → bottom):
//   bộ lọc · ngày dữ liệu · Incoming theo tuần (chart chính, 3 chế độ) · KPI ·
//   Theo dõi theo SKU (AMS / MOC / Flag) · chart theo SKU · Incoming PO (trạng thái + danh sách lô) ·
//   Tổng hợp theo PIC · Phân tích hàng trễ (thu gọn)
//
// on_time_status in the file:
//   normal · delay vs expected = ETA hiện tại lùi so với ETA ban đầu ·
//   delay vs current = đã quá ETA mà chưa thành sellable (quá hạn)
//
// Forecast (USA, from sales_daily): "AutoML" nhỏ chạy trên trình duyệt —
// mỗi SKU chạy 5 mô hình (MA4, MA8, SES, Holt damped, Seasonal × level),
// backtest rolling-origin 8 tuần, horizon 4 tuần, chọn mô hình có WAPE thấp nhất.
// Dùng cho bộ lọc Rủi ro, chart theo SKU, tổng hợp PIC và AI.
// =====================================================================
(function(){
const root = typeof window !== 'undefined' ? window : globalThis;
const INV = root.INV = root.INV || {};
const H = () => root.V2.h;
// SKU → Amazon listing (helper from v2.js; plain bold text when the SKU has no ASIN)
const link = sku => (root.V2 && root.V2.skuLink ? root.V2.skuLink(sku) : '<b>' + String(sku) + '</b>');
const DAY = 86400000;

// ---------------------------------------------------------------- dates
const iso = d => d.toISOString().slice(0, 10);
const addD = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * DAY));
const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();
const sunday = s => addD(s, -dow(s));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const md = s => s ? s.slice(5, 7) + '/' + s.slice(8, 10) : '—';
const mdy = s => s ? s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4) : '—';
const maxOf = a => a.filter(Boolean).sort().pop() || null;

// ---------------------------------------------------------------- forecast (AutoML lite)
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const MODELS = {
  'MA4':   (y, h) => Array(h).fill(mean(y.slice(-4))),
  'MA8':   (y, h) => Array(h).fill(mean(y.slice(-8))),
  'SES':   (y, h) => { // alpha picked by one-step in-sample error
    let best = null;
    for(const a of [0.15, 0.3, 0.5, 0.7]){ let l = y[0], e = 0; for(let i = 1; i < y.length; i++){ e += (y[i] - l) ** 2; l = a * y[i] + (1 - a) * l; } if(!best || e < best.e) best = {e, l}; }
    return Array(h).fill(best ? best.l : 0);
  },
  'Holt':  (y, h) => { // damped trend: alpha .3, beta .1, phi .85
    const a = .3, b = .1, p = .85; let l = y[0], t = 0;
    for(let i = 1; i < y.length; i++){ const l0 = l; l = a * y[i] + (1 - a) * (l + p * t); t = b * (l - l0) + (1 - b) * p * t; }
    const out = []; let s = 0; for(let k = 1; k <= h; k++){ s += p ** k; out.push(l + s * t); } return out;
  },
  'Seasonal': (y, h) => { // level (MA8) × last year's shape: same weeks next year ÷ the 8 weeks before them
    const n = y.length; if(n < 60) return null;
    const lvl = mean(y.slice(-8)), base = mean(y.slice(n - 52 - 8, n - 52)); if(base <= 0) return null;
    const out = []; for(let k = 0; k < h; k++){ const j = n - 52 + k; const v = mean(y.slice(Math.max(0, j - 1), Math.min(n, j + 2))); out.push(lvl * Math.min(2.5, Math.max(0.4, v / base))); }
    return out;
  },
};
// y = complete weekly units (oldest first). Returns {model, wape, fc[H], scores}
INV.forecastSeries = function(y, H){
  y = y.map(v => Math.max(0, +v || 0));   // returns can make a week negative
  const n = y.length, recent = y.slice(-12);
  if(n < 6 || mean(recent) === 0) return {model: 'Không đủ dữ liệu', wape: null, fc: Array(H).fill(n ? mean(y.slice(-8)) : 0), scores: {}};
  const scores = {}, BT = Math.min(8, n - 6), HZ = 4;
  for(const [name, f] of Object.entries(MODELS)){
    let err = 0, act = 0, ok = true;
    for(let o = n - BT - HZ + 1; o <= n - HZ; o++){
      if(o < 4){ continue; }
      const p = f(y.slice(0, o), HZ); if(!p){ ok = false; break; }
      for(let k = 0; k < HZ; k++){ err += Math.abs(y[o + k] - Math.max(0, p[k])); act += y[o + k]; }
    }
    if(ok && act > 0) scores[name] = err / act;
  }
  const ranked = Object.entries(scores).sort((a, b) => a[1] - b[1]);
  const model = ranked.length ? ranked[0][0] : 'MA8';
  const fc = (MODELS[model](y, H) || MODELS.MA8(y, H)).map(v => Math.max(0, v));
  return {model, wape: ranked.length ? ranked[0][1] : null, fc, scores};
};

// ---------------------------------------------------------------- AMS (average monthly sales)
// Rule, per SKU and per period:
//   1) chỉ xét "ngày có dữ liệu" = ngày sales_daily có số (của bất kỳ SKU nào). Ngày không có file
//      là ngày THIẾU DỮ LIỆU và bị bỏ qua; ngày có dữ liệu mà SKU không có dòng = bán 0.
//   2) median daily units của SKU trên các ngày có dữ liệu (trước khi loại ngày nào).
//   3) ngày có units < 15% × median = nghi OOS → loại.
//   4) AMS = tổng units các ngày hợp lệ ÷ số ngày hợp lệ × 30.
//   5) median = 0 → không xác định được OOS: AMS tính trên mọi ngày có dữ liệu,
//      ghi "Không đủ baseline để xác định OOS".
const OOS_SHARE = 0.15;
const median = a => { if(!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
INV.AMS_RULE = 'AMS = tổng units các ngày hợp lệ ÷ số ngày hợp lệ × 30.\n' +
  '• Chỉ tính ngày có dữ liệu sales (ngày không có file = thiếu dữ liệu, bỏ qua; ngày có file mà SKU không bán = 0).\n' +
  '• Median daily sales của từng SKU trong kỳ, tính trước khi loại ngày.\n' +
  '• Ngày có sales < 15% × median = nghi OOS → loại khỏi AMS.\n' +
  '• Median = 0: tính trên mọi ngày có dữ liệu, ghi "Không đủ baseline để xác định OOS".\n' +
  'MOC = SALABLE AMZ+Y4A ÷ AMS của kỳ tương ứng (— nếu AMS = 0 hoặc thiếu dữ liệu).';
// series: Map date → units (only the SKU's rows), dataDays: sorted ISO dates of the period that have data,
// calDays: calendar days of the period. Returns the AMS and how it was obtained.
INV.ams = function(series, dataDays, calDays){
  const nData = dataDays.length, nMissing = Math.max(0, (calDays || nData) - nData);
  if(!nData) return {ams: null, median: null, nData, nValid: 0, nOos: 0, nMissing, note: 'Không có dữ liệu sales trong kỳ'};
  const vals = dataDays.map(d => Math.max(0, +(series && series.get(d)) || 0));
  const med = median(vals), total = vals.reduce((s, v) => s + v, 0);
  if(med <= 0) return {ams: total / nData * 30, median: 0, nData, nValid: nData, nOos: 0, nMissing, note: 'Không đủ baseline để xác định OOS'};
  const valid = vals.filter(v => v >= OOS_SHARE * med);
  return {ams: valid.reduce((s, v) => s + v, 0) / valid.length * 30, median: med, nData, nValid: valid.length, nOos: nData - valid.length, nMissing, note: ''};
};

// ---------------------------------------------------------------- state
const IV = {country: 'USA', pic: '', pl: '', sku: '', src: '', risk: '', q: '', etaMode: 'file', mode: 'pl',
  data: null, loadedFor: null, sales: null, daily: null, rows: [], sort: 'flagRank', dir: 1, sel: null,
  lf: null, ghost: false, memo: {pl: new Map(), sku: new Map()}};
const HZN = 16;   // weeks on the chart / projection
// USA only; the SKU list, PIC, Main PL / Sub PL and lifecycle come from the follow-up (table skus)
const followUp = () => (typeof ROWS !== 'undefined' && Array.isArray(ROWS) ? ROWS : []);
const C = {amz:'#2a78d6', amzD:'#9EC3EF', amzO:'#D64545', y4a:'#1baf7a', y4aD:'#9ADBC2', fc:'#E86A10', stock:'#002859', act:'#66707C', warn:'#eda100', other:'#A3ACB8'};
// categorical slots in fixed order (validated default palette); a 9th series folds into "Khác"
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const STAGES = ['Pre-pipeline', 'In production', 'Pipeline', 'In land transit'];
const STAGE_C = {'Pre-pipeline': '#C6DBF2', 'In production': '#86B2E6', 'Pipeline': '#3F7FD0', 'In land transit': '#1D4F91', 'Khác': C.other};
const STATUS_VI = {'normal': 'Đúng hạn', 'delay vs expected': 'Trễ so với ETA ban đầu', 'delay vs current': 'Quá ETA, chưa về'};
const MODE_VI = {pl: 'Main PL', sku: 'SKU', stage: 'Hàng đang ở đâu'};
const OTHER = 'Khác';

// ---------------------------------------------------------------- load
async function load(){
  const h = H(), c = IV.country;
  const [inc, sell, asin, ups] = await Promise.all([
    h.selectAll('incoming_detail', q => q.eq('country', c)),
    h.selectAll('inventory_sellable', q => q.eq('country', c)),
    h.selectAll('amz_inventory_asin', q => q.eq('country', c)).catch(() => []),
    sb.from('inventory_uploads').select('*').order('uploaded_at', {ascending: false}).limit(1).then(r => r.data || [], () => []),
  ]);
  IV.data = {inc, sell, asin, up: ups[0] || null};
  IV.loadedFor = c;
  const tasks = [];
  if(c === 'USA' && (!IV.sales || !IV.daily)){
    let max = null;
    try { const b = await sb.rpc('sales_date_bounds'); max = b.data && b.data[0] && b.data[0].max_date; } catch(e){ console.warn(e); }
    if(max){
      if(!IV.sales) tasks.push(loadSales(max).then(s => { IV.sales = s; }));
      if(!IV.daily) tasks.push(loadDaily(max).then(d => { IV.daily = d; }));
    }
  }
  await Promise.all(tasks);
}
// complete weeks of sales per SKU (Sunday start), 78 weeks back — forecast
async function loadSales(max){
  const h = H();
  try {
    const lastSat = dow(max) === 6 ? max : addD(sunday(max), -1);
    const from = addD(sunday(lastSat), -77 * 7);
    const rows = await h.rpcAll('sales_trend_by_sku', {p_from: from, p_to: lastSat, p_grain: 'week', p_skus: null});
    const weeks = []; for(let w = from; w <= lastSat; w = addD(w, 7)) weeks.push(w);
    const idx = new Map(weeks.map((w, i) => [w, i])), by = new Map();
    rows.forEach(r => { const i = idx.get(String(r.period).slice(0, 10)); if(i == null) return; if(!by.has(r.sku)) by.set(r.sku, Array(weeks.length).fill(0)); by.get(r.sku)[i] += +r.units || 0; });
    return {weeks, by, maxDate: max, lastSat};
  } catch(e){ console.warn(e); return null; }
}
// daily units per SKU from Jan 1 of the latest sales year (or 90 days back, whichever is earlier)
// to the latest sales date — AMS <năm> / AMS 3M / MTD. Fetched one month per request, in parallel.
async function loadDaily(max){
  const h = H();
  try {
    const yStart = max.slice(0, 4) + '-01-01', from = [yStart, addD(max, -89)].sort()[0];
    const chunks = []; let a = from;
    while(a <= max){ const nx = addD(a.slice(0, 8) + '28', 4).slice(0, 8) + '01'; const b = addD(nx, -1) < max ? addD(nx, -1) : max; chunks.push([a, b]); a = nx; }
    const parts = await Promise.all(chunks.map(([p, q]) => h.rpcAll('sales_trend_by_sku', {p_from: p, p_to: q, p_grain: 'day', p_skus: null})));
    const by = new Map(), days = new Set();
    parts.flat().forEach(r => { const d = String(r.period).slice(0, 10); days.add(d); if(!by.has(r.sku)) by.set(r.sku, new Map()); const m = by.get(r.sku); m.set(d, (m.get(d) || 0) + (+r.units || 0)); });
    return {from, maxDate: max, year: max.slice(0, 4), dataDays: [...days].sort(), by};
  } catch(e){ console.warn(e); return null; }
}
// ---------------------------------------------------------------- compute
// expected extra delay per source × physical status, learned from the file itself:
// mean of max(0, ETA now − ETA original) over lines that have an original ETA.
function slipBuffers(inc){
  const g = new Map();
  inc.forEach(r => { if(!r.eta_salable_original || !r.eta_salable_date) return; const k = r.source + '|' + (r.physical_status || '');
    const a = g.get(k) || {s: 0, n: 0}; a.s += Math.max(0, daysBetween(r.eta_salable_original, r.eta_salable_date)); a.n++; g.set(k, a); });
  const out = new Map(); g.forEach((a, k) => out.set(k, a.n ? Math.round(a.s / a.n) : 0)); return out;
}
// ETA used by the projection: due / no-ETA lines are put at the file date (+1 week when cautious)
function etaOf(r, logDate, buf){
  const base = r.eta_salable_date || logDate;
  if(IV.etaMode !== 'safe') return base < logDate ? logDate : base;
  if(base < logDate) return addD(logDate, 7);                        // quá hạn: giả định về trong 1 tuần
  return addD(base, buf.get(r.source + '|' + (r.physical_status || '')) || 0);
}
function compute(){
  const h = H(), D = IV.data; if(!D) return;
  const info = new Map(followUp().map(r => [r.sku, r]));
  const logDate = D.inc.reduce((m, r) => r.log_date > m ? r.log_date : m, '') || iso(new Date());
  const wk0 = sunday(logDate), weeks = Array.from({length: HZN}, (_, i) => addD(wk0, i * 7));
  const buf = slipBuffers(D.inc); IV.buf = buf; IV.logDate = logDate; IV.weeks = weeks;
  const sell = new Map(D.sell.map(r => [r.sku, r]));
  const asinBy = new Map(); D.asin.forEach(r => { if(!r.sku) return; if(!asinBy.has(r.sku)) asinBy.set(r.sku, []); asinBy.get(r.sku).push(r); });
  const lines = D.inc.map(r => {
    const qty = +r.qty || 0, cur = r.eta_salable_date || null;
    // lot without an Original ETA in the tracker: treated as on time (Original ETA = Current ETA)
    const orig0 = r.eta_salable_original || cur || null;
    const slip = orig0 && cur ? daysBetween(orig0, cur) : null;   // Delay Days
    const noEta = !cur, due = !noEta && cur < r.log_date;                                           // đã đến hạn, vẫn incoming
    const overdue = due ? daysBetween(cur, r.log_date) : 0;
    const etaUse = noEta || due ? null : IV.etaMode === 'safe' ? addD(cur, buf.get(r.source + '|' + (r.physical_status || '')) || 0) : cur;
    const wi = etaUse ? Math.floor(daysBetween(wk0, etaUse) / 7) : null;
    const bucket = noEta ? 'noeta' : due ? 'due' : wi >= HZN ? 'after' : Math.max(0, wi);
    // "cột ma": the week the lot was planned in by its Original ETA (no buffer); past → 'due', none → null
    const org = orig0, owi = org && org >= r.log_date ? Math.floor(daysBetween(wk0, org) / 7) : null;
    const obucket = !org ? null : org < r.log_date ? 'due' : owi >= HZN ? 'after' : Math.max(0, owi);
    const k = info.get(r.sku) || {};
    return {...r, qty, slip, overdue, noEta, due, etaUse, bucket, obucket, eta: etaOf(r, r.log_date, buf),
      pl: k.mainPL || r.product_line || '—', pic: k.pic || 'Unassigned',
      stage: STAGES.includes(r.physical_status) ? r.physical_status : OTHER};
  });
  IV.lines = lines;
  const bySku = new Map(); lines.forEach(l => { if(!bySku.has(l.sku)) bySku.set(l.sku, []); bySku.get(l.sku).push(l); });
  // AMS periods
  const DD = IV.daily, S = IV.sales;
  let per = null;
  if(DD){
    const yStart = DD.year + '-01-01', m3 = addD(DD.maxDate, -89), mStart = DD.maxDate.slice(0, 8) + '01';
    per = {ytd: {days: DD.dataDays.filter(d => d >= yStart), cal: daysBetween(yStart, DD.maxDate) + 1, from: yStart},
           m3: {days: DD.dataDays.filter(d => d >= m3), cal: 90, from: m3}, mStart};
    IV.per = per;
  }
  const skus = new Set(followUp().map(r => r.sku));   // every SKU of the follow-up, also those without stock or incoming
  const rows = [];
  for(const sku of skus){
    const k = info.get(sku) || {}, s = sell.get(sku) || {}, L = bySku.get(sku) || [], As = asinBy.get(sku) || [];
    // SALABLE AMZ = Amazon sellable on-hand (04_AMZ_sellable details, sum over the SKU's ASINs); SKU without ASIN rows → inv_amz of the file
    const amzSrc = As.some(a => a.sellable_on_hand_units != null) ? 'asin' : 'file';
    const amz = Math.max(0, amzSrc === 'asin' ? As.reduce((t, a) => t + (+a.sellable_on_hand_units || 0), 0) : +s.inv_amz || 0);
    const y4a = Math.max(0, +s.inv_y4a || 0), tot = amz + y4a;
    const incA = Array(HZN).fill(0), incY = Array(HZN).fill(0);
    L.forEach(l => { const i = Math.floor(daysBetween(wk0, l.eta) / 7); if(i >= HZN) return; (l.source === 'AMZ' ? incA : incY)[Math.max(0, i)] += l.qty; });
    // demand (forecast)
    let f = null, hist = null;
    if(S && S.by.has(sku)){
      hist = S.by.get(sku); f = INV.forecastSeries(hist, HZN + 1);
      // out of stock now and the last 4 weeks fell below half of weeks 5–12: sales were capped by stock,
      // not by demand, so use the level before the stock-out
      const r4 = mean(hist.slice(-4).map(v => Math.max(0, v))), r12 = mean(hist.slice(-12, -4).map(v => Math.max(0, v)));
      if(amz <= 0 && r12 > 0 && r4 < r12 * 0.5){ f = {...f, model: 'OOS-adjusted', wape: null, fc: Array(HZN + 1).fill(r12)}; }
    }
    const fcW = f ? f.fc.slice(0, HZN) : null;
    if(fcW && S && S.maxDate >= wk0){ // part of week 0 already sold: count only the days left
      const left = Math.max(0, 7 - (daysBetween(wk0, S.maxDate) + 1)); fcW[0] = fcW[0] * left / 7;
    }
    const proj = (start, inc) => { let st = start, oosWk = null, lost = 0; const p = [];
      for(let i = 0; i < HZN; i++){ st += inc[i]; const d = fcW ? fcW[i] : 0; if(st < d && oosWk === null && d > 0) oosWk = i; lost += Math.max(0, d - st); st = Math.max(0, st - d); p.push(st); }
      return {p, oosWk, lost}; };
    const pA = proj(amz, incA), pT = proj(tot, incA.map((v, i) => v + incY[i]));
    const nextOf = src => L.filter(l => l.source === src).sort((a, b) => a.eta < b.eta ? -1 : 1)[0] || null;
    const nA = nextOf('AMZ'), nY = nextOf('Y4A');
    const dl = L.filter(l => l.on_time_status === 'delay vs expected'), od = L.filter(l => l.on_time_status === 'delay vs current');
    const sum = (a, key = 'qty') => a.reduce((t, x) => t + (+x[key] || 0), 0);
    const fc4 = fcW ? mean(f.fc.slice(0, 4)) : null, act4 = hist ? mean(hist.slice(-4)) : null;
    const woc = fc4 > 0 ? amz / fc4 : null, wocT = fc4 > 0 ? tot / fc4 : null;
    // AMS / MOC / MTD
    const ser = DD ? DD.by.get(sku) || new Map() : null;
    const a26 = per ? INV.ams(ser, per.ytd.days, per.ytd.cal) : null, a3 = per ? INV.ams(ser, per.m3.days, per.m3.cal) : null;
    let mtd = null; if(DD){ mtd = 0; ser.forEach((v, d) => { if(d >= per.mStart && d <= DD.maxDate) mtd += v; }); }
    const mocOf = a => a && a.ams > 0 ? tot / a.ams : null;
    const moc26 = mocOf(a26), moc3 = mocOf(a3);
    // risk + suggestion (forecast based; bộ lọc Rủi ro)
    let risk = 'OK', why = [], rank = 5;
    if(fcW && pA.oosWk !== null && pA.oosWk < 8){
      rank = pA.oosWk <= 2 ? 1 : 2; risk = pA.oosWk <= 2 ? 'OOS ≤2 tuần' : 'OOS trong 8 tuần';
      why.push(`AMZ hết hàng tuần ${md(weeks[pA.oosWk])}` + (nA ? `, hàng AMZ kế tiếp ${md(nA.eta)}` : ', chưa có hàng AMZ về'));
      if(y4a > 0) why.push(`Tồn Y4A ${Math.round(y4a)}: đẩy hàng sang Amazon`);
      const yEarly = L.filter(l => l.source === 'Y4A' && (!nA || l.eta < nA.eta));
      if(yEarly.length) why.push(`Y4A về ${md(yEarly[0].eta)}${yEarly[0].container_number ? ' (' + yEarly[0].container_number + ')' : ''} sớm hơn AMZ: request kéo hàng về sớm`);
      else if(nY) why.push(`Hàng Y4A ${nY.container_number ? nY.container_number + ' ' : ''}ETA ${md(nY.eta)}: hỏi kéo sớm`);
      if(rank === 1) why.push('Giảm ads / promo để giữ tồn tới khi hàng về');
    } else if(od.length){ rank = 3; risk = 'Hàng quá ETA'; why.push(`${Math.round(sum(od))} units đã quá ETA mà chưa về: follow-up Amazon / forwarder`); }
    else if(dl.length && sum(dl) > 0){ rank = 4; risk = 'ETA bị lùi'; why.push(`ETA lùi tối đa ${Math.max(...dl.map(l => l.slip || 0))} ngày trên ${Math.round(sum(dl))} units`); }
    if(fc4 > 0 && wocT > 26){ if(rank >= 4){ rank = 4; risk = 'Tồn cao'; } why.push(`Tồn + hàng về đủ ~${Math.round(wocT)} tuần: cân nhắc dời hàng về / đẩy bán`); }
    if(!fcW && tot > 0 && rank === 5){ risk = 'Chưa có forecast'; rank = 6; }
    if(!L.length && tot <= 0 && !(fc4 > 0) && !(a3 && a3.ams > 0) && !mtd) continue;   // nothing to track: no stock, no incoming, no sales
    // Flag: concrete reasons, most urgent first
    const flags = [];
    const dueL = L.filter(l => l.due), noEtaL = L.filter(l => l.noEta), lateL = L.filter(l => !l.due && !l.noEta && (l.slip || 0) > 0);
    if(tot <= 0) flags.push({r: 1, t: 'Hết hàng cả 2 kho', c: 'red'});
    else if(amz <= 0) flags.push({r: 1, t: `AMZ hết hàng${y4a > 0 ? ` (Y4A còn ${Math.round(y4a).toLocaleString('en-US')})` : ''}`, c: 'red'});
    else if(risk === 'OOS ≤2 tuần' || risk === 'OOS trong 8 tuần') flags.push({r: risk === 'OOS ≤2 tuần' ? 1 : 2, t: `Nguy cơ OOS AMZ tuần ${md(weeks[pA.oosWk])}`, c: risk === 'OOS ≤2 tuần' ? 'red' : 'amber'});
    if(dueL.length) flags.push({r: 2, t: `ETA đã đến hạn, vẫn incoming: ${Math.round(sum(dueL)).toLocaleString('en-US')} u (quá tối đa ${Math.max(...dueL.map(l => l.overdue))} ngày)`, c: 'red'});
    if(noEtaL.length) flags.push({r: 3, t: `Chưa có ETA: ${Math.round(sum(noEtaL)).toLocaleString('en-US')} u`, c: 'amber'});
    if(lateL.length) flags.push({r: 3, t: `ETA bị lùi tối đa ${Math.max(...lateL.map(l => l.slip))} ngày: ${Math.round(sum(lateL)).toLocaleString('en-US')} u`, c: 'amber'});
    if(tot > 0 && moc3 != null && moc3 < 1 && !flags.some(x => x.r <= 2)) flags.push({r: 2, t: `Tồn thấp: MOC 3M ${moc3.toFixed(1)} tháng`, c: 'amber'});
    if(moc3 != null && moc3 > 6) flags.push({r: 4, t: `Tồn cao: MOC 3M ${moc3.toFixed(1)} tháng`, c: 'gray'});
    flags.sort((a, b) => a.r - b.r);
    rows.push({sku, name: k.productName || s.product_name || (L[0] || {}).product_name || '', pl: k.mainPL || (L[0] || {}).product_line || '', subPl: k.subPL || '', lifecycle: k.lifecycle || '', pic: k.pic || 'Unassigned',
      dept: s.department || (L[0] || {}).department || '', amz, amzSrc, y4a, tot, incA, incY,
      incAmzTot: sum(L.filter(l => l.source === 'AMZ')), incY4aTot: sum(L.filter(l => l.source === 'Y4A')),
      delayQty: sum(dl), overdueQty: sum(od), maxSlip: dl.length ? Math.max(...dl.map(l => l.slip || 0)) : 0, maxOverdue: od.length ? Math.max(...od.map(l => l.overdue)) : 0,
      nA, nY, f, hist, fcW, fc4, act4, woc, wocT, pA, pT, risk, why, riskRank: rank, lines: L, asins: As,
      oosWk: pA.oosWk, lost: pA.lost, model: f ? f.model : '', acc: f && f.wape != null ? Math.max(0, 1 - f.wape) : null,
      a26, a3, ams26: a26 ? a26.ams : null, ams3: a3 ? a3.ams : null, moc26, moc3, mtd, flags, flagRank: flags.length ? flags[0].r * 10 + (9 - Math.min(9, flags.length)) : 99});
  }
  IV.rows = rows;
}

// ---------------------------------------------------------------- filters
const inScope = (r, skip) => (skip === 'pic' || !IV.pic || r.pic === IV.pic) && (!IV.pl || r.pl === IV.pl) && (!IV.sku || r.sku === IV.sku) &&
  (!IV.risk || r.risk === IV.risk) && (!IV.q || [r.sku, r.name, r.pl, r.subPl].join(' ').toLowerCase().includes(IV.q));
const filtered = () => IV.rows.filter(r => inScope(r));
const srcOk = l => !IV.src || l.source === IV.src;
// Sales person → Main PL list of that person; PIC + Main PL → SKU list
function fillFilters(){
  const h = H(), host = document.getElementById('view-inv'); if(!host) return;
  const opt = (list, cur, lbl) => '<option value="">All</option>' + list.map(v => `<option value="${h.esc(v)}"${v === cur ? ' selected' : ''}>${h.esc(lbl ? lbl(v) : v)}</option>`).join('');
  const pics = [...new Set(IV.rows.map(r => r.pic).filter(Boolean))].sort();
  const pls = [...new Set(IV.rows.filter(r => !IV.pic || r.pic === IV.pic).map(r => r.pl).filter(Boolean))].sort();
  const skuRows = IV.rows.filter(r => (!IV.pic || r.pic === IV.pic) && (!IV.pl || r.pl === IV.pl)).sort((a, b) => a.sku.localeCompare(b.sku));
  const names = new Map(skuRows.map(r => [r.sku, r.name]));
  host.querySelector('#ivPic').innerHTML = opt(pics, IV.pic);
  host.querySelector('#ivPl').innerHTML = opt(pls, IV.pl);
  host.querySelector('#ivSku').innerHTML = opt(skuRows.map(r => r.sku), IV.sku, s => s + ' · ' + String(names.get(s) || '').slice(0, 34));
}
// chart mode follows the filters: Main PL selected → SKU, else (sales person or nothing) → Main PL.
// "Hàng đang ở đâu" is a deliberate view and is kept.
function autoMode(){ if(IV.mode !== 'stage') IV.mode = IV.pl ? 'sku' : 'pl'; }
function setPic(v){
  IV.pic = v;
  if(IV.pl && !IV.rows.some(r => r.pl === IV.pl && (!v || r.pic === v))) IV.pl = '';
  if(IV.sku && !IV.rows.some(r => r.sku === IV.sku && (!v || r.pic === v) && (!IV.pl || r.pl === IV.pl))) IV.sku = '';
  autoMode(); fillFilters(); paint();
}
function setPl(v){
  IV.pl = v;
  if(IV.sku && !IV.rows.some(r => r.sku === IV.sku && r.pl === v)) IV.sku = v ? '' : IV.sku;
  autoMode(); fillFilters(); paint();
}

// ---------------------------------------------------------------- render
INV.render = async function(){
  const host = document.getElementById('view-inv'); if(!host) return;
  const h = H();
  if(!host.dataset.built){ build(host); host.dataset.built = '1'; }
  if(!IV.data || IV.loadedFor !== IV.country){
    host.querySelector('#ivBody').innerHTML = '<tr><td colspan="13" style="padding:18px;color:var(--muted)">Đang tải tồn kho, incoming và số bán…</td></tr>';
    try { await load(); }
    catch(e){ IV.data = null; host.querySelector('#ivBody').innerHTML = `<tr><td colspan="13" style="padding:18px;color:var(--muted)">${h.missingSchema(e) ? 'Chưa có bảng: chạy <b>supabase_inventory_tracking.sql</b> trong SQL Editor.' : 'Không tải được: ' + h.esc(e.message || e)}</td></tr>`; return; }
    compute();
    if(IV.pic && !IV.rows.some(r => r.pic === IV.pic)) IV.pic = '';
    fillFilters();
  }
  paint();
};
function build(host){
  const h = H(), yr = String(new Date().getFullYear());
  host.innerHTML = `<div class="filterbar iv-filters">
      <div class="fld"><label for="ivPic">Sales person (PIC)</label><select id="ivPic"><option value="">All</option></select></div>
      <div class="fld"><label for="ivPl">Main PL</label><select id="ivPl"><option value="">All</option></select></div>
      <div class="fld"><label for="ivSku">SKU</label><select id="ivSku"><option value="">All</option></select></div>
      <div class="fld"><label for="ivSrc2">Kho đến</label><select id="ivSrc2"><option value="">AMZ + Y4A</option><option value="AMZ">AMZ (kho Amazon)</option><option value="Y4A">Y4A (kho mình)</option></select></div>
      <div class="fld"><label for="ivRisk">Rủi ro</label><select id="ivRisk"><option value="">All</option><option>OOS ≤2 tuần</option><option>OOS trong 8 tuần</option><option>Hàng quá ETA</option><option>ETA bị lùi</option><option>Tồn cao</option><option>OK</option></select></div>
      <div class="fld"><label for="ivEta">ETA</label><select id="ivEta"><option value="file">ETA trong file</option><option value="safe">ETA thận trọng (+ độ trễ TB)</option></select></div>
      <div class="fld"><label for="ivQ">Tìm SKU / tên</label><input id="ivQ" type="search" placeholder="VD: DXD3, Kettlebell…"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn small" id="ivReload" type="button">↻ Tải lại</button></div>
    </div>
    <div class="btr-src iv-asof" id="ivSrc"></div>
    <div class="card iv-hero">
      <div class="iv-head"><h3 style="margin:0">Incoming theo tuần</h3>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="iv-ghost-tg"><input type="checkbox" id="ivGhost"> Cột ma: kế hoạch theo ETA ban đầu</label>
        <span class="iv-def" tabindex="0" role="button" aria-label="Xem định nghĩa cột ma">ⓘ Xem định nghĩa<span class="iv-def-pop" role="tooltip">
          <b>Cột ma (viền nét đứt) = kế hoạch theo ETA ban đầu</b>
          <span class="iv-def-p">Ở mỗi cột tuần: units của các lô lẽ ra về tuần đó theo <b>Original ETA</b>. Cột ma cao hơn cột màu = hàng bị lùi / kéo đi khỏi tuần đó; thấp hơn = tuần đó nhận hàng dồn tới. Rê chuột vào đỉnh cột ma để xem chi tiết; bấm để lọc danh sách lô.</span>
          <b>Cột “Đã đến hạn, vẫn incoming”</b>
          <span class="iv-def-p"><b>Cột màu:</b> các lô có <b>Current ETA đã qua</b> (trước ngày của file incoming) mà vẫn còn trong tracker, tức là đến hạn rồi nhưng chưa thành hàng sellable. Đây là những lô cần follow ngay.</span>
          <span class="iv-def-p"><b>Cột ma:</b> các lô có <b>Original ETA đã qua</b>, tức là theo kế hoạch ban đầu lẽ ra đã về rồi. Cột này không phải một tuần cụ thể mà cộng dồn mọi lô trễ so với kế hoạch tính tới hôm nay, nên thường cao hơn nhiều so với các cột tuần.</span>
          <b>Cách đọc chênh lệch</b>
          <span class="iv-def-p">• <b>Vẫn quá hạn, chưa về:</b> Original ETA và Current ETA đều đã qua.<br>• <b>Đã dời ETA ra sau (trễ):</b> Original ETA đã qua, nhưng Current ETA được dời sang tuần sau, nên lô nằm ở cột tuần mới, không còn ở cột này.<br>• <b>Lô kéo sớm tới:</b> Original ETA ở tuần sau, nhưng Current ETA bị dời sớm hơn rồi đã qua mà hàng chưa về, nên lô rơi vào cột này.<br>• <b>Cột ma cao hơn cột màu</b> nghĩa là phần lớn hàng trễ đã được hẹn lại ngày mới; phần đó xem ở các cột tuần phía sau.</span>
          <b>Ghi chú</b>
          <span class="iv-def-p">Chỉ tính các lô còn trong tracker (lô đã về thì không còn). Lô thiếu Original ETA được coi là đúng hạn (Original = Current).</span>
        </span></span>
        <div class="cv-toggle" id="ivMode" role="group" aria-label="Chia màu theo"><button class="cv-btn" data-m="pl" type="button">Main PL</button><button class="cv-btn" data-m="sku" type="button">SKU</button><button class="cv-btn" data-m="stage" type="button">Hàng đang ở đâu</button></div></div></div>
      <div class="hint" id="ivWeeklyHint" style="margin:6px 0 0"></div>
      <div class="iv-special" id="ivSpecial"></div>
      <div id="ivWeekly" class="plot" style="height:420px"></div>
    </div>
    <div class="kpis iv-kpis" id="ivKpis"></div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h3 style="margin:0">Theo dõi theo SKU</h3>
        <div style="display:flex;gap:8px"><button class="btn small" id="ivAi" type="button">🤖 AI phân tích &amp; đề xuất</button><button class="btn small" id="ivExport" type="button">&#128190; Export Excel</button></div></div>
      <div id="ivAiOut" class="ai-out" hidden style="white-space:pre-wrap;font-size:12.5px;background:#F7F9FC;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0"></div>
      <div class="hint" id="ivTableHint"></div>
      <div class="tablewrap" style="max-height:640px"><table id="ivTable"><thead><tr>
        <th data-k="pic">PIC</th><th data-k="pl">Main PL</th><th data-k="sku">SKU</th>
        <th data-k="tot" class="num" title="Tồn sellable on-hand kho Amazon + kho Y4A">SALABLE AMZ+Y4A</th>
        <th data-k="y4a" class="num" title="Tồn sellable kho Y4A (06_ USA_Sellable INV)">SALABLE Y4A</th>
        <th data-k="amz" class="num" title="Amazon sellable on-hand (04_AMZ_sellable details, cộng các ASIN của SKU). SKU không có dòng ASIN: dùng tồn AMZ của 06_ USA_Sellable INV.">SALABLE AMZ</th>
        <th data-k="inc4" class="num" title="Các lô chưa đến hạn có ETA trong tuần hiện tại + 3 tuần kế tiếp (tuần bắt đầu Chủ nhật), theo ETA đang chọn và kho đến đang lọc">Incoming 4W</th>
        <th data-k="moc26" class="num" data-rule="1">MOC <span class="iv-yr">${yr}</span></th><th data-k="ams26" class="num" data-rule="1">AMS <span class="iv-yr">${yr}</span></th>
        <th data-k="moc3" class="num" data-rule="1">MOC 3M</th><th data-k="ams3" class="num" data-rule="1">AMS 3M</th>
        <th data-k="mtd" class="num" title="Actual units bán từ đầu tháng tới ngày có dữ liệu sales gần nhất">MTD Sale</th>
        <th data-k="flagRank">Flag</th>
      </tr></thead><tbody id="ivBody"></tbody></table></div>
    </div>
    <div class="iv-sec"><div class="iv-sec-t">Chi tiết một SKU</div><div class="iv-sec-d">Dùng khi một SKU có cờ: xem tồn AMZ dự phóng theo tuần và hàng về để quyết định kéo hàng Y4A, đẩy tồn sang Amazon hay giảm ads / promo. Bấm một dòng ở bảng SKU hoặc danh sách lô để mở.</div></div>
    <div class="card" id="ivDetail"></div>
    <div class="iv-sec"><div class="iv-sec-t">Follow-up PO</div><div class="iv-sec-d">Dùng hằng ngày: tìm đúng PO / lô cần đuổi với Amazon, forwarder hoặc kho (đã đến hạn mà chưa về, chưa có ETA, bị lùi ETA).</div></div>
    <div class="card" id="ivPoCard">
      <h3 style="margin:0">Incoming PO theo trạng thái</h3>
      <div class="hint" style="margin-top:3px">Units đang về theo Delay Status trong tracker. Bấm một thanh, hoặc một cột / chip của chart Incoming theo tuần ở trên, để lọc danh sách lô bên dưới đúng các lô đó.</div>
      <div id="ivPoStatus" class="plot" style="height:230px;min-height:230px"></div>
      <div id="ivLots">
        <div class="iv-lots-head"><h3 style="margin:0;font-size:13.5px">Danh sách lô</h3><div id="ivLsum" style="font-size:12.5px"></div></div>
        <div class="iv-lotbar">
          <input id="ivLq" type="search" placeholder="Tìm PO / SKU / container…" aria-label="Tìm PO, SKU, container">
          <label>ETA / tuần<select id="ivLwk"></select></label>
          <label>Delay Status<select id="ivLst"><option value="">Tất cả</option>${PO_ST.map(s => `<option>${s}</option>`).join('')}</select></label>
          <label>Stage<select id="ivLstage"><option value="">Tất cả</option>${[...STAGES, OTHER].map(s => `<option>${s}</option>`).join('')}</select></label>
          <label>Kho đến<select id="ivLsrc"><option value="">AMZ + Y4A</option><option value="AMZ">AMZ</option><option value="Y4A">Y4A</option></select></label>
          <label class="iv-ghost-tg" style="flex-direction:row;text-transform:none;letter-spacing:0;font-size:11.5px" title="Ngày đặt, ship, cảng và lịch sử ETA của từng lô"><input type="checkbox" id="ivLwide"> Hiện cột hành trình</label>
          <span id="ivLgrp"></span>
          <button type="button" class="btn small" id="ivLreset">✕ Bỏ lọc lô</button>
        </div>
        <div id="ivLtable"></div>
      </div>
    </div>
    <div class="iv-sec"><div class="iv-sec-t">Phân tích</div><div class="iv-sec-d">Dùng cho review tuần / báo cáo: so sánh giữa các PIC, product line nào hay trễ và ETA thường bị lùi bao lâu. Để nhìn xu hướng, không dùng để follow từng lô.</div></div>
    <div class="card"><h3>Tổng hợp theo PIC</h3>
      <div class="hint">So sánh giữa các PIC: tồn, hàng về, hàng trễ và rủi ro OOS của các SKU mình phụ trách (theo follow-up). Bấm một PIC để lọc cả trang; bấm lại để bỏ lọc.</div>
      <div class="tablewrap" style="max-height:420px"><table id="ivPicTable"><thead><tr>
        <th>PIC</th><th class="num">SKU</th><th class="num">Tồn AMZ</th><th class="num">Tồn Y4A</th><th class="num">Forecast / tuần</th><th class="num">WOC AMZ</th>
        <th class="num">Incoming AMZ</th><th class="num">Incoming Y4A</th><th class="num">Units ETA lùi</th><th class="num">Units quá ETA</th>
        <th class="num">OOS ≤2 tuần</th><th class="num">OOS 8 tuần</th><th class="num">Units có thể mất</th><th class="num">Tồn cao</th>
      </tr></thead><tbody id="ivPicBody"></tbody></table></div>
    </div>
    <div class="card iv-late" id="ivLate"><h3 style="margin:0">Phân tích hàng trễ</h3>
      <div class="iv-late-grid">
        <div><div class="hint" style="margin:8px 0 4px"><b>Hàng trễ theo Main PL</b>: units ETA lùi so với ban đầu và đã quá ETA. Rê chuột để xem số SKU và số ngày trễ.</div><div id="ivPlDelay" class="plot" style="height:360px;min-height:360px"></div></div>
        <div><div class="hint" style="margin:8px 0 4px"><b>ETA bị lùi bao nhiêu ngày</b>: phân bố ETA hiện tại − ETA ban đầu (theo units). Đây là "độ trễ TB" cộng thêm khi chọn ETA thận trọng.</div><div id="ivSlip" class="plot" style="height:360px;min-height:360px"></div></div>
      </div>
    </div>`;
  const $ = s => host.querySelector(s), re = () => paint();
  $('#ivPic').onchange = e => setPic(e.target.value);
  $('#ivPl').onchange = e => setPl(e.target.value);
  $('#ivSku').onchange = e => { IV.sku = e.target.value; re(); };
  $('#ivSrc2').onchange = e => { IV.src = e.target.value; re(); };
  $('#ivRisk').onchange = e => { IV.risk = e.target.value; re(); };
  $('#ivEta').onchange = e => { IV.etaMode = e.target.value; compute(); re(); };
  $('#ivQ').oninput = e => { IV.q = e.target.value.trim().toLowerCase(); re(); };
  $('#ivReload').onclick = () => { IV.data = null; IV.sales = null; IV.daily = null; IV.hist = new Map(); INV.render(); };
  $('#ivExport').onclick = exportXlsx;
  $('#ivAi').onclick = () => askAi(false);
  host.querySelectorAll('#ivMode .cv-btn').forEach(b => b.onclick = () => { IV.mode = b.dataset.m; paintWeekly(); });
  $('#ivGhost').onchange = e => { IV.ghost = e.target.checked; paintWeekly(); };
  host.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; if(IV.sort === k) IV.dir *= -1; else { IV.sort = k; IV.dir = ['pic','sku','pl','flagRank'].includes(k) ? 1 : -1; } re(); });
  host.querySelectorAll('#ivTable thead th[data-rule]').forEach(th => th.title = INV.AMS_RULE);
  bindLotBar(host);
}

const fi = v => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US');
const f1 = v => v == null || !isFinite(v) ? '—' : v > 99 ? '>99' : v.toFixed(1);
const sumQ = a => a.reduce((t, l) => t + (l.qty || 0), 0);
// lines in scope: SKUs that pass the filters, and the selected destination warehouse
function scopeLines(rows){ const keep = new Set((rows || filtered()).map(r => r.sku)); return IV.lines.filter(l => keep.has(l.sku) && srcOk(l)); }

function paint(){
  const h = H(), D = IV.data; if(!D) return;
  const rows = filtered(), lines = scopeLines(rows);
  // data dates of every source
  const up = D.up, logA = maxOf(D.inc.filter(l => l.source === 'AMZ').map(l => l.log_date)), logY = maxOf(D.inc.filter(l => l.source === 'Y4A').map(l => l.log_date));
  const y4aAt = maxOf(D.sell.map(r => r.y4a_as_of)), amzAt = maxOf(D.asin.map(r => r.log_date)) || maxOf(D.sell.map(r => r.amz_as_of));
  const st = (k, v, t) => `<span title="${h.esc(t || '')}">${k}: <b>${v}</b></span>`;
  document.getElementById('ivSrc').innerHTML =
    st('Inventory as of', `Y4A ${mdy(y4aAt)} · AMZ ${mdy(amzAt)}`, 'Tồn Y4A: 06_ USA_Sellable INV · tồn AMZ (sellable on-hand): 04_AMZ_sellable details') +
    st('Incoming as of', `AMZ ${mdy(logA)} · Y4A ${mdy(logY)}`, 'log_date của 01_AMZ_incoming_details / 02_Y4A_incoming_details') +
    st('Sales through', IV.daily ? mdy(IV.daily.maxDate) : IV.sales ? mdy(IV.sales.maxDate) : '—', 'Ngày có dữ liệu sales gần nhất (sales_daily)') +
    (up ? `<span>Tự động cập nhật lần cuối: <b>${(d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)(new Date(up.uploaded_at))}</b> (mỗi giờ)</span>` : '<span>Chưa có lần cập nhật nào: chờ flow tự động (mỗi giờ)</span>') +
    `<span>USA · <b>${rows.length}</b>/${IV.rows.length} SKU của follow-up</span>`;
  paintWeekly(rows, lines);
  // KPIs
  const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
  const dl = lines.filter(l => l.on_time_status === 'delay vs expected'), od = lines.filter(l => l.on_time_status === 'delay vs current');
  const tot = sumQ(lines), slipAvg = sum(dl, l => (l.slip || 0) * l.qty) / (sumQ(dl) || 1), odAvg = sum(od, l => l.overdue * l.qty) / (sumQ(od) || 1);
  const oos2 = rows.filter(r => r.risk === 'OOS ≤2 tuần').length, oos8 = rows.filter(r => r.risk === 'OOS trong 8 tuần').length;
  const accRows = rows.filter(r => r.acc != null && r.fc4 > 0), acc = sum(accRows, r => r.acc * r.fc4) / (sum(accRows, r => r.fc4) || 1);
  const mix = {}; accRows.forEach(r => mix[r.model] = (mix[r.model] || 0) + 1);
  document.getElementById('ivKpis').innerHTML = [
    ['Incoming', fi(tot) + ' u', `${new Set(lines.map(l => l.sku)).size} SKU · AMZ ${fi(sumQ(lines.filter(l => l.source === 'AMZ')))} / Y4A ${fi(sumQ(lines.filter(l => l.source === 'Y4A')))}`],
    ['ETA lùi so với ban đầu', fi(sumQ(dl)) + ' u', `${tot ? (sumQ(dl) / tot * 100).toFixed(0) : 0}% units · ${new Set(dl.map(l => l.sku)).size} SKU · lùi TB ${slipAvg.toFixed(0)} ngày`],
    ['Quá ETA, chưa về', fi(sumQ(od)) + ' u', `${new Set(od.map(l => l.sku)).size} SKU · quá TB ${odAvg.toFixed(0)} ngày`],
    ['Tồn sellable', fi(sum(rows, r => r.tot)) + ' u', `AMZ ${fi(sum(rows, r => r.amz))} · Y4A ${fi(sum(rows, r => r.y4a))}`],
    ['Nguy cơ OOS (AMZ)', `${oos2 + oos8} SKU`, `${oos2} SKU ≤ 2 tuần · ${oos8} SKU trong 8 tuần · mất ~${fi(sum(rows.filter(r => r.oosWk !== null && r.oosWk < 8), r => r.lost))} u / ${HZN} tuần`],
    ['Forecast', accRows.length ? (acc * 100).toFixed(0) + '%' : '—', accRows.length ? 'độ chính xác backtest · ' + Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ') : 'chưa có số bán'],
  ].map(([k, v, s]) => `<div class="kpi"><div class="lbl">${k}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join('');
  paintTable(rows);
  paintPo(lines);
  paintPic();
  paintLate(lines);
  // SKU chart: the clicked SKU, else the first SKU of the list
  if(!IV.sel || !rows.some(r => r.sku === IV.sel)) IV.sel = IV.sku || (IV.sorted && IV.sorted.length ? IV.sorted[0].sku : null);
  detail();
}

// ---------------------------------------------------------------- 1) Incoming theo tuần
function weekCats(){
  const W = IV.weeks;
  const cats = ['due', 'noeta', ...W.map((_, i) => i), 'after'];
  const lbl = c => c === 'due' ? 'Đã đến hạn,<br>vẫn incoming' : c === 'noeta' ? 'Chưa có ETA' : c === 'after' ? 'Từ ' + md(addD(W[0], HZN * 7)) : (c === 0 ? 'Tuần này<br>' : '') + md(W[c]);
  const plain = c => c === 'due' ? 'ETA đã đến hạn, vẫn incoming' : c === 'noeta' ? 'Chưa có ETA' : c === 'after' ? 'Từ ' + md(addD(W[0], HZN * 7)) + ' trở đi' : 'Tuần ' + md(W[c]) + ' → ' + md(addD(W[c], 6));
  return {cats, lbl, plain};
}
// one click handler per chart (Plotly.purge drops listeners, so re-bind after every draw)
function onClick(g, fn){
  if(!g || !g.on) return;
  if(g.removeAllListeners) g.removeAllListeners('plotly_click');
  g.on('plotly_click', ev => { const p = ev && ev.points && ev.points[0]; if(p && p.customdata) fn(p); });
}
const groupOf = (l, mode) => mode === 'sku' ? l.sku : mode === 'stage' ? l.stage : l.pl;
// colours follow the entity: a PL / SKU keeps its slot while it stays on the chart
function colorsFor(keys, memo){
  const out = new Map(), used = new Set();
  keys.forEach(k => { const c = memo.get(k); if(c && !used.has(c)){ out.set(k, c); used.add(c); } });
  keys.forEach(k => { if(out.has(k)) return; const c = CAT.find(x => !used.has(x)); out.set(k, c); used.add(c); memo.set(k, c); });
  return out;
}
function seriesOf(lines, mode){
  if(mode === 'stage') return {keys: [...STAGES, OTHER].filter(s => lines.some(l => l.stage === s)), top: null, color: k => STAGE_C[k]};
  const tot = new Map(); lines.forEach(l => { const g = groupOf(l, mode); tot.set(g, (tot.get(g) || 0) + l.qty); });
  const ranked = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const top = ranked.length > CAT.length ? ranked.slice(0, CAT.length - 1) : ranked;
  const cmap = colorsFor(top, IV.memo[mode]);
  return {keys: ranked.length > top.length ? [...top, OTHER] : top, top: new Set(top), color: k => k === OTHER ? C.other : cmap.get(k)};
}
// short labels of a week bucket, for the "bị đẩy" tooltips
const bucketShort = c => { const W = IV.weeks; if(c === 'due') return 'đã qua'; if(c === 'noeta') return 'chưa có ETA'; if(c === 'after') return 'sau ' + md(addD(W[0], HZN * 7 - 1)); return 'tuần ' + md(W[+c]); };
// time order of week buckets: ETA đã qua < tuần 0..15 < sau 16 tuần < chưa có ETA — tells a delay (later) from a pull-in (earlier)
const bOrd = c => c === 'due' ? -1 : c === 'after' ? HZN : c === 'noeta' ? HZN + 1 : +c;
const ghostFrom = (o, c) => (bOrd(o) < bOrd(c) ? 'lùi từ ' : 'kéo sớm từ ') + (o === 'due' ? 'ETA ban đầu đã qua' : bucketShort(o));
const ghostTo = k => k === 'due' ? 'quá hạn, chưa về' : k === 'noeta' ? 'nay chưa có ETA' : bucketShort(k);
function paintWeekly(rows, lines){
  const h = H(); if(!IV.data) return;
  rows = rows || filtered(); lines = lines || scopeLines(rows);
  document.querySelectorAll('#ivMode .cv-btn').forEach(b => b.classList.toggle('active', b.dataset.m === IV.mode));
  const {cats, lbl, plain} = weekCats(), mode = IV.mode, S = seriesOf(lines, mode);
  const keyOf = l => mode !== 'stage' && S.top && !S.top.has(groupOf(l, mode)) ? OTHER : groupOf(l, mode);
  const x = cats.map(lbl), ci = new Map(cats.map((c, i) => [c, i]));
  const cell = new Map(), det = new Map();
  lines.forEach(l => { const k = keyOf(l) + '|' + ci.get(l.bucket); cell.set(k, (cell.get(k) || 0) + l.qty);
    const d = det.get(k) || {st: {}, src: {AMZ: 0, Y4A: 0}, sku: new Map(), lots: 0, from: new Map()}; d.st[l.stage] = (d.st[l.stage] || 0) + l.qty; d.src[l.source] = (d.src[l.source] || 0) + l.qty;
    const o = l.obucket == null ? 'none' : l.obucket === l.bucket ? 'same' : String(l.obucket); d.from.set(o, (d.from.get(o) || 0) + l.qty);
    d.sku.set(l.sku, (d.sku.get(l.sku) || 0) + l.qty); d.lots++; det.set(k, d); });
  // hover detail of one segment: where the goods are (% per stage), destination warehouse, and for "Khác" / Main PL the SKUs inside
  const pct = (v, t) => t ? Math.round(v / t * 100) + '%' : '—';
  const hov = (k, i) => { const d = det.get(k + '|' + i); if(!d) return ''; const t = cell.get(k + '|' + i) || 0, out = [];
    if(mode !== 'stage') out.push('<b>Hàng đang ở đâu</b>', ...[...STAGES, OTHER].filter(st => d.st[st]).map(st => `${st}: ${pct(d.st[st], t)} · ${fi(d.st[st])} u`));
    out.push(`<b>Kho đến</b>: AMZ ${pct(d.src.AMZ, t)} · Y4A ${pct(d.src.Y4A, t)}`);
    if(mode !== 'sku' || k === OTHER){ const top = [...d.sku.entries()].sort((a, b) => b[1] - a[1]); out.push(`<b>${top.length} SKU</b>${top.length > 1 ? ', nhiều nhất' : ''}: ` + top.slice(0, 3).map(([s, q]) => `${s} ${fi(q)} u`).join(' · ') + (top.length > 3 ? ' · …' : '')); }
    if(cats[i] !== 'noeta' && (d.from.size > 1 || !d.from.has('same'))){
      const moved = [...d.from.entries()].filter(([o]) => o !== 'same' && o !== 'none').sort((a, b) => b[1] - a[1]);
      out.push('<b>Theo ETA ban đầu</b>: ' + [d.from.get('same') ? `đúng tuần này ${fi(d.from.get('same'))} u` : '', ...moved.slice(0, 3).map(([o, q]) => `${ghostFrom(o, cats[i])} ${fi(q)} u`), moved.length > 3 ? '…' : '', d.from.get('none') ? `không có ETA ban đầu ${fi(d.from.get('none'))} u` : ''].filter(Boolean).join(' · '));
    }
    out.push(`${d.lots} lô`);
    return out.join('<br>'); };
  const special = cats.map(c => c === 'due' || c === 'noeta');
  const nameOf = k => mode === 'sku' && k !== OTHER ? k + ' · ' + String(((IV.rows.find(r => r.sku === k) || {}).name) || '').slice(0, 22) : k;
  const traces = S.keys.map(k => ({type: 'bar', name: nameOf(k), x, y: cats.map((_, i) => cell.get(k + '|' + i) || 0), texttemplate: '',
    marker: {color: S.color(k), line: {color: '#fff', width: 1}, pattern: {shape: special.map(s => s ? '/' : ''), fillmode: 'overlay', fgcolor: 'rgba(255,255,255,.6)', size: 7, solidity: .3}},
    customdata: cats.map((c, i) => [String(c), plain(c), k, hov(k, i)]), hovertemplate: '<b>%{fullData.name}</b><br>%{customdata[1]}: <b>%{y:,.0f} u</b><br>%{customdata[3]}<extra>bấm để xem lô</extra>'}));
  // legend swatches without the stripe pattern of the first two columns (one legend entry per series, toggles its bars)
  traces.forEach(t => { t.legendgroup = t.name; t.showlegend = false; });
  S.keys.forEach(k => traces.push({type: 'bar', name: nameOf(k), legendgroup: nameOf(k), x: [x[2]], y: [null], marker: {color: S.color(k)}, hoverinfo: 'skip', texttemplate: ''}));
  const totals = cats.map((_, i) => S.keys.reduce((t, k) => t + (cell.get(k + '|' + i) || 0), 0));
  traces.push({type: 'scatter', mode: 'text', x, y: totals, text: totals.map(v => v ? fi(v) : ''), textposition: 'top center', textfont: {size: 10.5, color: '#1B2733'}, hoverinfo: 'skip', showlegend: false, cliponaxis: false});
  // cột ma: per column, units of the lots still incoming whose Original ETA fell in that week (dashed outline, no fill)
  const plan = cats.map(c => c === 'noeta' ? 0 : sumQ(lines.filter(l => l.obucket === c)));
  // ghost tooltip as two sums that add up:
  //   Kế hoạch = giữ tuần này + bị đẩy đi        Thực tế = giữ tuần này + dồn tới (from other weeks / no Original ETA)
  const wkS = k => { const W = IV.weeks; return k === 'due' ? 'quá hạn' : k === 'noeta' ? 'chưa có ETA' : k === 'none' ? 'không có ETA ban đầu' : k === 'after' ? 'sau ' + md(addD(W[0], HZN * 7 - 1)) : 'tuần ' + md(W[+k]); };
  const split = (L, key) => { const m = new Map(); L.forEach(l => { const k = l[key] == null ? 'none' : String(l[key]); m.set(k, (m.get(k) || 0) + l.qty); });
    const a = [...m.entries()].sort((x, y) => y[1] - x[1]); return a.slice(0, 3).map(([k, q]) => `${key === 'obucket' && k === 'due' ? 'ETA ban đầu đã qua' : wkS(k)} ${fi(q)}`).join(' · ') + (a.length > 3 ? ' · …' : ''); };
  // which Main PL / SKU / stage (per the selected mode) moved, and to / from which weeks
  // one indented line per Main PL / SKU / stage (per the selected mode), with the weeks it went to / came from
  const byGroup = (L, key, arrow) => {
    if(!L.length) return '';
    const g = new Map(); L.forEach(l => { const k = groupOf(l, mode), a = g.get(k) || {q: 0, w: []}; a.q += l.qty; a.w.push(l); g.set(k, a); });
    const top = [...g.entries()].sort((a, b) => b[1].q - a[1].q), n = 4;
    return top.slice(0, n).map(([k, a]) => `<br>&nbsp;&nbsp;&nbsp;• ${k}${mode === 'sku' ? ' · ' + String(((IV.rows.find(r => r.sku === k) || {}).name) || '').slice(0, 18) : ''}: <b>${fi(a.q)} u</b> ${arrow} ${split(a.w, key)}`).join('') +
      (top.length > n ? `<br>&nbsp;&nbsp;&nbsp;• +${top.length - n} ${MODE_VI[mode]} khác: ${fi(top.slice(n).reduce((t, e) => t + e[1].q, 0))} u` : '');
  };
  // reads top → bottom: plan, what stayed, what left (later = trễ / earlier = kéo sớm), what arrived (from earlier weeks = trễ tới / from later weeks = kéo sớm tới),
  // actual = stayed + arrived. Direction comes from the week order, so an ETA moved earlier is never called "bị đẩy".
  const pc = (v, t) => t ? ` (${Math.round(v / t * 100)}%)` : '';
  const part = (L, title, key, arrow, color) => L.length ? `<br>${title}: <b style="color:${color}">${fi(sumQ(L))} u</b> ${arrow} ${split(L, key)}` + byGroup(L, key, arrow) : '';
  const ghostShapes = [], ghostTip = cats.map((c, i) => {
    if(!plan[i]) return '';
    const o = bOrd(c), L = lines.filter(l => l.obucket === c), keep = L.filter(l => l.bucket === c);
    const outLate = L.filter(l => l.bucket !== c && bOrd(l.bucket) > o), outEarly = L.filter(l => l.bucket !== c && bOrd(l.bucket) < o);
    const inn = lines.filter(l => l.bucket === c && l.obucket !== c), inLate = inn.filter(l => bOrd(l.obucket) < o), inEarly = inn.filter(l => bOrd(l.obucket) > o);
    const same = sumQ(keep), due = c === 'due', here = due ? 'ở cột này' : 'tuần này', d = totals[i] - plan[i];
    return `<b>Kế hoạch ban đầu</b> (theo Original ETA): <b>${fi(plan[i])} u</b> · ${L.length} lô` +
      `<br>${due ? 'Vẫn quá hạn, chưa về' : 'Vẫn về đúng tuần này'}: ${fi(same)} u${pc(same, plan[i])}` +
      part(outLate, due ? 'Đã dời ETA ra sau (trễ)' : 'Bị lùi sang tuần sau (trễ)', 'bucket', '→', '#D64545') +
      part(outEarly, 'Được kéo sớm sang tuần trước', 'bucket', '→', '#1E8E5A') +
      part(inLate, 'Lô trễ dồn tới từ tuần trước', 'obucket', '←', '#D64545') +
      part(inEarly, 'Lô kéo sớm tới từ tuần sau', 'obucket', '←', '#1E8E5A') +
      `<br><b>Thực tế đang về ${here}: ${fi(totals[i])} u</b> = ${fi(same)} ${due ? 'vẫn quá hạn' : 'đúng tuần'}${inLate.length ? ` + ${fi(sumQ(inLate))} trễ tới` : ''}${inEarly.length ? ` + ${fi(sumQ(inEarly))} kéo sớm tới` : ''}` +
      `<br><span style="color:${d < 0 ? '#D64545' : '#1E8E5A'}">${d < 0 ? 'Thiếu' : d > 0 ? 'Dư' : 'Bằng'} ${fi(Math.abs(d))} u so với kế hoạch</span>`;
  });
  if(IV.ghost){
    plan.forEach((v, i) => { if(v) ghostShapes.push({type: 'rect', xref: 'x', yref: 'y', x0: i - 0.46, x1: i + 0.46, y0: 0, y1: v, fillcolor: 'rgba(0,0,0,0)', line: {color: '#1B2733', width: 1.3, dash: 'dash'}, layer: 'above'}); });
    traces.push({type: 'scatter', mode: 'markers', name: 'Kế hoạch theo ETA ban đầu', x, y: plan.map(v => v || null), showlegend: false, legendgroup: 'ghost',
      marker: {symbol: 'line-ew', size: 40, color: 'rgba(0,0,0,0)', line: {color: 'rgba(0,0,0,0)', width: 6}},
      customdata: cats.map((c, i) => ['ghost', String(c), ghostTip[i]]), hovertemplate: '%{customdata[2]}<extra>bấm để xem lô</extra>'});
    traces.push({type: 'scatter', mode: 'lines', name: 'Cột ma = kế hoạch theo ETA ban đầu', x: [x[2]], y: [null], line: {color: '#1B2733', width: 1.3, dash: 'dash'}, hoverinfo: 'skip', legendgroup: 'ghost'});
  }
  const afterEmpty = !totals[totals.length - 1] && !(IV.ghost && plan[plan.length - 1]);
  const W = IV.weeks;
  h.draw('ivWeekly', traces, h.lay({barmode: 'stack', bargap: .28, hovermode: 'closest', hoverlabel: {bgcolor: '#fff', bordercolor: '#E4E5E6', align: 'left', font: {color: '#1B2733', size: 11.5}}, margin: {l: 56, r: 12, t: 30, b: 58},
    legend: {orientation: 'h', y: 1.1, x: 0, font: {size: 10.5}, traceorder: 'normal'},
    xaxis: h.ax({type: 'category', categoryorder: 'array', categoryarray: x, range: [-0.5, x.length - (afterEmpty ? 1.5 : 0.5)], tickfont: {size: 10.5, color: '#66707C'},
      title: {text: IV.etaMode === 'safe' ? 'Tuần (bắt đầu Chủ nhật) theo ETA thận trọng = Current Sellable ETA + độ trễ TB' : 'Tuần (bắt đầu Chủ nhật) theo Current Sellable ETA', font: {size: 11, color: '#66707C'}}}),
    yaxis: h.ax({tickformat: ',.0f', title: {text: 'Incoming units', font: {size: 11, color: '#66707C'}}}),
    shapes: [{type: 'rect', xref: 'x', yref: 'paper', x0: -0.5, x1: 1.5, y0: 0, y1: 1, fillcolor: '#FBF3DF', opacity: .55, line: {width: 0}, layer: 'below'},
             {type: 'line', xref: 'x', yref: 'paper', x0: 1.5, x1: 1.5, y0: 0, y1: 1, line: {color: '#B8860B', width: 1, dash: 'dot'}}, ...ghostShapes]}));
  const g = document.getElementById('ivWeekly');
  onClick(g, p => { if(p.customdata[0] === 'ghost') return openLots({kind: 'orig', cat: p.customdata[1]}); const [c, , k] = p.customdata; openLots({kind: 'week', cat: c, group: k, mode: IV.mode}); });
  // separately visible: lots past their ETA and lots without an ETA
  const due = lines.filter(l => l.due), noEta = lines.filter(l => l.noEta), sk = a => new Set(a.map(l => l.sku)).size;
  document.getElementById('ivSpecial').innerHTML =
    `<button type="button" class="iv-chip red" data-c="due"${due.length ? '' : ' disabled'}><b>${fi(sumQ(due))} u</b> ETA đã đến hạn, vẫn incoming <span>${due.length} lô · ${sk(due)} SKU${due.length ? ' · quá tối đa ' + Math.max(...due.map(l => l.overdue)) + ' ngày' : ''}</span></button>` +
    `<button type="button" class="iv-chip amber" data-c="noeta"${noEta.length ? '' : ' disabled'}><b>${fi(sumQ(noEta))} u</b> Chưa có ETA <span>${noEta.length} lô · ${sk(noEta)} SKU</span></button>` +
    `<span class="iv-chip plain"><b>${fi(sumQ(lines.filter(l => typeof l.bucket === 'number' && l.bucket < 4)))} u</b> về trong 4 tuần tới <span>tuần ${md(W[0])} → ${md(addD(W[3], 6))}</span></span>`;
  document.querySelectorAll('#ivSpecial button[data-c]').forEach(b => b.onclick = () => openLots({kind: 'week', cat: b.dataset.c, group: null, mode: IV.mode}));
  document.getElementById('ivWeeklyHint').innerHTML = `Chia màu theo <b>${MODE_VI[mode]}</b>${mode !== 'stage' && S.top && S.keys.includes(OTHER) ? ` (top ${S.top.size}, còn lại gộp vào “Khác”)` : ''}. ` +
    `Lọc Main PL → tự chuyển sang SKU; lọc sales person → theo Main PL. Hai cột đầu (nền vàng, sọc) là lô không xếp được vào tuần: ETA đã qua mà chưa về, và chưa có ETA. Bấm cột để xem lô.`;
}

// ---------------------------------------------------------------- 2) Theo dõi theo SKU
// Cell colour scales (light tints, text stays dark; the number is always shown):
//   MOC <năm> / MOC 3M     đỏ (<1 tháng, nguy cơ OOS) → vàng (1) → xanh (2–4, khỏe) → cam (≥8, tồn cao)
//   SALABLE AMZ+Y4A        tháng tồn so với AMS 3M: đỏ (0) → vàng (1) → xanh (≥2)
//   Incoming 4W            tháng bán mà lô 4 tuần tới bù được (÷ AMS 3M): đỏ (0) → vàng (0.5) → xanh (≥1);
//                          không tô khi tồn hiện tại đã đủ ≥ 2 tháng (không về cũng không sao)
// SKU không có AMS 3M: không tô.
const HEAT = {red: [244, 199, 195], yel: [251, 236, 186], grn: [204, 235, 214], org: [250, 214, 178]};
const SC_MOC = [[0, HEAT.red], [1, HEAT.yel], [2, HEAT.grn], [4, HEAT.grn], [8, HEAT.org]];
const SC_STOCK = [[0, HEAT.red], [1, HEAT.yel], [2, HEAT.grn]];
const SC_INC = [[0, HEAT.red], [0.5, HEAT.yel], [1, HEAT.grn]];
function heat(v, stops){
  if(v == null || !isFinite(v)) return '';
  let c = stops[stops.length - 1][1];
  if(v <= stops[0][0]) c = stops[0][1];
  else for(let i = 1; i < stops.length; i++) if(v <= stops[i][0]){ const [x0, a] = stops[i - 1], [x1, b] = stops[i], t = (v - x0) / (x1 - x0); c = a.map((ch, k) => Math.round(ch + (b[k] - ch) * t)); break; }
  return ` style="background:rgb(${c.join(',')})"`;
}
const HEAT_LEGEND = `<span class="iv-heat"><i style="background:rgb(${HEAT.red})"></i>thiếu<i style="background:rgb(${HEAT.yel})"></i>sát ngưỡng<i style="background:rgb(${HEAT.grn})"></i>khỏe<i style="background:rgb(${HEAT.org})"></i>tồn cao</span>`;
function paintTable(rows){
  const h = H(), DD = IV.daily, yr = DD ? DD.year : (IV.logDate || iso(new Date())).slice(0, 4);
  document.querySelectorAll('#ivTable .iv-yr').forEach(s => s.textContent = yr);
  // Incoming 4W: lots not yet due, ETA in the current week + the 3 next (Sunday start), per the selected warehouse
  rows.forEach(r => { const L = r.lines.filter(l => srcOk(l) && typeof l.bucket === 'number' && l.bucket < 4); r.inc4 = sumQ(L); r.inc4L = L; });
  const val = (r, k) => r[k];
  const tr = [...rows].sort((a, b) => { const va = val(a, IV.sort), vb = val(b, IV.sort); const c = typeof va === 'string' || typeof vb === 'string' ? String(va ?? '').localeCompare(String(vb ?? '')) : (va ?? -1e18) - (vb ?? -1e18); return IV.dir * c || a.sku.localeCompare(b.sku); });
  IV.sorted = tr;
  const amsTip = (a, label) => !a ? 'Chưa có số bán theo ngày' : `${label}: ${a.ams == null ? '—' : a.ams.toFixed(1) + ' u/tháng'}\n` +
    `${a.nData} ngày có dữ liệu · ${a.nMissing} ngày thiếu dữ liệu (bỏ qua)\n` +
    (a.note ? a.note : `Median ${a.median.toFixed(2)} u/ngày → ngưỡng OOS ${(a.median * OOS_SHARE).toFixed(2)} · loại ${a.nOos} ngày nghi OOS · còn ${a.nValid} ngày hợp lệ`) + '\n\n' + INV.AMS_RULE;
  const amsCell = (a, label) => `<td class="num" title="${h.esc(amsTip(a, label))}">${a && a.ams != null ? a.ams.toFixed(1) : '—'}${a && a.note === 'Không đủ baseline để xác định OOS' ? '<span class="vs">không đủ baseline</span>' : a && a.nOos ? `<span class="vs">loại ${a.nOos} ngày OOS</span>` : ''}</td>`;
  const mocCell = (m, a) => `<td class="num"${heat(m, SC_MOC)} title="${m == null ? (a && a.ams === 0 ? 'AMS = 0' : 'Thiếu dữ liệu') : 'SALABLE AMZ+Y4A ÷ AMS · đỏ &lt; 1 tháng · xanh 2–4 tháng · cam ≥ 8 tháng (tồn cao)'}">${m == null ? '—' : f1(m)}</td>`;
  const stockHeat = r => r.ams3 > 0 ? heat(r.tot / r.ams3, SC_STOCK) : '';
  const incHeat = r => !(r.ams3 > 0) || (r.moc3 != null && r.moc3 >= 2) ? '' : heat(r.inc4 / r.ams3, SC_INC);
  const incTitle = r => (r.ams3 > 0 ? `Bù được ${(r.inc4 / r.ams3).toFixed(1)} tháng bán (÷ AMS 3M)` + (r.moc3 != null && r.moc3 >= 2 ? ' · tồn hiện tại đã đủ ≥ 2 tháng nên không tô màu' : '') + '\n' : '') + incTip(r.inc4L);
  const incTip = L => L.map(l => `${l.source} ${fi(l.qty)} u · ETA ${md(l.eta_salable_date)}${l.etaUse && l.etaUse !== l.eta_salable_date ? ' (dùng ' + md(l.etaUse) + ')' : ''} · ${l.po_name}${l.container_number ? ' · ' + l.container_number : ''}`).join('\n');
  document.getElementById('ivTableHint').innerHTML = `SALABLE = tồn sellable on-hand (AMZ: Amazon sellable on-hand theo ASIN). Incoming 4W = lô chưa đến hạn có ETA trong tuần ${md(IV.weeks[0])} → ${md(addD(IV.weeks[3], 6))}${IV.src ? ' · chỉ kho ' + IV.src : ''}. ` +
    (DD ? `AMS ${yr}: ${md(IV.per.ytd.from)} → ${md(DD.maxDate)} · AMS 3M: ${md(IV.per.m3.from)} → ${md(DD.maxDate)} (90 ngày) · MTD: ${md(IV.per.mStart)} → ${md(DD.maxDate)}. Rê chuột vào tiêu đề AMS / MOC để xem rule, vào ô để xem số ngày bị loại. ` : '<b>Chưa tải được số bán theo ngày: AMS / MOC / MTD để trống.</b> ') +
    'Bấm một dòng để xem chart theo SKU.<br>Màu ô (so với AMS 3M của chính SKU): ' + HEAT_LEGEND + ' · SALABLE và MOC = số tháng tồn, Incoming 4W = số tháng bán mà lô 4 tuần tới bù được.';
  document.getElementById('ivBody').innerHTML = tr.slice(0, 600).map(r => `<tr class="main${IV.sel === r.sku ? ' sel' : ''}" data-sku="${h.esc(r.sku)}" style="cursor:pointer">
      <td>${h.esc(r.pic)}</td><td>${h.esc(r.pl)}${r.subPl && r.subPl !== 'Unclassified' ? `<span class="vs">${h.esc(r.subPl)}</span>` : ''}</td>
      <td>${link(r.sku)}<span class="vs" title="${h.esc(r.name)}">${h.esc(r.name.slice(0, 34))}</span></td>
      <td class="num"${stockHeat(r)} title="${r.ams3 > 0 ? 'Đủ bán ' + (r.tot / r.ams3).toFixed(1) + ' tháng theo AMS 3M · đỏ ≈ 0 · xanh ≥ 2 tháng' : 'Chưa có AMS 3M: không tô màu'}"><b>${fi(r.tot)}</b></td><td class="num">${fi(r.y4a)}</td>
      <td class="num${r.amz <= 0 ? ' iv-zero' : ''}"${r.amzSrc === 'file' ? ' title="SKU không có dòng ASIN trong 04_AMZ_sellable details: dùng tồn AMZ của 06_ USA_Sellable INV"' : ''}>${fi(r.amz)}${r.amzSrc === 'file' ? '<span class="vs">file 06</span>' : ''}</td>
      <td class="num"${incHeat(r)} title="${h.esc(incTitle(r))}">${r.inc4 ? fi(r.inc4) : '—'}</td>
      ${mocCell(r.moc26, r.a26)}${amsCell(r.a26, 'AMS ' + yr)}${mocCell(r.moc3, r.a3)}${amsCell(r.a3, 'AMS 3M')}
      <td class="num">${r.mtd == null ? '—' : fi(r.mtd)}</td>
      <td class="iv-flag" title="${h.esc(r.why.join(' · '))}">${r.flags.length ? r.flags.map(f => `<span class="badge ${f.c}">${h.esc(f.t)}</span>`).join('') : '<span class="badge green">OK</span>'}</td></tr>`).join('')
    || '<tr><td colspan="13" style="padding:18px;color:var(--muted)">Không có SKU nào khớp bộ lọc' + (IV.data.inc.length ? '' : ' (chưa có dữ liệu: chờ flow tự động mỗi giờ)') + '.</td></tr>';
  document.querySelectorAll('#ivBody tr[data-sku]').forEach(t => t.onclick = () => { IV.sel = t.dataset.sku; document.querySelectorAll('#ivBody tr.sel').forEach(x => x.classList.remove('sel')); t.classList.add('sel'); detail(); document.getElementById('ivDetail').scrollIntoView({behavior: 'smooth', block: 'start'}); });
  document.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.setAttribute('aria-sort', th.dataset.k === IV.sort ? (IV.dir > 0 ? 'ascending' : 'descending') : 'none'));
}

// ---------------------------------------------------------------- 3) Incoming PO
const PO_ST = ['Đúng hạn', 'Trễ so với ETA ban đầu', 'Quá ETA, chưa về', 'Chưa có ETA', 'Khác'];
const poStatus = l => l.noEta ? 'Chưa có ETA' : STATUS_VI[l.on_time_status] || 'Khác';
function paintPo(lines){
  const h = H(), cats = PO_ST.filter(s => lines.some(l => poStatus(l) === s));
  const tr = ['AMZ', 'Y4A'].filter(s => !IV.src || s === IV.src).map(src => ({type: 'bar', orientation: 'h', name: src === 'AMZ' ? 'Về kho Amazon' : 'Về kho Y4A', y: cats, marker: {color: src === 'AMZ' ? C.amz : C.y4a, line: {color: '#fff', width: 1}},
    x: cats.map(c => sumQ(lines.filter(l => l.source === src && poStatus(l) === c))), customdata: cats.map(c => [c, src]),
    hovertemplate: '%{y} · ' + src + ': %{x:,.0f} u<extra>bấm để xem lô</extra>'}));
  if(!cats.length){ document.getElementById('ivPoStatus').innerHTML = '<div class="hint" style="padding:20px">Không có hàng đang về trong phạm vi đang lọc.</div>'; }
  else h.draw('ivPoStatus', tr, h.lay({barmode: 'stack', hovermode: 'closest', margin: {l: 160, r: 40, t: 6, b: 30}, legend: {orientation: 'h', y: -0.18, x: 0, font: {size: 10.5}, traceorder: 'normal'},
    yaxis: h.ax({type: 'category', categoryorder: 'array', categoryarray: [...cats].reverse(), automargin: false}), xaxis: h.ax({tickformat: ',.0f'})}));
  const g = document.getElementById('ivPoStatus');
  if(cats.length) onClick(g, p => openLots({kind: 'status', status: p.customdata[0], src: p.customdata[1]}));
  renderLots(lines);
}
// Danh sách lô: always the lots in scope, with its own filters. A click on the charts / chips above
// sets these filters (week + series, or PO status + warehouse), so the list shows exactly those lots.
const LF0 = () => ({q: '', wk: '', status: '', stage: '', src: '', group: null, owk: '', sku: ''});
function openLots(sel){
  const f = LF0();
  if(sel.kind === 'status'){ f.status = sel.status; f.src = sel.src || ''; }
  else if(sel.kind === 'orig') f.owk = String(sel.cat);
  else { f.wk = String(sel.cat); if(sel.group != null) f.group = {mode: sel.mode, key: sel.group}; }
  IV.lf = f; syncLotBar(); renderLots();
  const el = document.getElementById('ivLots'); if(el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
}
function lotFilter(lines){
  const f = IV.lf || LF0(), q = f.q.trim().toLowerCase();
  const wk = f.wk === '' ? null : /^\d+$/.test(f.wk) ? +f.wk : f.wk;
  let inGroup = () => true;
  if(f.group){
    const {mode, key} = f.group;
    if(key === OTHER && mode !== 'stage'){ const S = seriesOf(scopeLines(), mode); inGroup = l => !S.top.has(groupOf(l, mode)); }
    else inGroup = l => groupOf(l, mode) === key;
  }
  const owk = !f.owk ? null : /^\d+$/.test(f.owk) ? +f.owk : f.owk;
  return lines.filter(l => (wk === null || l.bucket === wk) && (owk === null || l.obucket === owk) && (!f.sku || l.sku === f.sku) && (!f.status || poStatus(l) === f.status) && (!f.stage || l.stage === f.stage) &&
    (!f.src || l.source === f.src) && inGroup(l) && (!q || [l.po_name, l.sku, l.container_number, l.pl, l.pic].join(' ').toLowerCase().includes(q)));
}
// put the current lot filters into the controls (week options follow the weeks of the chart)
function syncLotBar(){
  const h = H(), f = IV.lf || LF0(), $ = id => document.getElementById(id); if(!$('ivLwk')) return;
  const {cats, plain} = weekCats();
  $('ivLwk').innerHTML = '<option value="">Tất cả</option>' + cats.map(c => `<option value="${c}"${String(c) === f.wk ? ' selected' : ''}>${h.esc(plain(c))}</option>`).join('');
  $('ivLq').value = f.q; $('ivLst').value = f.status; $('ivLstage').value = f.stage; $('ivLsrc').value = f.src;
  $('ivLgrp').innerHTML = (f.sku ? `<button type="button" class="iv-chip plain iv-grp" data-x="sku" title="Bỏ lọc SKU">SKU: <b>${h.esc(f.sku)}</b> ✕</button>` : '') + (f.group ? `<button type="button" class="iv-chip plain iv-grp" data-x="group" title="Bỏ lọc nhóm này">${h.esc(MODE_VI[f.group.mode])}: <b>${h.esc(f.group.key)}</b> ✕</button>` : '') +
    (f.owk ? `<button type="button" class="iv-chip plain iv-grp" data-x="owk" title="Bỏ lọc này">ETA ban đầu: <b>${h.esc(f.owk === 'due' ? 'đã qua' : f.owk === 'after' ? bucketShort('after') : bucketShort(f.owk))}</b> ✕</button>` : '');
  $('ivLgrp').querySelectorAll('button').forEach(g => g.onclick = () => { if(g.dataset.x === 'group') IV.lf.group = null; else if(g.dataset.x === 'sku') IV.lf.sku = ''; else IV.lf.owk = ''; syncLotBar(); renderLots(); });
  $('ivLwide').checked = !!IV.lotWide;
}
function bindLotBar(host){
  const $ = s => host.querySelector(s), set = (k, v) => { IV.lf = IV.lf || LF0(); IV.lf[k] = v; renderLots(); };
  $('#ivLq').oninput = e => set('q', e.target.value);
  $('#ivLwk').onchange = e => set('wk', e.target.value);
  $('#ivLst').onchange = e => set('status', e.target.value);
  $('#ivLstage').onchange = e => set('stage', e.target.value);
  $('#ivLsrc').onchange = e => set('src', e.target.value);
  $('#ivLreset').onclick = () => { IV.lf = LF0(); syncLotBar(); renderLots(); };
  $('#ivLwide').onchange = e => { IV.lotWide = e.target.checked; renderLots(); };
}
function renderLots(lines){
  const h = H(), host = document.getElementById('ivLtable'); if(!host || !IV.lines) return;
  if(!document.getElementById('ivLwk').options.length) syncLotBar();
  lines = lines || scopeLines();
  const L = lotFilter(lines), f = IV.lf || LF0();
  const on = !!(f.q || f.wk !== '' || f.status || f.stage || f.src || f.group || f.owk || f.sku), wide = !!IV.lotWide;
  L.sort((a, b) => (b.overdue - a.overdue) || String(a.eta_salable_date || '9999').localeCompare(String(b.eta_salable_date || '9999')) || a.sku.localeCompare(b.sku));
  const badge = l => `<span class="badge ${l.on_time_status === 'delay vs current' ? 'red' : l.on_time_status === 'delay vs expected' ? 'amber' : l.on_time_status === 'normal' ? 'green' : 'gray'}">${h.esc(STATUS_VI[l.on_time_status] || l.on_time_status || '—')}</span>${l.due ? `<span class="vs">quá ${l.overdue} ngày</span>` : ''}`;
  const sgn = v => v == null ? '—' : v > 0 ? `<b style="color:var(--red)">+${v}</b>` : v < 0 ? `<b style="color:var(--green)">${v}</b>` : '0';
  document.getElementById('ivLsum').innerHTML = `<b>${L.length}</b> lô · <b>${fi(sumQ(L))}</b> u${on ? ` <span style="color:var(--muted)">(đang lọc, trên tổng ${lines.length} lô)</span>` : ` <span style="color:var(--muted)">· tất cả lô trong phạm vi bộ lọc trang</span>`}`;
  const J = wide ? '<th>Ngày đặt</th><th>Ship dự kiến</th><th>Ship thực tế</th><th title="ATA cảng nếu đã tới, không thì ETA cảng">ETA cảng</th>' : '';
  const shown = L.slice(0, 500);
  host.innerHTML = `<div class="tablewrap" style="max-height:460px"><table id="ivLotTable"><thead><tr><th>PO</th><th>SKU</th><th>Container</th><th>Kho đến</th><th class="num">Qty</th><th>Stage</th>${J}
      <th>Original ETA</th><th>Current ETA</th><th class="num" title="Current ETA − Original ETA">Delay Days</th><th title="on_time_status trong tracker">Delay Status</th>${wide ? '<th title="Các lần ETA thay đổi qua các lần cập nhật tracker (ngày cập nhật trong ngoặc)">Lịch sử ETA</th>' : ''}</tr></thead>
    <tbody>${shown.map((l, i) => `<tr data-sku="${h.esc(l.sku)}" style="cursor:pointer"><td>${h.esc(l.po_name)}</td><td>${link(l.sku)}<span class="vs">${h.esc(l.pic)} · ${h.esc(l.pl)}</span></td><td>${h.esc(l.container_number || '—')}</td>
      <td>${l.source === 'AMZ' ? 'Amazon' : 'Y4A'}${l.channel ? ' · ' + h.esc(l.channel) : ''}</td><td class="num">${fi(l.qty)}</td><td>${h.esc(l.physical_status || '—')}</td>
      ${wide ? `<td>${mdy(l.ordered_date)}</td><td>${mdy(l.expected_ship_date)}</td><td>${mdy(l.actual_ship_date)}</td><td>${mdy(l.ata_pod || l.eta_pod)}${l.ata_pod ? '<span class="vs">đã tới cảng</span>' : ''}</td>` : ''}
      <td>${l.eta_salable_original ? mdy(l.eta_salable_original) : l.eta_salable_date ? mdy(l.eta_salable_date) + '<span class="vs">tracker trống: coi = Current</span>' : '—'}</td><td><b>${mdy(l.eta_salable_date)}</b></td><td class="num">${sgn(l.slip)}</td><td>${badge(l)}</td>${wide ? `<td class="iv-hist" data-i="${i}">…</td>` : ''}</tr>`).join('') || `<tr><td colspan="${wide ? 15 : 10}" style="color:var(--muted)">Không có lô nào khớp bộ lọc.</td></tr>`}</tbody></table></div>
    ${L.length > 500 ? '<div class="hint">Hiện 500 lô đầu; lọc thêm hoặc Export Excel để xem đủ.</div>' : ''}`;
  host.querySelectorAll('tbody tr[data-sku]').forEach(t => t.onclick = () => { IV.sel = t.dataset.sku; detail(); document.getElementById('ivDetail').scrollIntoView({behavior: 'smooth', block: 'start'}); });
  if(wide) fillHistory(host, shown);
}
// Lịch sử ETA (incoming_eta_log, one row per lot per tracker load), fetched per SKU and cached
async function fillHistory(host, shown){
  const h = H(), tok = IV.histTok = (IV.histTok || 0) + 1; IV.hist = IV.hist || new Map();
  const need = [...new Set(shown.map(l => l.sku))].filter(s => !IV.hist.has(s));
  try {
    for(let i = 0; i < need.length; i += 80){
      const part = need.slice(i, i + 80), rows = await h.selectAll('incoming_eta_log', q => q.eq('country', IV.country).in('sku', part).order('log_date'));
      part.forEach(s => IV.hist.set(s, []));
      rows.forEach(x => IV.hist.get(x.sku).push(x));
    }
  } catch(e){ console.warn('incoming_eta_log', e); if(tok === IV.histTok) host.querySelectorAll('td.iv-hist').forEach(td => td.textContent = '—'); return; }
  if(tok !== IV.histTok) return;
  host.querySelectorAll('td.iv-hist').forEach(td => {
    const l = shown[+td.dataset.i]; if(!l) return;
    const hs = (IV.hist.get(l.sku) || []).filter(x => x.source === l.source && x.po_name === l.po_name && (x.container_number || '') === (l.container_number || ''));
    const seq = []; hs.forEach(x => { if(!seq.length || seq[seq.length - 1].eta !== x.eta_salable_date) seq.push({at: x.log_date, eta: x.eta_salable_date}); });
    td.innerHTML = seq.length > 1 ? seq.map(s => `${md(s.eta)}<span style="color:var(--muted);font-size:10px"> (${md(s.at)})</span>`).join(' → ') : hs.length ? `<span style="color:var(--muted)">chưa đổi (${hs.length} lần cập nhật)</span>` : '—';
  });
}

// ---------------------------------------------------------------- Tổng hợp theo PIC (every filter except PIC, so a click can switch PIC)
function paintPic(){
  const h = H();
  const base = IV.rows.filter(r => inScope(r, 'pic'));
  const byPic = new Map();
  base.forEach(r => { const a = byPic.get(r.pic) || {pic: r.pic, n: 0, amz: 0, y4a: 0, fc: 0, incA: 0, incY: 0, dl: 0, od: 0, o2: 0, o8: 0, lost: 0, high: 0};
    a.n++; a.amz += r.amz; a.y4a += r.y4a; a.fc += r.fc4 || 0; a.incA += r.incAmzTot; a.incY += r.incY4aTot; a.dl += r.delayQty; a.od += r.overdueQty;
    if(r.risk === 'OOS ≤2 tuần') a.o2++; if(r.risk === 'OOS trong 8 tuần') a.o8++; if(r.oosWk !== null && r.oosWk < 8) a.lost += r.lost; if(r.wocT > 26) a.high++;
    byPic.set(r.pic, a); });
  const pics = [...byPic.values()].sort((a, b) => (b.o2 * 1e6 + b.o8 * 1e3 + b.od) - (a.o2 * 1e6 + a.o8 * 1e3 + a.od) || a.pic.localeCompare(b.pic));
  const red = v => v ? `<b style="color:var(--red)">${fi(v)}</b>` : '—';
  document.getElementById('ivPicBody').innerHTML = pics.map(a => `<tr data-pic="${h.esc(a.pic)}" style="cursor:pointer"${IV.pic === a.pic ? ' class="sel"' : ''}>
      <td><b>${h.esc(a.pic)}</b></td><td class="num">${a.n}</td><td class="num">${fi(a.amz)}</td><td class="num">${fi(a.y4a)}</td><td class="num">${a.fc ? a.fc.toFixed(0) : '—'}</td>
      <td class="num">${a.fc ? (a.amz / a.fc).toFixed(1) : '—'}</td><td class="num">${fi(a.incA)}</td><td class="num">${fi(a.incY)}</td><td class="num">${a.dl ? fi(a.dl) : '—'}</td>
      <td class="num">${red(a.od)}</td><td class="num">${red(a.o2)}</td><td class="num">${a.o8 ? `<b style="color:var(--amber)">${a.o8}</b>` : '—'}</td>
      <td class="num">${a.lost ? fi(a.lost) : '—'}</td><td class="num">${a.high || '—'}</td></tr>`).join('')
    || '<tr><td colspan="14" style="padding:14px;color:var(--muted)">Chưa có dữ liệu.</td></tr>';
  document.querySelectorAll('#ivPicBody tr[data-pic]').forEach(t => t.onclick = () => setPic(IV.pic === t.dataset.pic ? '' : t.dataset.pic));
}

// ---------------------------------------------------------------- 4) Phân tích hàng trễ (collapsed by default)
function paintLate(lines){
  const h = H(); if(!IV.data) return;
  lines = lines || scopeLines();
  const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
  const lay = x => h.lay(Object.assign({margin: {l: 52, r: 12, t: 6, b: 50}, barmode: 'stack', hovermode: 'x unified', legend: {orientation: 'h', y: -0.22, x: 0, font: {size: 10.5}}}, x));
  const byPl = new Map(); lines.forEach(l => { if(l.on_time_status !== 'delay vs expected' && l.on_time_status !== 'delay vs current') return; const a = byPl.get(l.pl) || {d: 0, o: 0, po: new Set(), slip: 0}; if(l.on_time_status === 'delay vs current') a.o += l.qty; else a.d += l.qty; a.po.add(l.sku); a.slip = Math.max(a.slip, l.slip || 0, l.overdue); byPl.set(l.pl, a); });
  const pl = [...byPl.entries()].sort((a, b) => (a[1].d + a[1].o) - (b[1].d + b[1].o)).slice(-12);
  const mx = Math.max(1, ...pl.map(p => p[1].d + p[1].o)), lbl = v => v >= mx * 0.07 ? fi(v) : '';
  const tot = pl.map(p => p[1].d + p[1].o);
  if(pl.length) h.draw('ivPlDelay', [
    {type: 'bar', orientation: 'h', y: pl.map(p => p[0]), x: pl.map(p => p[1].d), name: 'ETA lùi', marker: {color: C.warn, line: {color: '#fff', width: 1}}, text: pl.map(p => lbl(p[1].d)), textposition: 'inside', insidetextanchor: 'middle', textfont: {size: 10},
      customdata: pl.map(p => [p[1].po.size, p[1].slip, p[1].o]), hovertemplate: '<b>%{y}</b><br>ETA lùi: %{x:,.0f} u<br>Quá ETA: %{customdata[2]:,.0f} u<br>%{customdata[0]} SKU · trễ tối đa %{customdata[1]} ngày<extra></extra>'},
    {type: 'bar', orientation: 'h', y: pl.map(p => p[0]), x: pl.map(p => p[1].o), name: 'Quá ETA', marker: {color: C.amzO, line: {color: '#fff', width: 1}}, text: pl.map(p => lbl(p[1].o)), textposition: 'inside', insidetextanchor: 'middle', textfont: {size: 10},
      customdata: pl.map(p => [p[1].po.size, p[1].slip, p[1].d]), hovertemplate: '<b>%{y}</b><br>Quá ETA: %{x:,.0f} u<br>ETA lùi: %{customdata[2]:,.0f} u<br>%{customdata[0]} SKU · trễ tối đa %{customdata[1]} ngày<extra></extra>'},
    {type: 'scatter', mode: 'text', y: pl.map(p => p[0]), x: tot, text: tot.map(v => '  ' + fi(v)), textposition: 'middle right', textfont: {size: 10, color: '#1B2733'}, hoverinfo: 'skip', showlegend: false, cliponaxis: false},
  ], lay({margin: {l: 160, r: 50, t: 6, b: 40}, hovermode: 'closest', bargap: .3, legend: {orientation: 'h', y: -0.12, x: 0, font: {size: 10.5}, traceorder: 'normal'},
    yaxis: h.ax({automargin: false, tickfont: {size: 10.5}}), xaxis: h.ax({tickformat: ',.0f'})}));
  else document.getElementById('ivPlDelay').innerHTML = '<div class="hint" style="padding:20px">Không có hàng trễ trong phạm vi đang lọc.</div>';
  const bins = [[-999, 0, '≤0'], [1, 7, '1–7'], [8, 14, '8–14'], [15, 30, '15–30'], [31, 60, '31–60'], [61, 9999, '>60']];
  const wS = lines.filter(l => l.slip != null);
  h.draw('ivSlip', ['AMZ', 'Y4A'].filter(s => !IV.src || s === IV.src).map(src => ({type: 'bar', name: src === 'AMZ' ? 'Về kho Amazon' : 'Về kho Y4A', x: bins.map(b => b[2] + ' ngày'), marker: {color: src === 'AMZ' ? C.amz : C.y4a},
    y: bins.map(b => sum(wS.filter(l => l.source === src && l.slip >= b[0] && l.slip <= b[1]), l => l.qty)), hovertemplate: '%{x}: %{y:,.0f} u<extra></extra>'})), lay({barmode: 'group', yaxis: h.ax({tickformat: ',.0f'})}));
  setTimeout(() => ['ivPlDelay', 'ivSlip'].forEach(id => { const g = document.getElementById(id); try { if(g && g._fullLayout) Plotly.Plots.resize(g); } catch(_){ } }), 30);
}

// ---------------------------------------------------------------- one SKU: weekly projection, Vendor Central metrics; its lots live in the Danh sách lô
function detail(){
  const h = H(), host = document.getElementById('ivDetail'), r = IV.rows.find(x => x.sku === IV.sel);
  if(!r){ host.innerHTML = '<h3 style="margin:0">Chart theo SKU</h3><div class="hint" style="margin-top:8px">Không có SKU nào khớp bộ lọc.</div>'; return; }
  const W = IV.weeks, wl = W.map(md);
  host.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:end;gap:10px;flex-wrap:wrap"><h3 style="margin:0">Chart theo SKU · ${link(r.sku)} · ${h.esc(r.name)}</h3>
      <div class="fld"><label for="ivSkuPick" style="font-size:10.5px;font-weight:800;color:var(--muted);display:block">Chọn SKU</label><select id="ivSkuPick">${filtered().slice().sort((a, b) => a.sku.localeCompare(b.sku)).map(x => `<option value="${h.esc(x.sku)}"${x.sku === r.sku ? ' selected' : ''}>${h.esc(x.sku)} · ${h.esc(x.name.slice(0, 40))}</option>`).join('')}</select></div></div>
    <div class="hint">Tồn AMZ <b>${fi(r.amz)}</b> · tồn Y4A <b>${fi(r.y4a)}</b> · AMS 3M <b>${r.ams3 == null ? '—' : r.ams3.toFixed(1)}</b> · MOC 3M <b>${f1(r.moc3)}</b> · ${h.esc(r.pl)}${r.pic ? ' · PIC ' + h.esc(r.pic) : ''} · ${r.f ? `Forecast: ${h.esc(r.model)}${r.acc != null ? ', chính xác backtest ' + (r.acc * 100).toFixed(0) + '%' : ''} (so sánh: ${Object.entries(r.f.scores).sort((a, b) => a[1] - b[1]).map(([m, s]) => m + ' ' + Math.max(0, (1 - s) * 100).toFixed(0) + '%').join(', ')})` : 'Chưa có số bán để forecast'}
    ${r.why.length ? '<br>Gợi ý: ' + r.why.map(w => h.esc(w)).join(' · ') : ''}
    ${r.asins.length ? '<br>Vendor Central: ' + r.asins.map(a => `${h.esc(a.asin)} — on hand ${fi(a.sellable_on_hand_units)}, in transit ${fi(a.sellable_in_transit_units)}, open PO ${fi(a.open_po_units)}, aged 90+ ${fi(a.aged_90_units)}, confirm ${a.vendor_confirmation_rate == null ? '—' : (a.vendor_confirmation_rate * 100).toFixed(0) + '%'}, fill ${a.receive_fill_rate == null ? '—' : (a.receive_fill_rate * 100).toFixed(0) + '%'}, OOS ${a.procurable_oos_rate == null ? '—' : (a.procurable_oos_rate * 100).toFixed(1) + '%'}`).join('<br>') : ''}</div>
    <div id="ivDPlot" class="plot" style="height:340px"></div>
    <div class="iv-dlots">${r.lines.length ? `<b>${r.lines.length}</b> lô đang về · ${fi(sumQ(r.lines))} u${r.lines.some(l => l.due) ? ` · <b style="color:var(--red)">${r.lines.filter(l => l.due).length} lô đã đến hạn, vẫn incoming</b>` : ''}${r.lines.some(l => l.noEta) ? ` · <b style="color:var(--amber)">${r.lines.filter(l => l.noEta).length} lô chưa có ETA</b>` : ''}
      <button type="button" class="btn small" id="ivDLots">Xem các lô này trong Danh sách lô (kèm hành trình, lịch sử ETA) ↓</button>` : 'SKU này không có hàng đang về.'}</div>`;
  host.querySelector('#ivSkuPick').onchange = e => { IV.sel = e.target.value; document.querySelectorAll('#ivBody tr').forEach(t => t.classList.toggle('sel', t.dataset.sku === IV.sel)); detail(); };
  const dl = host.querySelector('#ivDLots'); if(dl) dl.onclick = () => { IV.lf = {...LF0(), sku: r.sku}; IV.lotWide = true; syncLotBar(); renderLots(); document.getElementById('ivLots').scrollIntoView({behavior: 'smooth', block: 'start'}); };
  // chart: history (last 16 weeks actual) + projection
  const S = IV.sales, histW = S && r.hist ? S.weeks.slice(-16) : [], histY = r.hist ? r.hist.slice(-16) : [];
  const traces = [];
  if(histW.length) traces.push({type: 'scatter', mode: 'lines', x: histW.map(md), y: histY, name: 'Bán thực tế / tuần', line: {color: C.act, width: 2}});
  if(r.fcW) traces.push({type: 'scatter', mode: 'lines', x: wl, y: r.fcW, name: 'Forecast / tuần', line: {color: C.fc, width: 2, dash: 'dot'}});
  traces.push({type: 'bar', x: wl, y: r.incA, name: 'Hàng về Amazon', marker: {color: C.amz}, opacity: .8});
  traces.push({type: 'bar', x: wl, y: r.incY, name: 'Hàng về Y4A', marker: {color: C.y4a}, opacity: .8});
  if(r.fcW){
    traces.push({type: 'scatter', mode: 'lines', x: wl, y: r.pA.p, name: 'Tồn AMZ cuối tuần (dự phóng)', line: {color: C.stock, width: 3}, yaxis: 'y'});
    traces.push({type: 'scatter', mode: 'lines', x: wl, y: r.pT.p, name: 'Tồn AMZ + Y4A (dự phóng)', line: {color: C.stock, width: 1.5, dash: 'dash'}});
  }
  h.draw('ivDPlot', traces, h.lay({barmode: 'stack', hovermode: 'x unified', margin: {l: 52, r: 12, t: 6, b: 50}, xaxis: h.ax({type: 'category', categoryorder: 'array', categoryarray: [...histW.map(md), ...wl.filter(x => !histW.map(md).includes(x))]}), yaxis: h.ax({tickformat: ',.0f'}),
    shapes: r.oosWk !== null ? [{type: 'line', x0: wl[r.oosWk], x1: wl[r.oosWk], yref: 'paper', y0: 0, y1: 1, line: {color: '#D64545', width: 1.5, dash: 'dot'}}] : []}));
}

// ---------------------------------------------------------------- export + AI
function exportXlsx(){
  if(typeof XLSX === 'undefined') return;
  const rows = filtered(), wb = XLSX.utils.book_new(), yr = IV.daily ? IV.daily.year : (IV.logDate || iso(new Date())).slice(0, 4);
  rows.forEach(r => { if(r.inc4 == null) r.inc4 = sumQ(r.lines.filter(l => srcOk(l) && typeof l.bucket === 'number' && l.bucket < 4)); });
  const n1 = v => v == null || !isFinite(v) ? '' : +v.toFixed(1);
  const a = rows.map(r => ({'PIC': r.pic, 'Main PL': r.pl, 'Sub PL': r.subPl, 'SKU': r.sku, 'Product': r.name, 'Lifecycle': r.lifecycle,
    'SALABLE AMZ+Y4A': r.tot, 'SALABLE Y4A': r.y4a, 'SALABLE AMZ (on-hand)': r.amz, 'SALABLE AMZ source': r.amzSrc === 'asin' ? '04_AMZ_sellable details' : '06_USA_Sellable INV',
    'Incoming 4W': r.inc4, ['MOC ' + yr]: n1(r.moc26), ['AMS ' + yr]: n1(r.ams26), 'MOC 3M': n1(r.moc3), 'AMS 3M': n1(r.ams3), 'MTD Sale': r.mtd == null ? '' : r.mtd,
    ['AMS ' + yr + ' note']: r.a26 ? r.a26.note || `loại ${r.a26.nOos} ngày nghi OOS / ${r.a26.nData} ngày có dữ liệu` : '', 'AMS 3M note': r.a3 ? r.a3.note || `loại ${r.a3.nOos} ngày nghi OOS / ${r.a3.nData} ngày có dữ liệu` : '',
    'Flag': r.flags.map(f => f.t).join(' · '),
    'Sales / week (4w)': n1(r.act4), 'Forecast / week (4w)': n1(r.fc4), 'Model': r.model, 'Backtest accuracy': r.acc == null ? '' : +r.acc.toFixed(3),
    'WOC AMZ': n1(r.woc), 'WOC total': n1(r.wocT), 'OOS week (AMZ)': r.oosWk === null ? '' : IV.weeks[r.oosWk], 'Lost units (16w)': Math.round(r.lost),
    'Incoming AMZ': r.incAmzTot, 'Incoming Y4A': r.incY4aTot, 'Units ETA slipped': r.delayQty, 'Max slip days': r.maxSlip, 'Units past ETA': r.overdueQty, 'Risk': r.risk, 'Suggestion': r.why.join(' · '),
    ...Object.fromEntries(IV.weeks.map((w, i) => ['Proj AMZ ' + w, r.fcW ? Math.round(r.pA.p[i]) : '']))}));
  const b = scopeLines(rows).map(l => ({'Source': l.source, 'Channel / WH': l.channel, 'PIC': l.pic, 'Main PL': l.pl, 'SKU': l.sku, 'ASIN': l.asin, 'PO': l.po_name, 'Container': l.container_number, 'Qty': l.qty,
    'Stage': l.physical_status, 'Delay Status': l.on_time_status, 'Ordered': l.ordered_date, 'Expected ship': l.expected_ship_date, 'Actual ship': l.actual_ship_date, 'ETA POD': l.eta_pod,
    'Original ETA': l.eta_salable_original, 'Current ETA': l.eta_salable_date, 'Delay Days': l.slip, 'ETA due, still incoming': l.due ? 'yes' : '', 'Days past ETA': l.overdue || '',
    'Chart week': typeof l.bucket === 'number' ? IV.weeks[l.bucket] : l.bucket === 'due' ? 'ETA đã đến hạn' : l.bucket === 'noeta' ? 'Chưa có ETA' : 'Sau ' + HZN + ' tuần', 'ETA used (projection)': l.eta}));
  if(a.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(a), 'SKU tracking');
  if(b.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(b), 'Incoming PO lines');
  if(wb.SheetNames.length) XLSX.writeFile(wb, `Yes4All_Inventory_Tracking_${IV.country}_${IV.logDate}.xlsx`);
}
async function askAi(force){
  const h = H(), out = document.getElementById('ivAiOut'), rows = filtered();
  const pick = rows.filter(r => r.riskRank <= 4 || r.risk === 'Tồn cao' || r.flagRank < 40).sort((a, b) => a.flagRank - b.flagRank || a.riskRank - b.riskRank).slice(0, 40);
  const context = {
    market: IV.country, file_date: IV.logDate, sales_through: IV.daily ? IV.daily.maxDate : null, eta_mode: IV.etaMode === 'safe' ? 'ETA + độ trễ trung bình theo trạng thái' : 'ETA trong file',
    definitions: {AMZ: 'hàng về kho Amazon (AVC), không kéo sớm được', Y4A: 'hàng về kho Y4A, có thể request kéo về sớm', 'delay vs expected': 'ETA hiện tại lùi so với ETA ban đầu', 'delay vs current': 'đã quá ETA mà chưa thành sellable',
      ams: 'units/tháng, loại ngày nghi OOS (< 15% median)', moc: 'tháng tồn = SALABLE AMZ+Y4A / AMS', inc_4w: 'lô chưa đến hạn về trong 4 tuần tới', oos_week: 'tuần tồn AMZ dự phóng không đủ forecast'},
    kpis: document.getElementById('ivKpis').innerText.replace(/\n+/g, ' | '),
    skus: pick.map(r => ({sku: r.sku, name: r.name.slice(0, 60), pl: r.pl, pic: r.pic, inv_amz: r.amz, inv_y4a: r.y4a, inc_4w: r.inc4, ams_3m: r.ams3 == null ? null : +r.ams3.toFixed(1), moc_3m: r.moc3 == null ? null : +r.moc3.toFixed(1), mtd: r.mtd,
      fc_wk: r.fc4 == null ? null : +r.fc4.toFixed(1), oos_week: r.oosWk === null ? null : IV.weeks[r.oosWk], lost_units_16w: Math.round(r.lost),
      next_amz: r.nA ? {eta: r.nA.eta, qty: r.nA.qty, status: r.nA.on_time_status} : null, next_y4a: r.nY ? {eta: r.nY.eta, qty: r.nY.qty, container: r.nY.container_number} : null,
      units_slipped: r.delayQty, max_slip_days: r.maxSlip, units_past_eta: r.overdueQty, risk: r.risk, flags: r.flags.map(f => f.t)})),
  };
  const question = `Bạn là chuyên gia supply chain + Amazon Vendor (AVC) của Yes4All. Dựa trên dữ liệu tồn kho, incoming, AMS/MOC và forecast dưới đây (ETA của nhà máy/forwarder thường bị trễ), hãy:
1) Liệt kê tối đa 8 hành động ưu tiên: SKU nào cần kéo hàng Y4A về sớm / đẩy tồn Y4A sang Amazon, PO/lô nào đã đến hạn mà chưa về hoặc chưa có ETA cần follow-up gấp, SKU nào nên giảm ads/promo để giữ tồn, SKU nào tồn cao cần đẩy bán hoặc dời hàng về.
2) Nêu rủi ro trễ hàng theo product line và ước tính units có thể mất.
Trích số cụ thể (SKU, ngày, units). Trả lời tiếng Việt, gạch đầu dòng, ghi mức ưu tiên Cao/Trung bình/Thấp.`;
  out.hidden = false; out.textContent = 'Đang hỏi AI…';
  try {
    let hsh = 0; const t = JSON.stringify(context); for(let i = 0; i < t.length; i++) hsh = (hsh * 31 + t.charCodeAt(i)) | 0;
    const {data, error} = await sb.functions.invoke('ai-recommend', {body: {scope: 'inventory', scope_key: IV.country + ' · ' + IV.logDate + ' #' + (hsh >>> 0).toString(36), as_of: IV.logDate, question, context, force: !!force}});
    if(error){ let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch(_){} throw new Error(m); }
    if(data && data.error) throw new Error(data.error);
    out.innerHTML = `<div style="font-size:10.5px;color:var(--muted);margin-bottom:6px">${data.cached ? 'Kết quả đã lưu' : 'Mới tạo'} · ${h.esc(data.model || '')} <button class="btn small" type="button" id="ivAiRe">Hỏi lại</button></div>` + h.esc(data.answer);
    document.getElementById('ivAiRe').onclick = () => askAi(true);
  } catch(e){
    out.innerHTML = `<b>Chưa gọi được AI:</b> ${h.esc(e.message || e)}<br><span style="color:var(--muted)">Cần Edge Function <code>ai-recommend</code> và secret <code>ANTHROPIC_API_KEY</code> (xem README). Cột "Flag" theo rule vẫn chạy bình thường.</span>`;
  }
}

// styles
if(typeof document !== 'undefined'){
  const css = document.createElement('style');
  css.textContent = `.iv-kpis{grid-template-columns:repeat(6,minmax(0,1fr))}
.iv-filters{margin-bottom:8px}
.iv-filters select{min-width:0;width:140px;text-overflow:ellipsis}
.iv-filters #ivPic{width:150px} .iv-filters #ivPl{width:170px} .iv-filters #ivSku{width:220px} .iv-filters #ivEta{width:170px}
.iv-filters input[type=search]{width:160px;min-width:0}
.iv-filters input[type=search]{border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12.5px;background:#fff;color:var(--ink);font-family:inherit}
.iv-asof{margin:0 0 12px;padding:0 2px}
.iv-hero{border-top:3px solid var(--orange)}
.iv-sec{margin:28px 0 12px;padding:2px 0 2px 12px;border-left:4px solid var(--navy)}
.iv-sec-t{font-size:15px;font-weight:900;color:var(--navy);letter-spacing:.2px}
.iv-sec-d{font-size:11.5px;color:var(--muted);margin-top:2px}
.iv-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.iv-head h3{font-size:16px}
.iv-special{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 2px}
.iv-chip{display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--line);background:#fff;border-radius:20px;padding:5px 12px;font-size:12px;color:var(--ink);font-family:inherit;cursor:pointer}
.iv-chip span{font-size:11px;color:var(--muted)}
.iv-chip.red{border-color:#F0C4C4;background:var(--red-bg)} .iv-chip.red b{color:var(--red)}
.iv-chip.amber{border-color:#E9D8A6;background:var(--amber-bg)} .iv-chip.amber b{color:var(--amber)}
.iv-chip.plain{cursor:default} .iv-chip b{color:var(--navy)}
.iv-chip[disabled]{opacity:.55;cursor:default}
.iv-chip:not([disabled]):not(.plain):hover{filter:brightness(.97)}
#ivTable .vs,#ivLotTable .vs{font-size:10.5px;color:var(--muted);display:block}
#ivTable td.iv-zero{color:var(--red);font-weight:800}
.iv-heat{display:inline-flex;align-items:center;gap:4px;margin:0 2px}
.iv-heat i{display:inline-block;width:14px;height:10px;border-radius:3px;margin-left:6px;border:1px solid rgba(0,0,0,.06)}
#ivTable td.iv-flag{min-width:260px;max-width:360px;white-space:normal}
#ivTable td.iv-flag .badge{display:inline-block;margin:1px 4px 1px 0;white-space:normal;line-height:1.35}
#ivTable tr.sel td,#ivPicTable tr.sel td{background:#FFF3EA}
#ivPicTable tbody tr:hover td,#ivTable tbody tr:hover td,#ivLotTable tbody tr:hover td{background:#F7F9FC}
.iv-lots-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin:12px 0 6px;font-size:12.5px}
.iv-lotbar{display:flex;gap:8px 12px;flex-wrap:wrap;align-items:end;margin:0 0 8px}
.iv-lotbar label{display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.3px}
.iv-lotbar select,.iv-lotbar input{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12px;background:#fff;color:var(--ink);font-family:inherit;min-width:130px}
.iv-lotbar input{min-width:210px}
.iv-lotbar input[type=checkbox]{min-width:0;width:auto;padding:0;margin:0}
.iv-lotbar label.iv-ghost-tg{align-self:center;padding-top:14px}
.iv-grp{cursor:pointer}
.iv-dlots{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:12.5px}
#ivLotTable td.iv-hist{white-space:normal;min-width:180px}
.iv-def{position:relative;font-size:11.5px;font-weight:700;color:var(--navy);cursor:help;border-bottom:1px dashed var(--navy);white-space:nowrap;outline:none}
.iv-def-pop{display:none;position:absolute;right:0;top:calc(100% + 8px);width:480px;max-width:calc(100vw - 40px);z-index:30;background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,40,89,.14);font-weight:400;color:var(--ink);white-space:normal;text-align:left;line-height:1.45;cursor:default}
.iv-def:hover .iv-def-pop,.iv-def:focus .iv-def-pop,.iv-def:focus-within .iv-def-pop{display:block}
.iv-def-pop>b{display:block;color:var(--navy);margin-top:8px;font-size:12px}
.iv-def-pop>b:first-child{margin-top:0}
.iv-def-p{display:block;margin-top:3px;font-size:11.5px}
.iv-ghost-tg{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:var(--navy);cursor:pointer;white-space:nowrap}
#ivLotTable td{white-space:nowrap}
.iv-late-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
@media (max-width:1100px){.iv-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.iv-late-grid{grid-template-columns:1fr}}`;
  document.head.appendChild(css);
}
INV._state = IV; INV._compute = compute;
})();
