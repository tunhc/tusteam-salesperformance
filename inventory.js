// =====================================================================
// Inventory Tracking tab — tồn kho, incoming (ETA mới), trễ hàng, forecast
//
// Data (supabase_inventory_tracking.sql), loaded automatically every hour from
// "For_Sales_Incoming_Tracker.xlsx" by the Edge Function pull-inventory (Power Automate):
//   incoming_detail     01_AMZ_incoming_details (source AMZ: hàng về kho Amazon, AVC)
//                       02_Y4A_incoming_details (source Y4A: hàng về kho mình, kéo sớm được)
//   inventory_sellable  06_ USA_Sellable INV + 07_INT Sellable INV (tồn Y4A / AMZ per SKU)
//   amz_inventory_asin  04_AMZ_sellable details (Vendor Central per ASIN)
//   incoming_eta_log    USA lines of every load → ETA history
// on_time_status in the file:
//   normal · delay vs expected = ETA hiện tại lùi so với ETA ban đầu ·
//   delay vs current = đã quá ETA mà chưa thành sellable (quá hạn)
//
// Forecast (USA, from sales_daily): "AutoML" nhỏ chạy trên trình duyệt, như môn học —
// mỗi SKU chạy 5 mô hình (MA4, MA8, SES, Holt damped, Seasonal × level),
// backtest rolling-origin 8 tuần, horizon 4 tuần, chọn mô hình có WAPE thấp nhất.
// Projection: tồn tuần sau = tồn + incoming tuần đó (theo ETA) − forecast.
// =====================================================================
(function(){
const root = typeof window !== 'undefined' ? window : globalThis;
const INV = root.INV = root.INV || {};
const H = () => root.V2.h;
const DAY = 86400000;

// ---------------------------------------------------------------- dates
const iso = d => d.toISOString().slice(0, 10);
const addD = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * DAY));
const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();
const sunday = s => addD(s, -dow(s));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const md = s => s ? s.slice(5, 7) + '/' + s.slice(8, 10) : '—';
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

// ---------------------------------------------------------------- state
const IV = {country: 'USA', pic: '', pl: '', risk: '', status: '', src: '', q: '', etaMode: 'file',
  data: null, loadedFor: null, sales: null, rows: [], sort: 'riskRank', dir: 1, sel: null, grid: 'inc'};
