// =====================================================================
// Inventory Tracking tab — tồn kho, incoming (ETA mới), trễ hàng, forecast
//
// Data (supabase_inventory_tracking.sql), loaded from "For_Sales_Incoming_Tracker.xlsx"
// with the Upload button of this tab:
//   incoming_detail     01_AMZ_incoming_details (source AMZ: hàng về kho Amazon, AVC)
//                       02_Y4A_incoming_details (source Y4A: hàng về kho mình, kéo sớm được)
//   inventory_sellable  06_ USA_Sellable INV + 07_INT Sellable INV (tồn Y4A / AMZ per SKU)
//   amz_inventory_asin  04_AMZ_sellable details (Vendor Central per ASIN)
//   incoming_eta_log    USA lines of every upload → ETA history
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
// Excel serial (or Date / ISO string) → yyyy-mm-dd; time-only cells (serial < 1) are empty
function xlDate(v){
  if(v == null || v === '') return null;
  if(typeof v === 'number') return v < 1 ? null : iso(new Date(Math.round((Math.floor(v) - 25569) * DAY)));
  if(v instanceof Date) return isNaN(v) ? null : iso(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())));
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : null;
}
const xlNum = v => v == null || v === '' || isNaN(+v) ? null : +v;
const xlTxt = v => { if(v == null) return null; const s = String(v).trim(); return s && !/^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?)$/.test(s) ? s : null; };

// ---------------------------------------------------------------- parse the workbook
// wb = SheetJS workbook read with {cellDates:false}. Returns {kind: rows[]} for inv_upload.
INV.parseWorkbook = function(wb, XL){
  XL = XL || root.XLSX;
  const find = re => wb.SheetNames.find(n => re.test(n.trim()));
  const objs = name => name ? XL.utils.sheet_to_json(wb.Sheets[name], {raw:true, defval:null}) : [];
  const out = {}, warn = [];
  const inc = (name, src) => objs(name).map(r => ({
    log_date: xlDate(r.log_date), country: xlTxt(r.country), channel: xlTxt(src === 'AMZ' ? r.channel : r.warehouse), po_type: xlTxt(r.po_type),
    po_name: xlTxt(r.po_name), vendor_code: xlTxt(r.vendor_code), sku: xlTxt(r.sku), asin: xlTxt(r.asin), qty: xlNum(src === 'AMZ' ? r.qty_incoming : r.incoming_qty),
    eta_salable_date: xlDate(r.eta_salable_date), eta_salable_original: xlDate(r.eta_salable_original), physical_status: xlTxt(r.physical_status),
    on_time_status: xlTxt(r.on_time_status), ordered_date: xlDate(r.ordered_date), container_number: xlTxt(r.container_number), container_type: xlTxt(r.container_type),
    expected_ship_date: xlDate(r.expected_ship_date), actual_ship_date: xlDate(r.actual_ship_date), etd_pol: xlDate(r.etd_pol), atd_pol: xlDate(r.atd_pol),
    eta_pod: xlDate(r.eta_pod), ata_pod: xlDate(src === 'AMZ' ? r.actual_port_arrival : r.ata_pod), department: xlTxt(r.department ?? r.dept),
    product_name: xlTxt(r.product_name), product_line: xlTxt(r.product_line), selling_type: xlTxt(r.selling_type), incoming_week: xlTxt(r.incoming_week),
  })).filter(r => r.sku && r.po_name && r.country && r.log_date);
  const sA = find(/^01_?AMZ_incoming/i), sY = find(/^02_?Y4A_incoming/i);
  if(sA) out.amz_incoming = inc(sA, 'AMZ'); else warn.push('Không thấy sheet 01_AMZ_incoming_details');
  if(sY) out.y4a_incoming = inc(sY, 'Y4A'); else warn.push('Không thấy sheet 02_Y4A_incoming_details');
  // 06 / 07: row 1 holds the as-of dates of inv_y4a / inv_amz, row 2 the header
  const sell = [];
  [find(/^06_?\s*USA_?Sellable/i), find(/^07_?\s*INT_?Sellable/i)].forEach(name => {
    if(!name) return;
    const a = XL.utils.sheet_to_json(wb.Sheets[name], {header:1, raw:true, defval:null});
    const hi = a.findIndex(r => r && r.includes('sku') && r.includes('inv_amz')); if(hi < 0) return;
    const h = a[hi], c = k => h.indexOf(k), top = a[hi - 1] || [];
    const y4aAt = xlDate(top[c('inv_y4a')]), amzAt = xlDate(top[c('inv_amz')]);
    for(const r of a.slice(hi + 1)){
      const sku = xlTxt(r[c('sku')]), country = xlTxt(r[c('country')]); if(!sku || !country) continue;
      sell.push({country, sku, product_name: xlTxt(r[c('product_name')]), department: xlTxt(r[c('department')]),
        inv_y4a: xlNum(r[c('inv_y4a')]) || 0, inv_amz: xlNum(r[c('inv_amz')]) || 0, y4a_as_of: y4aAt, amz_as_of: amzAt});
    }
  });
  if(sell.length) out.inventory_sellable = sell; else warn.push('Không thấy sheet 06/07 Sellable INV');
  const sZ = find(/^04_?AMZ_sellable/i);
  if(sZ) out.amz_asin = objs(sZ).map(r => ({
    country: xlTxt(r.country), asin: xlTxt(r.asin), sku: xlTxt(r.SKU ?? r.sku), department: xlTxt(r.Department ?? r.department), log_date: xlDate(r.log_date), currency: xlTxt(r.currency),
    sellable_on_hand_units: xlNum(r.sellable_on_hand_inventory_units), sellable_on_hand_value: xlNum(r.sellable_on_hand_inventory_value),
    sellable_in_transit_units: xlNum(r.sellable_in_transit_units), unsellable_on_hand_units: xlNum(r.unsellable_on_hand_inventory_units),
    in_transit_units: xlNum(r.in_transit_units), open_po_units: xlNum(r.open_purchase_order_units), total_sellable: xlNum(r['Total sellable']),
    net_received_units: xlNum(r.net_received_inventory_units), unfilled_customer_ordered_units: xlNum(r.unfilled_customer_ordered_units),
    confirmed_units: xlNum(r.confirmed_units), aged_90_units: xlNum(r.aged_90_plus_days_sellable_inventory_units),
    procurable_oos_rate: xlNum(r.procurable_product_oos_rate), sourceable_oos_rate: xlNum(r.sourceable_product_oos_rate),
    vendor_confirmation_rate: xlNum(r.vendor_confirmation_rate), receive_fill_rate: xlNum(r.receive_fill_rate), vendor_lead_time_days: xlNum(r.overall_vendor_lead_time_days),
  })).filter(r => r.asin && r.country);
  return {rows: out, warn};
};

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
const IV = {country: 'USA', scope: 'team', pic: '', pl: '', risk: '', status: '', src: '', q: '', etaMode: 'file',
  data: null, loadedFor: null, sales: null, rows: [], po: [], sort: 'riskRank', dir: 1, poSort: 'sev', poDir: -1, sel: null};