const HZN = 16;   // projection weeks
// USA only; the SKU list, PIC, Main PL / Sub PL and lifecycle come from the follow-up (table skus)
const followUp = () => (typeof ROWS !== 'undefined' && Array.isArray(ROWS) ? ROWS : []);
const C = {amz:'#2a78d6', amzD:'#9EC3EF', amzO:'#D64545', y4a:'#1baf7a', y4aD:'#9ADBC2', fc:'#E86A10', stock:'#002859', act:'#66707C', warn:'#eda100'};
const STATUS_VI = {'normal': 'Đúng hạn', 'delay vs expected': 'Trễ so với ETA ban đầu', 'delay vs current': 'Quá ETA, chưa về'};

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
  if(c === 'USA' && !IV.sales) IV.sales = await loadSales();
}
// complete weeks of sales per SKU (Sunday start), 78 weeks back
async function loadSales(){
  const h = H();
  try {
    const b = await sb.rpc('sales_date_bounds'); const max = b.data && b.data[0] && b.data[0].max_date; if(!max) return null;
    const lastSat = dow(max) === 6 ? max : addD(sunday(max), -1);
    const from = addD(sunday(lastSat), -77 * 7);
    const rows = await h.rpcAll('sales_trend_by_sku', {p_from: from, p_to: lastSat, p_grain: 'week', p_skus: null});
    const weeks = []; for(let w = from; w <= lastSat; w = addD(w, 7)) weeks.push(w);
    const idx = new Map(weeks.map((w, i) => [w, i])), by = new Map();
    rows.forEach(r => { const i = idx.get(String(r.period).slice(0, 10)); if(i == null) return; if(!by.has(r.sku)) by.set(r.sku, Array(weeks.length).fill(0)); by.get(r.sku)[i] += +r.units || 0; });
    return {weeks, by, maxDate: max, lastSat};
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
function etaOf(r, logDate, buf){
  const base = r.eta_salable_date || logDate;
  if(IV.etaMode !== 'safe') return base < logDate ? logDate : base;
  if(base < logDate) return addD(logDate, 7);                        // quá hạn: giả định về trong 1 tuần
  return addD(base, buf.get(r.source + '|' + (r.physical_status || '')) || 0);
}
function compute(){
  const h = H(), D = IV.data; if(!D) return;
  const logDate = D.inc.reduce((m, r) => r.log_date > m ? r.log_date : m, '') || iso(new Date());
  const wk0 = sunday(logDate), weeks = Array.from({length: HZN}, (_, i) => addD(wk0, i * 7));
  const buf = slipBuffers(D.inc); IV.buf = buf; IV.logDate = logDate; IV.weeks = weeks;
  const inScope = sku => !!h.skuInfo(sku);
  const sell = new Map(D.sell.map(r => [r.sku, r]));
  const asinBy = new Map(); D.asin.forEach(r => { if(!r.sku) return; if(!asinBy.has(r.sku)) asinBy.set(r.sku, []); asinBy.get(r.sku).push(r); });
  const lines = D.inc.map(r => {
    const slip = r.eta_salable_original && r.eta_salable_date ? daysBetween(r.eta_salable_original, r.eta_salable_date) : null;
    const overdue = r.eta_salable_date && r.eta_salable_date < r.log_date ? daysBetween(r.eta_salable_date, r.log_date) : 0;
    return {...r, qty: +r.qty || 0, slip, overdue, eta: etaOf(r, r.log_date, buf)};
  });
  IV.lines = lines;
  const bySku = new Map(); lines.forEach(l => { if(!bySku.has(l.sku)) bySku.set(l.sku, []); bySku.get(l.sku).push(l); });
  const skus = new Set(followUp().map(r => r.sku));   // every SKU of the follow-up, also those without stock or incoming
  const S = IV.sales;
  const rows = [];
  for(const sku of skus){
    const k = h.skuInfo(sku) || {}, s = sell.get(sku) || {}, L = bySku.get(sku) || [];
    const amz = Math.max(0, +s.inv_amz || 0), y4a = Math.max(0, +s.inv_y4a || 0);
    const incA = Array(HZN).fill(0), incY = Array(HZN).fill(0); let beyondA = 0, beyondY = 0;
    const wkLines = Array.from({length: HZN + 1}, () => []);   // last slot = after the horizon
    L.forEach(l => { const i = Math.floor(daysBetween(wk0, l.eta) / 7); if(i >= HZN){ if(l.source === 'AMZ') beyondA += l.qty; else beyondY += l.qty; wkLines[HZN].push(l); return; }
      (l.source === 'AMZ' ? incA : incY)[Math.max(0, i)] += l.qty; wkLines[Math.max(0, i)].push(l); });
    // demand
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
    const pA = proj(amz, incA), pT = proj(amz + y4a, incA.map((v, i) => v + incY[i]));
    const nextOf = src => L.filter(l => l.source === src).sort((a, b) => a.eta < b.eta ? -1 : 1)[0] || null;
    const nA = nextOf('AMZ'), nY = nextOf('Y4A');
    const dl = L.filter(l => l.on_time_status === 'delay vs expected'), od = L.filter(l => l.on_time_status === 'delay vs current');
    const sum = (a, k = 'qty') => a.reduce((t, x) => t + (+x[k] || 0), 0);
    const fc4 = fcW ? mean(f.fc.slice(0, 4)) : null, act4 = hist ? mean(hist.slice(-4)) : null;
    const woc = fc4 > 0 ? amz / fc4 : null, wocT = fc4 > 0 ? (amz + y4a) / fc4 : null;
    // risk + suggestion
    let risk = 'OK', why = [], rank = 5;
    const firstInc = incA.findIndex(v => v > 0);
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
    if(!fcW && (amz + y4a) > 0 && rank === 5){ risk = 'Chưa có forecast'; rank = 6; }
    if(!L.length && amz + y4a <= 0 && !(fc4 > 0)) continue;   // nothing to track: no stock, no incoming, no sales
    rows.push({sku, name: k.productName || s.product_name || (L[0] || {}).product_name || '', pl: k.mainPL || (L[0] || {}).product_line || '', subPl: k.subPL || '', lifecycle: k.lifecycle || '', pic: k.pic || 'Unassigned',
      dept: s.department || (L[0] || {}).department || '', amz, y4a, incA, incY, beyondA, beyondY, wkLines,
      incAmzTot: sum(L.filter(l => l.source === 'AMZ')), incY4aTot: sum(L.filter(l => l.source === 'Y4A')),
      delayQty: sum(dl), overdueQty: sum(od), maxSlip: dl.length ? Math.max(...dl.map(l => l.slip || 0)) : 0, maxOverdue: od.length ? Math.max(...od.map(l => l.overdue)) : 0,
      nA, nY, f, hist, fcW, fc4, act4, woc, wocT, pA, pT, risk, why, riskRank: rank, firstInc, lines: L, asins: asinBy.get(sku) || [],
      oosWk: pA.oosWk, lost: pA.lost, model: f ? f.model : '', acc: f && f.wape != null ? Math.max(0, 1 - f.wape) : null});
  }
  IV.rows = rows;
}

// ---------------------------------------------------------------- render
INV.render = async function(){
  const host = document.getElementById('view-inv'); if(!host) return;
  const h = H();
  if(!host.dataset.built){ build(host); host.dataset.built = '1'; }
  if(!IV.data || IV.loadedFor !== IV.country){
    host.querySelector('#ivBody').innerHTML = '<tr><td colspan="18" style="padding:18px;color:var(--muted)">Đang tải tồn kho, incoming' + ' và số bán để forecast' + '…</td></tr>';
    try { await load(); }
    catch(e){ IV.data = null; host.querySelector('#ivBody').innerHTML = `<tr><td colspan="18" style="padding:18px;color:var(--muted)">${h.missingSchema(e) ? 'Chưa có bảng: chạy <b>supabase_inventory_tracking.sql</b> trong SQL Editor.' : 'Không tải được: ' + h.esc(e.message || e)}</td></tr>`; return; }
    compute();
    const pics = [...new Set(IV.rows.map(r => r.pic).filter(Boolean))].sort(), pls = [...new Set(IV.rows.map(r => r.pl).filter(Boolean))].sort();
    host.querySelector('#ivPic').innerHTML = '<option value="">All</option>' + pics.map(p => `<option ${p === IV.pic ? 'selected' : ''}>${h.esc(p)}</option>`).join('');
    host.querySelector('#ivPl').innerHTML = '<option value="">All</option>' + pls.map(p => `<option ${p === IV.pl ? 'selected' : ''}>${h.esc(p)}</option>`).join('');
  }
  paint();
};
function build(host){
  host.innerHTML = `<div class="filterbar">
      <div class="fld"><label for="ivPic">PIC</label><select id="ivPic"><option value="">All</option></select></div>
      <div class="fld"><label for="ivPl">Main PL</label><select id="ivPl"><option value="">All</option></select></div>
      <div class="fld"><label for="ivRisk">Rủi ro</label><select id="ivRisk"><option value="">All</option><option>OOS ≤2 tuần</option><option>OOS trong 8 tuần</option><option>Hàng quá ETA</option><option>ETA bị lùi</option><option>Tồn cao</option><option>OK</option></select></div>
      <div class="fld"><label for="ivEta">ETA dùng để dự phóng</label><select id="ivEta"><option value="file">ETA trong file</option><option value="safe">ETA thận trọng (+ độ trễ TB)</option></select></div>
      <div class="fld"><label for="ivQ">Tìm SKU / tên / product line</label><input id="ivQ" type="search" placeholder="VD: DXD3, Kettlebell…"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn small" id="ivReload" type="button">↻ Tải lại</button></div>
    </div>
    <div class="btr-src" id="ivSrc"></div>
    <div class="kpis iv-kpis" id="ivKpis"></div>
    <div class="btr-grid">
      <div class="card"><h3>Incoming theo tuần (theo ETA đang chọn)</h3><div class="hint">Xanh dương = về kho Amazon (AVC), xanh lá = về kho Y4A. Màu nhạt = ETA đã lùi so với ban đầu; đỏ = đã quá ETA mà chưa về (dồn vào tuần hiện tại).</div><div id="ivWeekly" class="plot"></div></div>
      <div class="card"><h3>Hàng trễ theo Main PL</h3><div class="hint">Units đang trễ: ETA lùi so với ban đầu, và đã quá ETA. Rê chuột để xem số SKU và số ngày trễ.</div><div id="ivPlDelay" class="plot"></div></div>
      <div class="card"><h3>ETA bị lùi bao nhiêu ngày</h3><div class="hint">Phân bố số ngày ETA hiện tại − ETA ban đầu (theo units). Đây là "độ trễ TB" cộng thêm khi chọn ETA thận trọng.</div><div id="ivSlip" class="plot"></div></div>
      <div class="card"><h3>Hàng đang ở đâu</h3><div class="hint">Units incoming theo trạng thái vật lý (Pre-pipeline → In production → Pipeline → In land transit).</div><div id="ivPhys" class="plot"></div></div>
    </div>
    <div class="card"><h3>Tổng hợp theo PIC (follow-up)</h3>
      <div class="hint">Mỗi PIC: tồn, hàng về, hàng trễ và rủi ro OOS của các SKU mình phụ trách (PIC, Main PL theo follow-up). Bấm một PIC để lọc cả trang; bấm lại để bỏ lọc.</div>
      <div class="tablewrap" style="max-height:420px"><table id="ivPicTable"><thead><tr>
        <th>PIC</th><th class="num">SKU</th><th class="num">Tồn AMZ</th><th class="num">Tồn Y4A</th><th class="num">Forecast / tuần</th><th class="num">WOC AMZ</th>
        <th class="num">Incoming AMZ</th><th class="num">Incoming Y4A</th><th class="num">Units ETA lùi</th><th class="num">Units quá ETA</th>
        <th class="num">OOS ≤2 tuần</th><th class="num">OOS 8 tuần</th><th class="num">Units có thể mất</th><th class="num">Tồn cao</th>
      </tr></thead><tbody id="ivPicBody"></tbody></table></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h3 style="margin:0">Theo dõi theo SKU</h3>
        <div style="display:flex;gap:8px"><button class="btn small" id="ivAi" type="button">🤖 AI phân tích &amp; đề xuất</button><button class="btn small" id="ivExport" type="button">&#128190; Export Excel</button></div></div>
      <div id="ivAiOut" class="ai-out" hidden style="white-space:pre-wrap;font-size:12.5px;background:#F7F9FC;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0"></div>
      <div class="hint">Tồn = sellable hiện tại. Bán/tuần = TB 4 tuần đủ gần nhất (sales_daily). Forecast/tuần = TB 4 tuần tới, mô hình tốt nhất của SKU (độ chính xác = 1 − WAPE backtest 8 tuần). WOC = số tuần tồn AMZ đủ bán (tổng AMZ + Y4A bên dưới). OOS = tuần tồn AMZ (cộng hàng AMZ về theo ETA) không đủ forecast. Bấm một dòng để xem chart theo SKU (dự phóng tuần, các lô hàng về và lịch sử ETA).</div>
      <div class="tablewrap" style="max-height:640px"><table id="ivTable"><thead><tr>
        <th data-k="pic">PIC</th><th data-k="sku">SKU</th><th data-k="name">Product</th><th data-k="pl">Main PL</th>
        <th data-k="amz" class="num">Tồn AMZ</th><th data-k="y4a" class="num">Tồn Y4A</th><th data-k="act4" class="num">Bán / tuần</th><th data-k="fc4" class="num">Forecast / tuần</th>
        <th data-k="woc" class="num">WOC</th><th data-k="oosWk" class="num">OOS (AMZ)</th>
        <th data-k="nAeta">Hàng AMZ kế tiếp</th><th data-k="nYeta">Hàng Y4A kế tiếp</th>
        <th data-k="incAmzTot" class="num">Incoming AMZ</th><th data-k="incY4aTot" class="num">Incoming Y4A</th>
        <th data-k="delayQty" class="num">Units ETA lùi</th><th data-k="overdueQty" class="num">Units quá ETA</th>
        <th data-k="riskRank">Rủi ro</th><th data-k="whyTxt">Gợi ý</th>
      </tr></thead><tbody id="ivBody"></tbody></table></div>
    </div>
    <div class="card" id="ivGridCard">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h3 style="margin:0">Lịch hàng về theo tuần</h3>
        <div class="cv-toggle" id="ivGridMode"><button class="cv-btn active" data-m="inc" type="button">Hàng về</button><button class="cv-btn" data-m="stock" type="button">Tồn AMZ dự phóng</button></div></div>
      <div class="hint">Kéo ngang để xem từng tuần (tuần bắt đầu Chủ nhật, theo ETA đang chọn). <b style="color:#2a78d6">Xanh dương</b> = về kho Amazon, <b style="color:#1baf7a">xanh lá</b> = về kho Y4A. Ô nền vàng = ETA đã lùi so với ban đầu, nền đỏ = đã quá ETA mà chưa về (dồn vào tuần hiện tại). Chế độ "Tồn AMZ dự phóng": tồn AMZ cuối tuần sau khi cộng hàng về và trừ forecast, ô đỏ = không đủ hàng bán. Rê chuột vào ô để xem chi tiết; bấm SKU để xem chart.</div>
      <div class="tablewrap iv-grid" style="max-height:620px"><table id="ivGrid"><thead id="ivGridHead"></thead><tbody id="ivGridBody"></tbody></table></div>
    </div>
    <div class="card" id="ivDetail"></div>
    </div>`;
  const $ = s => host.querySelector(s), re = () => paint();
  $('#ivPic').onchange = e => { IV.pic = e.target.value; re(); };
  $('#ivPl').onchange = e => { IV.pl = e.target.value; re(); };
  $('#ivRisk').onchange = e => { IV.risk = e.target.value; re(); };
  $('#ivEta').onchange = e => { IV.etaMode = e.target.value; compute(); re(); };
  $('#ivQ').oninput = e => { IV.q = e.target.value.trim().toLowerCase(); re(); };
  $('#ivReload').onclick = () => { IV.data = null; IV.sales = null; INV.render(); };
  $('#ivExport').onclick = exportXlsx;
  $('#ivAi').onclick = () => askAi(false);
  host.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; if(IV.sort === k) IV.dir *= -1; else { IV.sort = k; IV.dir = ['pic','sku','name','pl','riskRank','oosWk','nAeta','nYeta','whyTxt'].includes(k) ? 1 : -1; } re(); });
  host.querySelectorAll('#ivGridMode .cv-btn').forEach(b => b.onclick = () => { IV.grid = b.dataset.m; host.querySelectorAll('#ivGridMode .cv-btn').forEach(x => x.classList.toggle('active', x === b)); re(); });
}
function filtered(){
  return IV.rows.filter(r => (!IV.pic || r.pic === IV.pic) && (!IV.pl || r.pl === IV.pl) && (!IV.risk || r.risk === IV.risk) &&
    (!IV.q || [r.sku, r.name, r.pl, r.subPl].join(' ').toLowerCase().includes(IV.q)));
}
function paint(){
  const h = H(), D = IV.data; if(!D) return;
  const fi = v => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US');
  const rows = filtered(), keep = new Set(rows.map(r => r.sku));
  const lines = IV.lines.filter(l => keep.has(l.sku));
  // sources
  const up = D.up, logA = D.inc.filter(l => l.source === 'AMZ').map(l => l.log_date).sort().pop(), logY = D.inc.filter(l => l.source === 'Y4A').map(l => l.log_date).sort().pop();
  const s0 = D.sell[0] || {};
  document.getElementById('ivSrc').innerHTML = `<span>Incoming AMZ: <b>${md(logA)}</b> · Y4A: <b>${md(logY)}</b></span><span>Tồn Y4A: <b>${md(s0.y4a_as_of)}</b> · tồn AMZ: <b>${md(s0.amz_as_of)}</b></span>` +
    `<span>Thị trường <b>USA</b> · <b>${IV.rows.length}</b> SKU của follow-up đang có tồn / hàng về / số bán</span>` + (IV.sales ? `<span>Số bán để forecast: tới <b>${md(IV.sales.lastSat)}</b> (tuần đủ, ${IV.sales.weeks.length} tuần)</span>` : '') +
    (up ? `<span>Cập nhật tự động lần cuối: <b>${(d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)(new Date(up.uploaded_at))}</b> (mỗi giờ, từ file tracker)</span>` : '<span>Chưa có lần cập nhật nào: chờ flow tự động (mỗi giờ)</span>');
  // KPIs
  const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
  const dl = lines.filter(l => l.on_time_status === 'delay vs expected'), od = lines.filter(l => l.on_time_status === 'delay vs current');
  const tot = sum(lines, l => l.qty), slipAvg = sum(dl, l => (l.slip || 0) * l.qty) / (sum(dl, l => l.qty) || 1), odAvg = sum(od, l => l.overdue * l.qty) / (sum(od, l => l.qty) || 1);
  const oos2 = rows.filter(r => r.risk === 'OOS ≤2 tuần').length, oos8 = rows.filter(r => r.risk === 'OOS trong 8 tuần').length;
  const accRows = rows.filter(r => r.acc != null && r.fc4 > 0), acc = sum(accRows, r => r.acc * r.fc4) / (sum(accRows, r => r.fc4) || 1);
  const mix = {}; accRows.forEach(r => mix[r.model] = (mix[r.model] || 0) + 1);
  document.getElementById('ivKpis').innerHTML = [
    ['Incoming', fi(tot) + ' u', `${new Set(lines.map(l => l.sku)).size} SKU · AMZ ${fi(sum(lines.filter(l => l.source === 'AMZ'), l => l.qty))} / Y4A ${fi(sum(lines.filter(l => l.source === 'Y4A'), l => l.qty))}`],
    ['ETA lùi so với ban đầu', fi(sum(dl, l => l.qty)) + ' u', `${tot ? (sum(dl, l => l.qty) / tot * 100).toFixed(0) : 0}% units · ${new Set(dl.map(l => l.sku)).size} SKU · lùi TB ${slipAvg.toFixed(0)} ngày`],
    ['Quá ETA, chưa về', fi(sum(od, l => l.qty)) + ' u', `${new Set(od.map(l => l.sku)).size} SKU · quá TB ${odAvg.toFixed(0)} ngày`],
    ['Tồn sellable', fi(sum(rows, r => r.amz + r.y4a)) + ' u', `AMZ ${fi(sum(rows, r => r.amz))} · Y4A ${fi(sum(rows, r => r.y4a))}`],
    ['Nguy cơ OOS (AMZ)', `${oos2 + oos8} SKU`, `${oos2} SKU ≤ 2 tuần · ${oos8} SKU trong 8 tuần · mất ~${fi(sum(rows.filter(r => r.oosWk !== null && r.oosWk < 8), r => r.lost))} u / ${HZN} tuần`],
    ['Forecast', accRows.length ? (acc * 100).toFixed(0) + '%' : '—', accRows.length ? 'độ chính xác backtest · ' + Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ') : 'chỉ có cho USA'],
  ].map(([k, v, s]) => `<div class="kpi"><div class="lbl">${k}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join('');
  // charts
  const W = IV.weeks, wl = W.map(md);
  const wkSum = (src, st) => W.map((w, i) => sum(lines.filter(l => l.source === src && l.on_time_status === st), l => Math.floor(daysBetween(W[0], l.eta) / 7) === i || (i === 0 && l.eta < W[0]) ? l.qty : 0));
  const lay = x => h.lay(Object.assign({margin: {l: 52, r: 12, t: 6, b: 50}, barmode: 'stack', hovermode: 'x unified', legend: {orientation: 'h', y: -0.2, x: 0, font: {size: 10.5}}}, x));
  const beyond = sum(lines.filter(l => daysBetween(W[0], l.eta) >= HZN * 7), l => l.qty);
  h.draw('ivWeekly', [
    ['AMZ', 'normal', C.amz, 'AMZ đúng hạn'], ['AMZ', 'delay vs expected', C.amzD, 'AMZ ETA lùi'], ['AMZ', 'delay vs current', C.amzO, 'AMZ quá ETA'],
    ['Y4A', 'normal', C.y4a, 'Y4A đúng hạn'], ['Y4A', 'delay vs expected', C.y4aD, 'Y4A ETA lùi'], ['Y4A', 'delay vs current', '#8B1E1E', 'Y4A quá ETA'],
  ].map(([s, st, col, name]) => ({type: 'bar', x: wl, y: wkSum(s, st), name, marker: {color: col}, hovertemplate: name + ': %{y:,.0f}<extra></extra>'})).filter(t => t.y.some(v => v)),
    lay({xaxis: h.ax({title: {text: beyond ? `Sau ${HZN} tuần còn ${fi(beyond)} u` : ''}}), yaxis: h.ax({tickformat: ',.0f'})}));
  const plOf = sku => ((h.skuInfo(sku) || {}).mainPL || '—'); const byPl = new Map(); lines.forEach(l => { if(l.on_time_status === 'normal') return; const a = byPl.get(plOf(l.sku)) || {d: 0, o: 0, po: new Set(), slip: 0}; if(l.on_time_status === 'delay vs current') a.o += l.qty; else a.d += l.qty; a.po.add(l.sku); a.slip = Math.max(a.slip, l.slip || 0, l.overdue); byPl.set(plOf(l.sku), a); });
  const pl = [...byPl.entries()].sort((a, b) => (a[1].d + a[1].o) - (b[1].d + b[1].o)).slice(-14);
  if(pl.length) h.draw('ivPlDelay', [
    {type: 'bar', orientation: 'h', y: pl.map(p => p[0]), x: pl.map(p => p[1].d), name: 'ETA lùi', marker: {color: C.warn}, customdata: pl.map(p => [p[1].po.size, p[1].slip]), hovertemplate: 'ETA lùi: %{x:,.0f} u · %{customdata[0]} SKU · tối đa %{customdata[1]} ngày<extra></extra>'},
    {type: 'bar', orientation: 'h', y: pl.map(p => p[0]), x: pl.map(p => p[1].o), name: 'Quá ETA', marker: {color: C.amzO}, hovertemplate: 'Quá ETA: %{x:,.0f} u<extra></extra>'},
  ], lay({margin: {l: 170, r: 30, t: 6, b: 40}, hovermode: 'y unified', yaxis: h.ax({automargin: false}), xaxis: h.ax({tickformat: ',.0f'})}));
  else document.getElementById('ivPlDelay').innerHTML = '<div class="hint" style="padding:20px">Không có hàng trễ trong phạm vi đang lọc.</div>';
  const bins = [[-999, 0, '≤0'], [1, 7, '1–7'], [8, 14, '8–14'], [15, 30, '15–30'], [31, 60, '31–60'], [61, 9999, '>60']];
  const wS = lines.filter(l => l.slip != null);
  h.draw('ivSlip', ['AMZ', 'Y4A'].map(src => ({type: 'bar', name: src === 'AMZ' ? 'Về kho Amazon' : 'Về kho Y4A', x: bins.map(b => b[2] + ' ngày'), marker: {color: src === 'AMZ' ? C.amz : C.y4a},
    y: bins.map(b => sum(wS.filter(l => l.source === src && l.slip >= b[0] && l.slip <= b[1]), l => l.qty)), hovertemplate: '%{x}: %{y:,.0f} u<extra></extra>'})), lay({barmode: 'group', yaxis: h.ax({tickformat: ',.0f'})}));
  const ph = ['Pre-pipeline', 'In production', 'Pipeline', 'In land transit'];
  h.draw('ivPhys', ['AMZ', 'Y4A'].map(src => ({type: 'bar', name: src === 'AMZ' ? 'Về kho Amazon' : 'Về kho Y4A', x: ph, marker: {color: src === 'AMZ' ? C.amz : C.y4a},
    y: ph.map(p => sum(lines.filter(l => l.source === src && l.physical_status === p), l => l.qty)), hovertemplate: '%{x}: %{y:,.0f} u<extra></extra>'})), lay({yaxis: h.ax({tickformat: ',.0f'})}));
  // PIC summary (every filter except PIC, so a click can switch PIC)
  const base = IV.rows.filter(r => (!IV.pl || r.pl === IV.pl) && (!IV.risk || r.risk === IV.risk) &&
    (!IV.q || [r.sku, r.name, r.pl, r.subPl].join(' ').toLowerCase().includes(IV.q)));
  const byPic = new Map();
  base.forEach(r => { const a = byPic.get(r.pic) || {pic: r.pic, n: 0, amz: 0, y4a: 0, fc: 0, incA: 0, incY: 0, dl: 0, od: 0, po: new Set(), o2: 0, o8: 0, lost: 0, high: 0};
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
  document.querySelectorAll('#ivPicBody tr[data-pic]').forEach(t => t.onclick = () => { IV.pic = IV.pic === t.dataset.pic ? '' : t.dataset.pic; const sel = document.getElementById('ivPic'); if(sel) sel.value = IV.pic; paint(); });
  // SKU table
  rows.forEach(r => { r.nAeta = r.nA ? r.nA.eta : '9999'; r.nYeta = r.nY ? r.nY.eta : '9999'; r.whyTxt = r.why.join(' · '); });
  const val = (r, k) => k === 'oosWk' ? (r.oosWk === null ? 999 : r.oosWk) : k === 'riskRank' ? r.riskRank * 1000 + (r.oosWk === null ? 999 : r.oosWk) : r[k];
  const tr = [...rows].sort((a, b) => { const va = val(a, IV.sort), vb = val(b, IV.sort); return typeof va === 'string' || typeof vb === 'string' ? IV.dir * String(va ?? '').localeCompare(String(vb ?? '')) : IV.dir * ((va ?? -1e18) - (vb ?? -1e18)); });
  const badge = r => `<span class="badge ${r.riskRank <= 2 ? 'red' : r.riskRank <= 3 ? 'amber' : r.risk === 'OK' ? 'green' : 'gray'}">${h.esc(r.risk)}</span>`;
  const nxt = l => l ? `${md(l.eta)}<span class="vs">${fi(l.qty)} u · ${h.esc(l.physical_status || '')}${l.on_time_status !== 'normal' ? ' · <b style="color:var(--red)">' + (l.on_time_status === 'delay vs current' ? 'quá ETA' : 'lùi ' + (l.slip || 0) + 'n') + '</b>' : ''}</span>` : '—';
  document.getElementById('ivBody').innerHTML = tr.slice(0, 600).map(r => `<tr class="main${IV.sel === r.sku ? ' sel' : ''}" data-sku="${h.esc(r.sku)}" style="cursor:pointer">
      <td>${h.esc(r.pic)}</td><td><b>${h.esc(r.sku)}</b></td><td class="name-cell" title="${h.esc(r.name)}">${h.esc(r.name)}</td><td>${h.esc(r.pl)}${r.subPl && r.subPl !== 'Unclassified' ? `<span class="vs">${h.esc(r.subPl)}</span>` : ''}</td>
      <td class="num">${fi(r.amz)}</td><td class="num">${fi(r.y4a)}</td><td class="num">${r.act4 == null ? '—' : r.act4.toFixed(1)}</td>
      <td class="num" title="${r.f ? 'Mô hình ' + r.model + (r.acc != null ? ' · chính xác ' + (r.acc * 100).toFixed(0) + '%' : '') : ''}">${r.fc4 == null ? '—' : r.fc4.toFixed(1)}<span class="vs">${h.esc(r.model)}${r.acc != null ? ' · ' + (r.acc * 100).toFixed(0) + '%' : ''}</span></td>
      <td class="num">${r.woc == null ? '—' : r.woc > 99 ? '>99' : r.woc.toFixed(1)}<span class="vs">tổng ${r.wocT == null ? '—' : r.wocT > 99 ? '>99' : r.wocT.toFixed(1)}</span></td>
      <td class="num">${r.oosWk === null ? (r.fcW ? '—' : '') : `<b style="color:var(--red)">${md(IV.weeks[r.oosWk])}</b><span class="vs">mất ~${fi(r.lost)} u</span>`}</td>
      <td>${nxt(r.nA)}</td><td>${nxt(r.nY)}</td>
      <td class="num">${fi(r.incAmzTot)}</td><td class="num">${fi(r.incY4aTot)}</td>
      <td class="num">${r.delayQty ? fi(r.delayQty) + `<span class="vs">tối đa ${r.maxSlip}n</span>` : '—'}</td>
      <td class="num">${r.overdueQty ? `<b style="color:var(--red)">${fi(r.overdueQty)}</b><span class="vs">${r.maxOverdue}n</span>` : '—'}</td>
      <td>${badge(r)}</td><td style="min-width:240px;font-size:11.5px">${r.why.map(w => '• ' + h.esc(w)).join('<br>')}</td></tr>`).join('')
    || '<tr><td colspan="18" style="padding:18px;color:var(--muted)">Không có SKU nào khớp bộ lọc' + (IV.data.inc.length ? '' : ' (chưa có dữ liệu: chờ flow tự động mỗi giờ)') + '.</td></tr>';
  document.querySelectorAll('#ivBody tr[data-sku]').forEach(t => t.onclick = () => { IV.sel = t.dataset.sku; paint(); document.getElementById('ivDetail').scrollIntoView({behavior: 'smooth', block: 'start'}); });
  document.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.setAttribute('aria-sort', th.dataset.k === IV.sort ? (IV.dir > 0 ? 'ascending' : 'descending') : 'none'));
  // weekly grid: one row per SKU, one column per week
  const W2 = IV.weeks, cellTip = ls => ls.map(l => `${l.source === 'AMZ' ? 'Amazon' : 'Y4A'} ${fi(l.qty)} u · ETA ${md(l.eta_salable_date)}${l.eta_salable_original && l.eta_salable_original !== l.eta_salable_date ? ' (ban đầu ' + md(l.eta_salable_original) + ')' : ''} · ${l.physical_status || ''}${l.on_time_status === 'delay vs current' ? ' · QUÁ ETA ' + l.overdue + 'n' : l.slip > 0 ? ' · lùi ' + l.slip + 'n' : ''}${l.container_number ? ' · ' + l.container_number : ''}`).join('\n');
  document.getElementById('ivGridHead').innerHTML = `<tr><th class="g-sku">SKU</th><th class="g-pl">Product line</th><th class="g-inv num">Tồn AMZ</th><th class="g-inv2 num">Tồn Y4A</th>${W2.map((w, i) => `<th class="num g-wk" title="Tuần ${md(w)} → ${md(addD(w, 6))}">${i === 0 ? 'Tuần này' : 'Tuần'}<br>${md(w)}</th>`).join('')}${IV.grid === 'inc' ? `<th class="num g-wk">Sau<br>${md(addD(W2[0], HZN * 7))}</th>` : ''}<th class="num g-wk">Tổng<br>về</th></tr>`;
  const gridRows = [...tr];
  document.getElementById('ivGridBody').innerHTML = gridRows.slice(0, 600).map(r => {
    const cells = IV.grid === 'inc'
      ? r.wkLines.map(ls => {
          if(!ls.length) return '<td class="num g-c"></td>';
          const a = ls.filter(l => l.source === 'AMZ').reduce((t, l) => t + l.qty, 0), y = ls.filter(l => l.source === 'Y4A').reduce((t, l) => t + l.qty, 0);
          const cls = ls.some(l => l.on_time_status === 'delay vs current') ? ' g-od' : ls.some(l => l.on_time_status === 'delay vs expected') ? ' g-dl' : '';
          return `<td class="num g-c${cls}" title="${h.esc(cellTip(ls))}">${a ? `<span class="g-a">${fi(a)}</span>` : ''}${y ? `<span class="g-y">${fi(y)}</span>` : ''}</td>`; }).join('')
      : (r.fcW ? r.pA.p.map((v, i) => { const short = r.fcW[i] > 0 && (i === 0 ? r.amz + r.incA[0] : r.pA.p[i - 1] + r.incA[i]) < r.fcW[i];
          return `<td class="num g-c${short ? ' g-od' : ''}" title="Tồn AMZ cuối tuần ${fi(v)} · hàng về AMZ ${fi(r.incA[i])} · forecast ${r.fcW[i].toFixed(1)}">${fi(v)}</td>`; }).join('')
         : W2.map(() => '<td class="num g-c" title="Chưa có forecast">·</td>').join(''));
    return `<tr data-sku="${h.esc(r.sku)}"${IV.sel === r.sku ? ' class="sel"' : ''}><td class="g-sku"><b>${h.esc(r.sku)}</b><span class="vs" title="${h.esc(r.name)}">${h.esc(r.name.slice(0, 26))}</span></td><td class="g-pl">${h.esc(r.pl)}${r.subPl && r.subPl !== 'Unclassified' ? `<span class="vs">${h.esc(r.subPl)}</span>` : ''}</td>
      <td class="num g-inv">${fi(r.amz)}</td><td class="num g-inv2">${fi(r.y4a)}</td>${cells}<td class="num"><b>${fi(r.incAmzTot + r.incY4aTot)}</b></td></tr>`;
  }).join('') || `<tr><td colspan="${HZN + 7}" style="padding:18px;color:var(--muted)">Không có SKU nào khớp bộ lọc.</td></tr>`;
  document.querySelectorAll('#ivGridBody tr[data-sku]').forEach(t => t.onclick = () => { IV.sel = t.dataset.sku; paint(); document.getElementById('ivDetail').scrollIntoView({behavior: 'smooth', block: 'start'}); });
  // SKU chart: the clicked SKU, else the first SKU of the list
  if(!IV.sel || !rows.some(r => r.sku === IV.sel)) IV.sel = tr.length ? tr[0].sku : null;
  detail();
}

// one SKU: weekly projection, incoming lines, ETA history, Vendor Central metrics
async function detail(){
  const h = H(), host = document.getElementById('ivDetail'), r = IV.rows.find(x => x.sku === IV.sel);
  if(!r){ host.innerHTML = '<h3 style="margin:0">Chart theo SKU</h3><div class="hint" style="margin-top:8px">Không có SKU nào khớp bộ lọc.</div>'; return; }
  const fi = v => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US');
  const W = IV.weeks, wl = W.map(md);
  const a0 = r.asins[0];
  host.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:end;gap:10px;flex-wrap:wrap"><h3 style="margin:0">Chart theo SKU · ${h.esc(r.sku)} · ${h.esc(r.name)}</h3>
      <div class="fld"><label for="ivSkuPick" style="font-size:10.5px;font-weight:800;color:var(--muted);display:block">Chọn SKU</label><select id="ivSkuPick">${filtered().slice().sort((a, b) => a.sku.localeCompare(b.sku)).map(x => `<option value="${h.esc(x.sku)}"${x.sku === r.sku ? ' selected' : ''}>${h.esc(x.sku)} · ${h.esc(x.name.slice(0, 40))}</option>`).join('')}</select></div></div>
    <div class="hint">Tồn AMZ <b>${fi(r.amz)}</b> · tồn Y4A <b>${fi(r.y4a)}</b> · ${h.esc(r.pl)}${r.pic ? ' · PIC ' + h.esc(r.pic) : ''} · ${r.f ? `Forecast: ${h.esc(r.model)}${r.acc != null ? ', chính xác backtest ' + (r.acc * 100).toFixed(0) + '%' : ''} (so sánh: ${Object.entries(r.f.scores).sort((a, b) => a[1] - b[1]).map(([m, s]) => m + ' ' + Math.max(0, (1 - s) * 100).toFixed(0) + '%').join(', ')})` : 'Chưa có số bán để forecast'}
    ${r.asins.length ? '<br>Vendor Central: ' + r.asins.map(a => `${h.esc(a.asin)} — on hand ${fi(a.sellable_on_hand_units)}, in transit ${fi(a.sellable_in_transit_units)}, open PO ${fi(a.open_po_units)}, aged 90+ ${fi(a.aged_90_units)}, confirm ${a.vendor_confirmation_rate == null ? '—' : (a.vendor_confirmation_rate * 100).toFixed(0) + '%'}, fill ${a.receive_fill_rate == null ? '—' : (a.receive_fill_rate * 100).toFixed(0) + '%'}, OOS ${a.procurable_oos_rate == null ? '—' : (a.procurable_oos_rate * 100).toFixed(1) + '%'}`).join('<br>') : ''}</div>
    <div id="ivDPlot" class="plot" style="height:340px"></div>
    <div class="tablewrap" style="max-height:300px;margin-top:10px"><table><thead><tr><th>Kho đến</th><th>Container</th><th class="num">Units</th><th>Trạng thái</th><th>Ngày đặt</th><th>Ship dự kiến</th><th>Ship thực tế</th><th>ETA cảng</th><th>ETA ban đầu</th><th>ETA hiện tại</th><th>ETA dùng</th><th>Tình trạng</th><th>Lịch sử ETA</th></tr></thead>
    <tbody id="ivDLines">${r.lines.sort((a, b) => a.eta < b.eta ? -1 : 1).map(l => `<tr><td>${l.source === 'AMZ' ? 'Amazon · ' + h.esc(l.channel || '') : 'Y4A · ' + h.esc(l.channel || '')}</td><td>${h.esc(l.container_number || '—')}</td><td class="num">${fi(l.qty)}</td><td>${h.esc(l.physical_status || '')}</td>
      <td>${md(l.ordered_date)}</td><td>${md(l.expected_ship_date)}</td><td>${md(l.actual_ship_date)}</td><td>${md(l.ata_pod || l.eta_pod)}</td><td>${md(l.eta_salable_original)}</td><td><b>${md(l.eta_salable_date)}</b></td><td>${md(l.eta)}</td>
      <td><span class="badge ${l.on_time_status === 'delay vs current' ? 'red' : l.on_time_status === 'delay vs expected' ? 'amber' : 'green'}">${STATUS_VI[l.on_time_status] || h.esc(l.on_time_status || '')}${l.slip > 0 ? ' +' + l.slip + 'n' : ''}${l.overdue ? ' · ' + l.overdue + 'n' : ''}</span></td><td class="hist" data-po="${h.esc(l.po_name)}" data-c="${h.esc(l.container_number || '')}">…</td></tr>`).join('') || '<tr><td colspan="13" style="color:var(--muted)">Không có hàng đang về.</td></tr>'}</tbody></table></div>`;
  host.querySelector('#ivSkuPick').onchange = e => { IV.sel = e.target.value; paint(); };
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
  // ETA history (USA keeps one row per load)
  try {
    const hist = await h.selectAll('incoming_eta_log', q => q.eq('country', IV.country).eq('sku', r.sku).order('log_date'));
    host.querySelectorAll('td.hist').forEach(td => {
      const hs = hist.filter(x => x.po_name === td.dataset.po && x.container_number === td.dataset.c);
      const seq = []; hs.forEach(x => { if(!seq.length || seq[seq.length - 1].eta !== x.eta_salable_date) seq.push({at: x.log_date, eta: x.eta_salable_date}); });
      td.innerHTML = seq.length > 1 ? seq.map(s => `${md(s.eta)}<span style="color:var(--muted);font-size:10px"> (${md(s.at)})</span>`).join(' → ') : hs.length ? `<span style="color:var(--muted)">chưa đổi (${hs.length} lần cập nhật)</span>` : '—';
    });
  } catch(_){ host.querySelectorAll('td.hist').forEach(td => td.textContent = '—'); }
}

// ---------------------------------------------------------------- export + AI
function exportXlsx(){
  if(typeof XLSX === 'undefined') return;
  const rows = filtered(), wb = XLSX.utils.book_new();
  const a = rows.map(r => ({'PIC': r.pic, 'SKU': r.sku, 'Product': r.name, 'Main PL': r.pl, 'Sub PL': r.subPl, 'Lifecycle': r.lifecycle, 'Inv AMZ': r.amz, 'Inv Y4A': r.y4a,
    'Sales / week (4w)': r.act4 == null ? '' : +r.act4.toFixed(1), 'Forecast / week (4w)': r.fc4 == null ? '' : +r.fc4.toFixed(1), 'Model': r.model, 'Backtest accuracy': r.acc == null ? '' : +r.acc.toFixed(3),
    'WOC AMZ': r.woc == null ? '' : +r.woc.toFixed(1), 'WOC total': r.wocT == null ? '' : +r.wocT.toFixed(1), 'OOS week (AMZ)': r.oosWk === null ? '' : IV.weeks[r.oosWk], 'Lost units (16w)': Math.round(r.lost),
    'Next AMZ ETA': r.nA ? r.nA.eta : '', 'Next AMZ qty': r.nA ? r.nA.qty : '', 'Next Y4A ETA': r.nY ? r.nY.eta : '', 'Next Y4A qty': r.nY ? r.nY.qty : '',
    'Incoming AMZ': r.incAmzTot, 'Incoming Y4A': r.incY4aTot, 'Units ETA slipped': r.delayQty, 'Max slip days': r.maxSlip, 'Units past ETA': r.overdueQty, 'Risk': r.risk, 'Suggestion': r.why.join(' · '),
    ...Object.fromEntries(IV.weeks.map((w, i) => ['Proj AMZ ' + w, r.fcW ? Math.round(r.pA.p[i]) : '']))}));
  const keep = new Set(rows.map(r => r.sku));
  const b = IV.lines.filter(l => keep.has(l.sku)).map(l => ({'Source': l.source, 'Country': l.country, 'Channel / WH': l.channel, 'SKU': l.sku, 'ASIN': l.asin, 'Qty': l.qty,
    'Physical status': l.physical_status, 'On-time status': l.on_time_status, 'Ordered': l.ordered_date, 'Container': l.container_number, 'Expected ship': l.expected_ship_date, 'Actual ship': l.actual_ship_date,
    'ETA POD': l.eta_pod, 'ETA salable original': l.eta_salable_original, 'ETA salable now': l.eta_salable_date, 'ETA used': l.eta, 'Slip days': l.slip, 'Days past ETA': l.overdue, 'Product line': l.product_line}));
  if(a.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(a), 'SKU tracking');
  if(b.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(b), 'Incoming lines');
  if(wb.SheetNames.length) XLSX.writeFile(wb, `Yes4All_Inventory_Tracking_${IV.country}_${IV.logDate}.xlsx`);
}
async function askAi(force){
  const h = H(), out = document.getElementById('ivAiOut'), rows = filtered();
  const pick = rows.filter(r => r.riskRank <= 4 || r.risk === 'Tồn cao').sort((a, b) => a.riskRank - b.riskRank || (a.oosWk ?? 99) - (b.oosWk ?? 99)).slice(0, 40);
  const context = {
    market: IV.country, file_date: IV.logDate, eta_mode: IV.etaMode === 'safe' ? 'ETA + độ trễ trung bình theo trạng thái' : 'ETA trong file',
    definitions: {AMZ: 'hàng về kho Amazon (AVC), không kéo sớm được', Y4A: 'hàng về kho Y4A, có thể request kéo về sớm', 'delay vs expected': 'ETA hiện tại lùi so với ETA ban đầu', 'delay vs current': 'đã quá ETA mà chưa thành sellable', woc: 'tuần tồn AMZ / forecast tuần', oos_week: 'tuần tồn AMZ dự phóng không đủ forecast'},
    kpis: document.getElementById('ivKpis').innerText.replace(/\n+/g, ' | '),
    skus: pick.map(r => ({sku: r.sku, name: r.name.slice(0, 60), pl: r.pl, pic: r.pic, inv_amz: r.amz, inv_y4a: r.y4a, sales_wk: r.act4 == null ? null : +r.act4.toFixed(1),
      fc_wk: r.fc4 == null ? null : +r.fc4.toFixed(1), model: r.model, woc: r.woc == null ? null : +r.woc.toFixed(1), oos_week: r.oosWk === null ? null : IV.weeks[r.oosWk], lost_units_16w: Math.round(r.lost),
      next_amz: r.nA ? {eta: r.nA.eta, qty: r.nA.qty, status: r.nA.on_time_status} : null, next_y4a: r.nY ? {eta: r.nY.eta, qty: r.nY.qty, container: r.nY.container_number} : null,
      units_slipped: r.delayQty, max_slip_days: r.maxSlip, units_past_eta: r.overdueQty, risk: r.risk})),
  };
  const question = `Bạn là chuyên gia supply chain + Amazon Vendor (AVC) của Yes4All. Dựa trên dữ liệu tồn kho, incoming và forecast dưới đây (ETA của nhà máy/forwarder thường bị trễ), hãy:
1) Liệt kê tối đa 8 hành động ưu tiên: SKU nào cần kéo hàng Y4A về sớm / đẩy tồn Y4A sang Amazon, SKU nào có hàng quá ETA cần follow-up gấp, SKU nào nên giảm ads/promo để giữ tồn, SKU nào tồn cao cần đẩy bán hoặc dời hàng về.
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
    out.innerHTML = `<b>Chưa gọi được AI:</b> ${h.esc(e.message || e)}<br><span style="color:var(--muted)">Cần Edge Function <code>ai-recommend</code> và secret <code>ANTHROPIC_API_KEY</code> (xem README). Cột "Gợi ý" theo rule vẫn chạy bình thường.</span>`;
  }
}

// styles
if(typeof document !== 'undefined'){
  const css = document.createElement('style');
  css.textContent = `.iv-kpis{grid-template-columns:repeat(6,minmax(0,1fr))}
#ivTable .vs,#ivGrid .vs{font-size:10.5px;color:var(--muted);display:block}
#ivGrid{border-collapse:separate;border-spacing:0}
#ivGrid th,#ivGrid td{white-space:nowrap}
#ivGrid .g-wk{min-width:64px;text-align:center}
#ivGrid td.g-c{text-align:center;font-size:12px}
#ivGrid .g-a{display:block;color:#2a78d6;font-weight:800}
#ivGrid .g-y{display:block;color:#1baf7a;font-weight:800}
#ivGrid td.g-dl{background:#FFF6DB}
#ivGrid td.g-od{background:#FDE8E8}
#ivGrid .g-sku,#ivGrid .g-pl,#ivGrid .g-inv,#ivGrid .g-inv2{position:sticky;z-index:1;background:var(--card,#fff)}
#ivGrid thead .g-sku,#ivGrid thead .g-pl,#ivGrid thead .g-inv,#ivGrid thead .g-inv2{z-index:3;background:var(--navy)}
#ivGrid .g-sku{left:0;min-width:150px;max-width:150px;overflow:hidden}
#ivGrid .g-pl{left:150px;min-width:150px;max-width:150px;overflow:hidden;white-space:normal}
#ivGrid .g-inv{left:300px;min-width:72px}
#ivGrid .g-inv2{left:372px;min-width:72px;box-shadow:2px 0 0 var(--line)}
#ivGrid tbody tr{cursor:pointer}
#ivGrid tbody tr:hover td{filter:brightness(.97)}
#ivGrid tr.sel td.g-sku{background:#FFF3EA}
#ivTable tr.sel td,#ivPicTable tr.sel td{background:#FFF3EA}
#ivPicTable tbody tr:hover td{background:#F7F9FC}
#ivTable tbody tr:hover td{background:#F7F9FC}
@media (max-width:1100px){.iv-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
  document.head.appendChild(css);
}
INV._state = IV; INV._compute = compute;
})();