const HZN = 16;   // projection weeks
const COUNTRIES = ['USA','CAN','MEX','GBR','DEU','FRA','ITA','ESP','JPN','AUS','ARE','SAU','GPE','BRA'];
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
  const inScope = sku => IV.scope === 'all' || !!h.skuInfo(sku);
  const sell = new Map(D.sell.map(r => [r.sku, r]));
  const asinBy = new Map(); D.asin.forEach(r => { if(!r.sku) return; if(!asinBy.has(r.sku)) asinBy.set(r.sku, []); asinBy.get(r.sku).push(r); });
  const lines = D.inc.map(r => {
    const slip = r.eta_salable_original && r.eta_salable_date ? daysBetween(r.eta_salable_original, r.eta_salable_date) : null;
    const overdue = r.eta_salable_date && r.eta_salable_date < r.log_date ? daysBetween(r.eta_salable_date, r.log_date) : 0;
    return {...r, qty: +r.qty || 0, slip, overdue, eta: etaOf(r, r.log_date, buf)};
  });
  IV.lines = lines;
  const bySku = new Map(); lines.forEach(l => { if(!bySku.has(l.sku)) bySku.set(l.sku, []); bySku.get(l.sku).push(l); });
  const skus = new Set([...bySku.keys(), ...D.sell.filter(r => (+r.inv_amz || 0) + (+r.inv_y4a || 0) > 0).map(r => r.sku)]);
  const S = IV.country === 'USA' ? IV.sales : null;
  const rows = [];
  for(const sku of skus){
    if(!inScope(sku)) continue;
    const k = h.skuInfo(sku) || {}, s = sell.get(sku) || {}, L = bySku.get(sku) || [];
    const amz = Math.max(0, +s.inv_amz || 0), y4a = Math.max(0, +s.inv_y4a || 0);
    const incA = Array(HZN).fill(0), incY = Array(HZN).fill(0); let beyondA = 0, beyondY = 0;
    L.forEach(l => { const i = Math.floor(daysBetween(wk0, l.eta) / 7); if(i >= HZN){ if(l.source === 'AMZ') beyondA += l.qty; else beyondY += l.qty; return; }
      (l.source === 'AMZ' ? incA : incY)[Math.max(0, i)] += l.qty; });
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
      why.push(`AMZ hết hàng tuần ${md(weeks[pA.oosWk])}` + (nA ? `, hàng AMZ kế tiếp ${md(nA.eta)}` : ', chưa có PO AMZ'));
      if(y4a > 0) why.push(`Tồn Y4A ${Math.round(y4a)}: đẩy PO WH / DI sang Amazon`);
      const yEarly = L.filter(l => l.source === 'Y4A' && (!nA || l.eta < nA.eta));
      if(yEarly.length) why.push(`Y4A về ${md(yEarly[0].eta)} (${yEarly[0].po_name}) sớm hơn AMZ: request kéo hàng về sớm`);
      else if(nY) why.push(`Container Y4A ${nY.container_number || nY.po_name} ETA ${md(nY.eta)}: hỏi kéo sớm`);
      if(rank === 1) why.push('Giảm ads / promo để giữ tồn tới khi hàng về');
    } else if(od.length){ rank = 3; risk = 'PO quá ETA'; why.push(`${od.length} dòng PO đã quá ETA (${Math.round(sum(od))} units): follow-up Amazon / forwarder`); }
    else if(dl.length && sum(dl) > 0){ rank = 4; risk = 'ETA bị lùi'; why.push(`ETA lùi tối đa ${Math.max(...dl.map(l => l.slip || 0))} ngày trên ${Math.round(sum(dl))} units`); }
    if(fc4 > 0 && wocT > 26){ if(rank >= 4){ rank = 4; risk = 'Tồn cao'; } why.push(`Tồn + hàng về đủ ~${Math.round(wocT)} tuần: cân nhắc dời PO / đẩy bán`); }
    if(!fcW && (amz + y4a) > 0 && rank === 5){ risk = 'Chưa có forecast'; rank = 6; }
    rows.push({sku, name: k.productName || s.product_name || (L[0] || {}).product_name || '', pl: (L[0] || {}).product_line || k.mainPL || '', pic: k.pic || '',
      dept: s.department || (L[0] || {}).department || '', amz, y4a, incA, incY, beyondA, beyondY,
      incAmzTot: sum(L.filter(l => l.source === 'AMZ')), incY4aTot: sum(L.filter(l => l.source === 'Y4A')),
      delayQty: sum(dl), overdueQty: sum(od), maxSlip: dl.length ? Math.max(...dl.map(l => l.slip || 0)) : 0, maxOverdue: od.length ? Math.max(...od.map(l => l.overdue)) : 0,
      nA, nY, f, hist, fcW, fc4, act4, woc, wocT, pA, pT, risk, why, riskRank: rank, firstInc, lines: L, asins: asinBy.get(sku) || [],
      oosWk: pA.oosWk, lost: pA.lost, model: f ? f.model : '', acc: f && f.wape != null ? Math.max(0, 1 - f.wape) : null});
  }
  IV.rows = rows;
  // PO × container view
  const g = new Map();
  lines.forEach(l => { if(!inScope(l.sku)) return; const key = l.source + '|' + l.po_name + '|' + (l.container_number || '');
    const a = g.get(key) || {source: l.source, po: l.po_name, container: l.container_number || '', channel: l.channel, qty: 0, skus: new Set(), status: new Set(), phys: new Set(), eta: null, orig: null, slip: 0, overdue: 0, lines: 0};
    a.qty += l.qty; a.skus.add(l.sku); a.status.add(l.on_time_status); a.phys.add(l.physical_status); a.lines++;
    if(!a.eta || l.eta_salable_date > a.eta) a.eta = l.eta_salable_date; if(l.eta_salable_original && (!a.orig || l.eta_salable_original < a.orig)) a.orig = l.eta_salable_original;
    a.slip = Math.max(a.slip, l.slip || 0); a.overdue = Math.max(a.overdue, l.overdue); g.set(key, a); });
  IV.po = [...g.values()].map(a => ({...a, skuN: a.skus.size, skuList: [...a.skus].join(', '), st: a.status.has('delay vs current') ? 'delay vs current' : a.status.has('delay vs expected') ? 'delay vs expected' : 'normal',
    physical: [...a.phys].join(' / '), sev: (a.status.has('delay vs current') ? 2000 + a.overdue : a.status.has('delay vs expected') ? 1000 + a.slip : 0)}));
}

// ---------------------------------------------------------------- render
INV.render = async function(){
  const host = document.getElementById('view-inv'); if(!host) return;
  const h = H();
  if(!host.dataset.built){ build(host); host.dataset.built = '1'; }
  if(!IV.data || IV.loadedFor !== IV.country){
    host.querySelector('#ivBody').innerHTML = '<tr><td colspan="18" style="padding:18px;color:var(--muted)">Đang tải tồn kho, incoming' + (IV.country === 'USA' ? ' và số bán để forecast' : '') + '…</td></tr>';
    try { await load(); }
    catch(e){ IV.data = null; host.querySelector('#ivBody').innerHTML = `<tr><td colspan="18" style="padding:18px;color:var(--muted)">${h.missingSchema(e) ? 'Chưa có bảng: chạy <b>supabase_inventory_tracking.sql</b> trong SQL Editor, rồi bấm <b>⬆ Upload file tracker</b>.' : 'Không tải được: ' + h.esc(e.message || e)}</td></tr>`; return; }
    compute();
    const pics = [...new Set(IV.rows.map(r => r.pic).filter(Boolean))].sort(), pls = [...new Set(IV.rows.map(r => r.pl).filter(Boolean))].sort();
    host.querySelector('#ivPic').innerHTML = '<option value="">All</option>' + pics.map(p => `<option ${p === IV.pic ? 'selected' : ''}>${h.esc(p)}</option>`).join('');
    host.querySelector('#ivPl').innerHTML = '<option value="">All</option>' + pls.map(p => `<option ${p === IV.pl ? 'selected' : ''}>${h.esc(p)}</option>`).join('');
  }
  paint();
};
function build(host){
  host.innerHTML = `<div class="filterbar">
      <div class="fld"><label for="ivCountry">Thị trường</label><select id="ivCountry">${COUNTRIES.map(c => `<option ${c === IV.country ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="fld"><label for="ivScope">Phạm vi SKU</label><select id="ivScope"><option value="team">SKU của team</option><option value="all">Tất cả SKU trong file</option></select></div>
      <div class="fld"><label for="ivPic">PIC</label><select id="ivPic"><option value="">All</option></select></div>
      <div class="fld"><label for="ivPl">Product line</label><select id="ivPl"><option value="">All</option></select></div>
      <div class="fld"><label for="ivRisk">Rủi ro</label><select id="ivRisk"><option value="">All</option><option>OOS ≤2 tuần</option><option>OOS trong 8 tuần</option><option>PO quá ETA</option><option>ETA bị lùi</option><option>Tồn cao</option><option>OK</option></select></div>
      <div class="fld"><label for="ivEta">ETA dùng để dự phóng</label><select id="ivEta"><option value="file">ETA trong file</option><option value="safe">ETA thận trọng (+ độ trễ TB)</option></select></div>
      <div class="fld"><label for="ivQ">Tìm SKU / tên / PO / container</label><input id="ivQ" type="search" placeholder="VD: DXD3, USAWH…"></div>
      <div class="fld"><label>&nbsp;</label><button class="btn small" id="ivReload" type="button">↻ Tải lại</button></div>
      <div class="fld"><label>&nbsp;</label><button class="btn small" id="ivUpBtn" type="button">⬆ Upload file tracker</button></div>
    </div>
    <div class="card" id="ivUp" hidden>
      <h3 style="margin-top:0">Upload "For_Sales_Incoming_Tracker.xlsx"</h3>
      <div class="hint">File được đọc ngay trên trình duyệt; các sheet 01_AMZ_incoming_details, 02_Y4A_incoming_details, 04_AMZ_sellable details, 06_ USA_Sellable INV, 07_INT Sellable INV được ghi vào database (thay dữ liệu file cũ; lịch sử ETA của USA được giữ lại theo từng ngày log). Cần upload key (tạo trong SQL Editor, xem đầu file <code>supabase_inventory_tracking.sql</code>).</div>
      <div class="filterbar" style="box-shadow:none;margin:0">
        <div class="fld"><label for="ivFile">File</label><input id="ivFile" type="file" accept=".xlsx,.xlsm,.xls"></div>
        <div class="fld"><label for="ivKey">Upload key</label><input id="ivKey" type="password" autocomplete="off"></div>
        <div class="fld"><label for="ivWho">Người upload</label><input id="ivWho" type="text" placeholder="Tên"></div>
        <div class="fld"><label>&nbsp;</label><button class="btn small" id="ivGo" type="button">Tải lên</button></div>
      </div>
      <div id="ivUpMsg" class="hint" style="margin-top:8px"></div>
    </div>
    <div class="btr-src" id="ivSrc"></div>
    <div class="kpis iv-kpis" id="ivKpis"></div>
    <div class="btr-grid">
      <div class="card"><h3>Incoming theo tuần (theo ETA đang chọn)</h3><div class="hint">Xanh dương = về kho Amazon (AVC), xanh lá = về kho Y4A. Màu nhạt = ETA đã lùi so với ban đầu; đỏ = đã quá ETA mà chưa về (dồn vào tuần hiện tại).</div><div id="ivWeekly" class="plot"></div></div>
      <div class="card"><h3>Hàng trễ theo product line</h3><div class="hint">Units đang trễ: ETA lùi so với ban đầu, và đã quá ETA. Rê chuột để xem số PO và số ngày trễ.</div><div id="ivPlDelay" class="plot"></div></div>
      <div class="card"><h3>ETA bị lùi bao nhiêu ngày</h3><div class="hint">Phân bố số ngày ETA hiện tại − ETA ban đầu (theo units). Đây là "độ trễ TB" cộng thêm khi chọn ETA thận trọng.</div><div id="ivSlip" class="plot"></div></div>
      <div class="card"><h3>Hàng đang ở đâu</h3><div class="hint">Units incoming theo trạng thái vật lý (Pre-pipeline → In production → Pipeline → In land transit).</div><div id="ivPhys" class="plot"></div></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h3 style="margin:0">Theo dõi theo SKU</h3>
        <div style="display:flex;gap:8px"><button class="btn small" id="ivAi" type="button">🤖 AI phân tích &amp; đề xuất</button><button class="btn small" id="ivExport" type="button">&#128190; Export Excel</button></div></div>
      <div id="ivAiOut" class="ai-out" hidden style="white-space:pre-wrap;font-size:12.5px;background:#F7F9FC;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0"></div>
      <div class="hint">Tồn = sellable hiện tại. Bán/tuần = TB 4 tuần đủ gần nhất (sales_daily). Forecast/tuần = TB 4 tuần tới, mô hình tốt nhất của SKU (độ chính xác = 1 − WAPE backtest 8 tuần). WOC = số tuần tồn AMZ đủ bán (tổng AMZ + Y4A bên dưới). OOS = tuần tồn AMZ (cộng hàng AMZ về theo ETA) không đủ forecast. Bấm một dòng để xem dự phóng tuần, các PO và lịch sử ETA.</div>
      <div class="tablewrap" style="max-height:640px"><table id="ivTable"><thead><tr>
        <th data-k="pic">PIC</th><th data-k="sku">SKU</th><th data-k="name">Product</th><th data-k="pl">Product line</th>
        <th data-k="amz" class="num">Tồn AMZ</th><th data-k="y4a" class="num">Tồn Y4A</th><th data-k="act4" class="num">Bán / tuần</th><th data-k="fc4" class="num">Forecast / tuần</th>
        <th data-k="woc" class="num">WOC</th><th data-k="oosWk" class="num">OOS (AMZ)</th>
        <th data-k="nAeta">Hàng AMZ kế tiếp</th><th data-k="nYeta">Hàng Y4A kế tiếp</th>
        <th data-k="incAmzTot" class="num">Incoming AMZ</th><th data-k="incY4aTot" class="num">Incoming Y4A</th>
        <th data-k="delayQty" class="num">Units ETA lùi</th><th data-k="overdueQty" class="num">Units quá ETA</th>
        <th data-k="riskRank">Rủi ro</th><th data-k="whyTxt">Gợi ý</th>
      </tr></thead><tbody id="ivBody"></tbody></table></div>
    </div>
    <div class="card" id="ivDetail" hidden></div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h3 style="margin:0">PO / container đang trễ</h3>
        <div class="fld" style="display:flex;gap:8px;align-items:center"><select id="ivPoSt"><option value="">Mọi trạng thái</option><option value="delay vs current">Quá ETA, chưa về</option><option value="delay vs expected">ETA lùi so với ban đầu</option><option value="normal">Đúng hạn</option></select>
        <select id="ivPoSrc"><option value="">AMZ + Y4A</option><option value="AMZ">Về kho Amazon</option><option value="Y4A">Về kho Y4A</option></select></div></div>
      <div class="hint">Gộp theo PO × container. ETA ban đầu → ETA hiện tại; "lùi" = số ngày ETA bị dời; "quá hạn" = số ngày đã qua ETA mà chưa về. Hàng Y4A (kho mình) có thể request kéo về sớm.</div>
      <div class="tablewrap" style="max-height:520px"><table id="ivPoTable"><thead><tr>
        <th data-k="source">Kho đến</th><th data-k="po">PO</th><th data-k="container">Container</th><th data-k="channel">Kênh / kho</th><th data-k="skuN" class="num">SKU</th>
        <th data-k="qty" class="num">Units</th><th data-k="physical">Trạng thái</th><th data-k="orig">ETA ban đầu</th><th data-k="eta">ETA hiện tại</th>
        <th data-k="slip" class="num">Lùi (ngày)</th><th data-k="overdue" class="num">Quá hạn (ngày)</th><th data-k="sev">Tình trạng</th>
      </tr></thead><tbody id="ivPoBody"></tbody></table></div>
    </div>`;
  const $ = s => host.querySelector(s), re = () => paint();
  $('#ivCountry').onchange = e => { IV.country = e.target.value; IV.scope = IV.country === 'USA' ? IV.scope : 'all'; $('#ivScope').value = IV.scope; IV.sel = null; INV.render(); };
  $('#ivScope').onchange = e => { IV.scope = e.target.value; compute(); re(); };
  $('#ivPic').onchange = e => { IV.pic = e.target.value; re(); };
  $('#ivPl').onchange = e => { IV.pl = e.target.value; re(); };
  $('#ivRisk').onchange = e => { IV.risk = e.target.value; re(); };
  $('#ivEta').onchange = e => { IV.etaMode = e.target.value; compute(); re(); };
  $('#ivQ').oninput = e => { IV.q = e.target.value.trim().toLowerCase(); re(); };
  $('#ivPoSt').onchange = e => { IV.status = e.target.value; re(); };
  $('#ivPoSrc').onchange = e => { IV.src = e.target.value; re(); };
  $('#ivReload').onclick = () => { IV.data = null; IV.sales = null; INV.render(); };
  $('#ivUpBtn').onclick = () => { $('#ivUp').hidden = !$('#ivUp').hidden; };
  $('#ivGo').onclick = upload;
  $('#ivExport').onclick = exportXlsx;
  $('#ivAi').onclick = () => askAi(false);
  try { $('#ivWho').value = localStorage.getItem('ivWho') || ''; } catch(_){}
  host.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; if(IV.sort === k) IV.dir *= -1; else { IV.sort = k; IV.dir = ['pic','sku','name','pl','riskRank','oosWk','nAeta','nYeta','whyTxt'].includes(k) ? 1 : -1; } re(); });
  host.querySelectorAll('#ivPoTable thead th[data-k]').forEach(th => th.onclick = () => { const k = th.dataset.k; if(IV.poSort === k) IV.poDir *= -1; else { IV.poSort = k; IV.poDir = ['source','po','container','channel','physical','orig','eta'].includes(k) ? 1 : -1; } re(); });
}
function filtered(){
  return IV.rows.filter(r => (!IV.pic || r.pic === IV.pic) && (!IV.pl || r.pl === IV.pl) && (!IV.risk || r.risk === IV.risk) &&
    (!IV.q || [r.sku, r.name, r.pl, ...r.lines.map(l => l.po_name + ' ' + (l.container_number || ''))].join(' ').toLowerCase().includes(IV.q)));
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
    (IV.sales && IV.country === 'USA' ? `<span>Số bán để forecast: tới <b>${md(IV.sales.lastSat)}</b> (tuần đủ, ${IV.sales.weeks.length} tuần)</span>` : `<span>Forecast chỉ có cho USA (số bán là Amazon US)</span>`) +
    (up ? `<span>Upload lần cuối: <b>${h.esc(String(up.uploaded_at).slice(0, 16).replace('T', ' '))}</b>${up.uploaded_by ? ' · ' + h.esc(up.uploaded_by) : ''}${up.file_name ? ' · ' + h.esc(up.file_name) : ''}</span>` : '<span>Chưa có upload nào: bấm <b>⬆ Upload file tracker</b></span>');
  // KPIs
  const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
  const dl = lines.filter(l => l.on_time_status === 'delay vs expected'), od = lines.filter(l => l.on_time_status === 'delay vs current');
  const pos = a => new Set(a.map(l => l.po_name)).size;
  const tot = sum(lines, l => l.qty), slipAvg = sum(dl, l => (l.slip || 0) * l.qty) / (sum(dl, l => l.qty) || 1), odAvg = sum(od, l => l.overdue * l.qty) / (sum(od, l => l.qty) || 1);
  const oos2 = rows.filter(r => r.risk === 'OOS ≤2 tuần').length, oos8 = rows.filter(r => r.risk === 'OOS trong 8 tuần').length;
  const accRows = rows.filter(r => r.acc != null && r.fc4 > 0), acc = sum(accRows, r => r.acc * r.fc4) / (sum(accRows, r => r.fc4) || 1);
  const mix = {}; accRows.forEach(r => mix[r.model] = (mix[r.model] || 0) + 1);
  document.getElementById('ivKpis').innerHTML = [
    ['Incoming', fi(tot) + ' u', `${pos(lines)} PO · ${new Set(lines.map(l => l.sku)).size} SKU · AMZ ${fi(sum(lines.filter(l => l.source === 'AMZ'), l => l.qty))} / Y4A ${fi(sum(lines.filter(l => l.source === 'Y4A'), l => l.qty))}`],
    ['ETA lùi so với ban đầu', fi(sum(dl, l => l.qty)) + ' u', `${tot ? (sum(dl, l => l.qty) / tot * 100).toFixed(0) : 0}% units · ${pos(dl)} PO · lùi TB ${slipAvg.toFixed(0)} ngày`],
    ['Quá ETA, chưa về', fi(sum(od, l => l.qty)) + ' u', `${pos(od)} PO · ${new Set(od.map(l => l.sku)).size} SKU · quá TB ${odAvg.toFixed(0)} ngày`],
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
  const byPl = new Map(); lines.forEach(l => { if(l.on_time_status === 'normal') return; const a = byPl.get(l.product_line || '—') || {d: 0, o: 0, po: new Set(), slip: 0}; if(l.on_time_status === 'delay vs current') a.o += l.qty; else a.d += l.qty; a.po.add(l.po_name); a.slip = Math.max(a.slip, l.slip || 0, l.overdue); byPl.set(l.product_line || '—', a); });
  const pl = [...byPl.entries()].sort((a, b) => (a[1].d + a[1].o) - (b[1].d + b[1].o)).slice(-14);
  if(pl.length) h.draw('ivPlDelay', [
    {type: 'bar', orientation: 'h', y: pl.map(p => p[0]), x: pl.map(p => p[1].d), name: 'ETA lùi', marker: {color: C.warn}, customdata: pl.map(p => [p[1].po.size, p[1].slip]), hovertemplate: 'ETA lùi: %{x:,.0f} u · %{customdata[0]} PO · tối đa %{customdata[1]} ngày<extra></extra>'},
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
  // SKU table
  rows.forEach(r => { r.nAeta = r.nA ? r.nA.eta : '9999'; r.nYeta = r.nY ? r.nY.eta : '9999'; r.whyTxt = r.why.join(' · '); });
  const val = (r, k) => k === 'oosWk' ? (r.oosWk === null ? 999 : r.oosWk) : k === 'riskRank' ? r.riskRank * 1000 + (r.oosWk === null ? 999 : r.oosWk) : r[k];
  const tr = [...rows].sort((a, b) => { const va = val(a, IV.sort), vb = val(b, IV.sort); return typeof va === 'string' || typeof vb === 'string' ? IV.dir * String(va ?? '').localeCompare(String(vb ?? '')) : IV.dir * ((va ?? -1e18) - (vb ?? -1e18)); });
  const badge = r => `<span class="badge ${r.riskRank <= 2 ? 'red' : r.riskRank <= 3 ? 'amber' : r.risk === 'OK' ? 'green' : 'gray'}">${h.esc(r.risk)}</span>`;
  const nxt = l => l ? `${md(l.eta)}<span class="vs">${fi(l.qty)} u · ${h.esc(l.physical_status || '')}${l.on_time_status !== 'normal' ? ' · <b style="color:var(--red)">' + (l.on_time_status === 'delay vs current' ? 'quá ETA' : 'lùi ' + (l.slip || 0) + 'n') + '</b>' : ''}</span>` : '—';
  document.getElementById('ivBody').innerHTML = tr.slice(0, 600).map(r => `<tr class="main${IV.sel === r.sku ? ' sel' : ''}" data-sku="${h.esc(r.sku)}" style="cursor:pointer">
      <td>${h.esc(r.pic)}</td><td><b>${h.esc(r.sku)}</b></td><td class="name-cell" title="${h.esc(r.name)}">${h.esc(r.name)}</td><td>${h.esc(r.pl)}</td>
      <td class="num">${fi(r.amz)}</td><td class="num">${fi(r.y4a)}</td><td class="num">${r.act4 == null ? '—' : r.act4.toFixed(1)}</td>
      <td class="num" title="${r.f ? 'Mô hình ' + r.model + (r.acc != null ? ' · chính xác ' + (r.acc * 100).toFixed(0) + '%' : '') : ''}">${r.fc4 == null ? '—' : r.fc4.toFixed(1)}<span class="vs">${h.esc(r.model)}${r.acc != null ? ' · ' + (r.acc * 100).toFixed(0) + '%' : ''}</span></td>
      <td class="num">${r.woc == null ? '—' : r.woc > 99 ? '>99' : r.woc.toFixed(1)}<span class="vs">tổng ${r.wocT == null ? '—' : r.wocT > 99 ? '>99' : r.wocT.toFixed(1)}</span></td>
      <td class="num">${r.oosWk === null ? (r.fcW ? '—' : '') : `<b style="color:var(--red)">${md(IV.weeks[r.oosWk])}</b><span class="vs">mất ~${fi(r.lost)} u</span>`}</td>
      <td>${nxt(r.nA)}</td><td>${nxt(r.nY)}</td>
      <td class="num">${fi(r.incAmzTot)}</td><td class="num">${fi(r.incY4aTot)}</td>
      <td class="num">${r.delayQty ? fi(r.delayQty) + `<span class="vs">tối đa ${r.maxSlip}n</span>` : '—'}</td>
      <td class="num">${r.overdueQty ? `<b style="color:var(--red)">${fi(r.overdueQty)}</b><span class="vs">${r.maxOverdue}n</span>` : '—'}</td>
      <td>${badge(r)}</td><td style="min-width:240px;font-size:11.5px">${r.why.map(w => '• ' + h.esc(w)).join('<br>')}</td></tr>`).join('')
    || '<tr><td colspan="18" style="padding:18px;color:var(--muted)">Không có SKU nào khớp bộ lọc' + (IV.data.inc.length ? '' : ' (chưa có dữ liệu: bấm ⬆ Upload file tracker)') + '.</td></tr>';
  document.querySelectorAll('#ivBody tr[data-sku]').forEach(t => t.onclick = () => { IV.sel = IV.sel === t.dataset.sku ? null : t.dataset.sku; paint(); detail(); });
  document.querySelectorAll('#ivTable thead th[data-k]').forEach(th => th.setAttribute('aria-sort', th.dataset.k === IV.sort ? (IV.dir > 0 ? 'ascending' : 'descending') : 'none'));
  // PO table
  const po = IV.po.filter(p => [...p.skus].some(s => keep.has(s)) && (!IV.status || p.st === IV.status) && (!IV.src || p.source === IV.src))
    .sort((a, b) => { const va = a[IV.poSort], vb = b[IV.poSort]; return typeof va === 'string' || typeof vb === 'string' ? IV.poDir * String(va ?? '').localeCompare(String(vb ?? '')) : IV.poDir * ((va ?? -1e18) - (vb ?? -1e18)); });
  document.getElementById('ivPoBody').innerHTML = po.slice(0, 500).map(p => `<tr>
      <td>${p.source === 'AMZ' ? 'Amazon' : '<b style="color:var(--green)">Y4A</b>'}</td><td><b>${h.esc(p.po)}</b></td><td>${h.esc(p.container || '—')}</td><td>${h.esc(p.channel || '')}</td>
      <td class="num" title="${h.esc(p.skuList)}">${p.skuN}</td><td class="num">${fi(p.qty)}</td><td>${h.esc(p.physical)}</td>
      <td>${md(p.orig)}</td><td>${md(p.eta)}</td><td class="num">${p.slip > 0 ? p.slip : '—'}</td><td class="num">${p.overdue > 0 ? `<b style="color:var(--red)">${p.overdue}</b>` : '—'}</td>
      <td><span class="badge ${p.st === 'delay vs current' ? 'red' : p.st === 'delay vs expected' ? 'amber' : 'green'}">${STATUS_VI[p.st] || h.esc(p.st)}</span></td></tr>`).join('')
    || '<tr><td colspan="12" style="padding:18px;color:var(--muted)">Không có PO nào khớp bộ lọc.</td></tr>';
  if(IV.sel) detail();
}

// one SKU: weekly projection, PO lines, ETA history, Vendor Central metrics
async function detail(){
  const h = H(), host = document.getElementById('ivDetail'), r = IV.rows.find(x => x.sku === IV.sel);
  if(!r){ host.hidden = true; return; }
  host.hidden = false;
  const fi = v => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('en-US');
  const W = IV.weeks, wl = W.map(md);
  const a0 = r.asins[0];
  host.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><h3 style="margin:0">${h.esc(r.sku)} · ${h.esc(r.name)}</h3><button class="btn small" type="button" id="ivDClose">Đóng</button></div>
    <div class="hint">${h.esc(r.pl)}${r.pic ? ' · PIC ' + h.esc(r.pic) : ''} · ${r.f ? `Forecast: ${h.esc(r.model)}${r.acc != null ? ', chính xác backtest ' + (r.acc * 100).toFixed(0) + '%' : ''} (so sánh: ${Object.entries(r.f.scores).sort((a, b) => a[1] - b[1]).map(([m, s]) => m + ' ' + Math.max(0, (1 - s) * 100).toFixed(0) + '%').join(', ')})` : 'Chưa có số bán để forecast'}
    ${r.asins.length ? '<br>Vendor Central: ' + r.asins.map(a => `${h.esc(a.asin)} — on hand ${fi(a.sellable_on_hand_units)}, in transit ${fi(a.sellable_in_transit_units)}, open PO ${fi(a.open_po_units)}, aged 90+ ${fi(a.aged_90_units)}, confirm ${a.vendor_confirmation_rate == null ? '—' : (a.vendor_confirmation_rate * 100).toFixed(0) + '%'}, fill ${a.receive_fill_rate == null ? '—' : (a.receive_fill_rate * 100).toFixed(0) + '%'}, OOS ${a.procurable_oos_rate == null ? '—' : (a.procurable_oos_rate * 100).toFixed(1) + '%'}`).join('<br>') : ''}</div>
    <div id="ivDPlot" class="plot" style="height:340px"></div>
    <div class="tablewrap" style="max-height:300px;margin-top:10px"><table><thead><tr><th>Kho đến</th><th>PO</th><th>Container</th><th class="num">Units</th><th>Trạng thái</th><th>Ngày đặt</th><th>Ship dự kiến</th><th>Ship thực tế</th><th>ETA cảng</th><th>ETA ban đầu</th><th>ETA hiện tại</th><th>ETA dùng</th><th>Tình trạng</th><th>Lịch sử ETA</th></tr></thead>
    <tbody id="ivDLines">${r.lines.sort((a, b) => a.eta < b.eta ? -1 : 1).map(l => `<tr><td>${l.source === 'AMZ' ? 'Amazon · ' + h.esc(l.channel || '') : 'Y4A · ' + h.esc(l.channel || '')}</td><td>${h.esc(l.po_name)}</td><td>${h.esc(l.container_number || '—')}</td><td class="num">${fi(l.qty)}</td><td>${h.esc(l.physical_status || '')}</td>
      <td>${md(l.ordered_date)}</td><td>${md(l.expected_ship_date)}</td><td>${md(l.actual_ship_date)}</td><td>${md(l.ata_pod || l.eta_pod)}</td><td>${md(l.eta_salable_original)}</td><td><b>${md(l.eta_salable_date)}</b></td><td>${md(l.eta)}</td>
      <td><span class="badge ${l.on_time_status === 'delay vs current' ? 'red' : l.on_time_status === 'delay vs expected' ? 'amber' : 'green'}">${STATUS_VI[l.on_time_status] || h.esc(l.on_time_status || '')}${l.slip > 0 ? ' +' + l.slip + 'n' : ''}${l.overdue ? ' · ' + l.overdue + 'n' : ''}</span></td><td class="hist" data-po="${h.esc(l.po_name)}" data-c="${h.esc(l.container_number || '')}">…</td></tr>`).join('') || '<tr><td colspan="14" style="color:var(--muted)">Không có hàng đang về.</td></tr>'}</tbody></table></div>`;
  host.querySelector('#ivDClose').onclick = () => { IV.sel = null; host.hidden = true; paint(); };
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
  // ETA history (USA keeps one row per upload)
  try {
    const hist = await h.selectAll('incoming_eta_log', q => q.eq('country', IV.country).eq('sku', r.sku).order('log_date'));
    host.querySelectorAll('td.hist').forEach(td => {
      const hs = hist.filter(x => x.po_name === td.dataset.po && x.container_number === td.dataset.c);
      const seq = []; hs.forEach(x => { if(!seq.length || seq[seq.length - 1].eta !== x.eta_salable_date) seq.push({at: x.log_date, eta: x.eta_salable_date}); });
      td.innerHTML = seq.length > 1 ? seq.map(s => `${md(s.eta)}<span style="color:var(--muted);font-size:10px"> (${md(s.at)})</span>`).join(' → ') : hs.length ? `<span style="color:var(--muted)">chưa đổi (${hs.length} lần upload)</span>` : '—';
    });
  } catch(_){ host.querySelectorAll('td.hist').forEach(td => td.textContent = '—'); }
}

// ---------------------------------------------------------------- upload
async function upload(){
  const h = H(), host = document.getElementById('view-inv'), msg = host.querySelector('#ivUpMsg');
  const file = host.querySelector('#ivFile').files[0], key = host.querySelector('#ivKey').value, who = host.querySelector('#ivWho').value.trim();
  if(!file){ msg.textContent = 'Chọn file trước.'; return; }
  if(!key){ msg.textContent = 'Nhập upload key.'; return; }
  if(typeof XLSX === 'undefined'){ msg.textContent = 'Không tải được thư viện đọc Excel (SheetJS).'; return; }
  try { localStorage.setItem('ivWho', who); } catch(_){}
  const btn = host.querySelector('#ivGo'); btn.disabled = true;
  try {
    msg.textContent = 'Đang đọc file…';
    const wb = XLSX.read(await file.arrayBuffer(), {type: 'array', cellDates: false});
    const {rows, warn} = INV.parseWorkbook(wb);
    const kinds = Object.entries(rows).filter(([, v]) => v.length);
    if(!kinds.length) throw new Error('Không đọc được sheet nào. ' + warn.join('; '));
    const CH = 800;
    for(const [kind, list] of kinds){
      for(let i = 0; i < list.length; i += CH){
        msg.textContent = `Đang ghi ${kind}: ${Math.min(i + CH, list.length).toLocaleString()} / ${list.length.toLocaleString()} dòng…`;
        const {error} = await sb.rpc('inv_upload', {p_key: key, p_kind: kind, p_rows: list.slice(i, i + CH), p_reset: i === 0});
        if(error) throw error;
      }
    }
    msg.textContent = 'Đang cập nhật lịch sử ETA và tồn kho cho các tab khác…';
    const {data, error} = await sb.rpc('inv_upload_finish', {p_key: key, p_file_name: file.name, p_uploaded_by: who || null});
    if(error) throw error;
    msg.innerHTML = `<b style="color:var(--green)">Xong.</b> ${h.esc(Object.entries(data || {}).map(([k, v]) => k + ': ' + v).join(' · '))}${warn.length ? '<br>Lưu ý: ' + h.esc(warn.join('; ')) : ''}`;
    IV.data = null; INV.render();
  } catch(e){ msg.innerHTML = `<b style="color:var(--red)">Lỗi:</b> ${h.esc(e.message || e)}`; }
  finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- export + AI
function exportXlsx(){
  if(typeof XLSX === 'undefined') return;
  const rows = filtered(), wb = XLSX.utils.book_new();
  const a = rows.map(r => ({'PIC': r.pic, 'SKU': r.sku, 'Product': r.name, 'Product line': r.pl, 'Inv AMZ': r.amz, 'Inv Y4A': r.y4a,
    'Sales / week (4w)': r.act4 == null ? '' : +r.act4.toFixed(1), 'Forecast / week (4w)': r.fc4 == null ? '' : +r.fc4.toFixed(1), 'Model': r.model, 'Backtest accuracy': r.acc == null ? '' : +r.acc.toFixed(3),
    'WOC AMZ': r.woc == null ? '' : +r.woc.toFixed(1), 'WOC total': r.wocT == null ? '' : +r.wocT.toFixed(1), 'OOS week (AMZ)': r.oosWk === null ? '' : IV.weeks[r.oosWk], 'Lost units (16w)': Math.round(r.lost),
    'Next AMZ ETA': r.nA ? r.nA.eta : '', 'Next AMZ qty': r.nA ? r.nA.qty : '', 'Next Y4A ETA': r.nY ? r.nY.eta : '', 'Next Y4A qty': r.nY ? r.nY.qty : '',
    'Incoming AMZ': r.incAmzTot, 'Incoming Y4A': r.incY4aTot, 'Units ETA slipped': r.delayQty, 'Max slip days': r.maxSlip, 'Units past ETA': r.overdueQty, 'Risk': r.risk, 'Suggestion': r.why.join(' · '),
    ...Object.fromEntries(IV.weeks.map((w, i) => ['Proj AMZ ' + w, r.fcW ? Math.round(r.pA.p[i]) : '']))}));
  const keep = new Set(rows.map(r => r.sku));
  const b = IV.lines.filter(l => keep.has(l.sku)).map(l => ({'Source': l.source, 'Country': l.country, 'Channel / WH': l.channel, 'PO': l.po_name, 'SKU': l.sku, 'ASIN': l.asin, 'Qty': l.qty,
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
      next_amz: r.nA ? {eta: r.nA.eta, qty: r.nA.qty, status: r.nA.on_time_status} : null, next_y4a: r.nY ? {eta: r.nY.eta, qty: r.nY.qty, po: r.nY.po_name, container: r.nY.container_number} : null,
      units_slipped: r.delayQty, max_slip_days: r.maxSlip, units_past_eta: r.overdueQty, risk: r.risk})),
    delayed_pos: IV.po.filter(p => p.st !== 'normal').sort((a, b) => b.sev - a.sev).slice(0, 25).map(p => ({source: p.source, po: p.po, container: p.container, qty: p.qty, skus: p.skuList.slice(0, 80), eta_original: p.orig, eta_now: p.eta, slip_days: p.slip, days_past_eta: p.overdue, physical: p.physical})),
  };
  const question = `Bạn là chuyên gia supply chain + Amazon Vendor (AVC) của Yes4All. Dựa trên dữ liệu tồn kho, incoming và forecast dưới đây (ETA của nhà máy/forwarder thường bị trễ), hãy:
1) Liệt kê tối đa 8 hành động ưu tiên: SKU nào cần kéo container Y4A về sớm / đẩy PO WH sang Amazon, PO nào cần follow-up gấp, SKU nào nên giảm ads/promo để giữ tồn, SKU nào tồn cao cần đẩy bán hoặc dời PO.
2) Nêu rủi ro trễ hàng theo product line và ước tính units có thể mất.
Trích số cụ thể (SKU, PO, ngày, units). Trả lời tiếng Việt, gạch đầu dòng, ghi mức ưu tiên Cao/Trung bình/Thấp.`;
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
#ivTable .vs,#ivPoTable .vs{font-size:10.5px;color:var(--muted);display:block}
#ivTable tr.sel td{background:#FFF3EA}
#ivTable tbody tr:hover td{background:#F7F9FC}
@media (max-width:1100px){.iv-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
  document.head.appendChild(css);
}
INV._state = IV; INV._compute = compute;
})();
