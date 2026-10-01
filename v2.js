// =====================================================================
// Yes4All Sales Dashboard — v2 modules
// Loaded after the main <script> in index.html and shares its globals
// (sb, ROWS, DATA, COLOR, fmtMoney, fmtInt, addDaysIso, todayISO, ...).
//   · Global quick search (SKU / ASIN / product name) for every tab
//   · Tracking Target extras: DOC inventory value, issue monitor, action labels
//   · Sales Performance tab (day range, YoY, trends, treemap, relationships,
//     inventory vs demand, SKU breakdown + SKU detail)
//   · Weekly Review tab (frozen weekly snapshot, PIC notes, knowledge hub,
//     action tracker, rule-based + AI recommendations)
//   · Ads Performance extras (weekly ads charts, product-line recommendations)
//   · Market tab (brand map, variation price ladder, price vs sales)
// =====================================================================
(function(){
'use strict';
const V2 = window.V2 = {};
const GS = window.GS = { sku: null, text: '' };

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const div = (a, b) => (b ? a / b : NaN);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const f$ = v => !isNum(v) ? '—' : (v < 0 ? '-$' : '$') + (Math.abs(v) >= 1e6 ? (Math.abs(v)/1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? (Math.abs(v)/1e3).toFixed(1) + 'K' : Math.round(Math.abs(v)).toLocaleString('en-US'));
const f$2 = v => !isNum(v) ? '—' : '$' + v.toFixed(2);
const fN = v => !isNum(v) ? '—' : Math.abs(v) >= 1e6 ? (v/1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? (v/1e3).toFixed(1) + 'K' : Math.round(v).toLocaleString('en-US');
const fP = (v, d = 1) => !isNum(v) ? '—' : (v * 100).toFixed(d) + '%';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const mLabel = iso => MONTHS[+iso.slice(5, 7) - 1] + '-' + iso.slice(2, 4);
const dm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const dowOf = iso => new Date(iso + 'T00:00:00').getDay();
const sundayOf = iso => addDaysIso(iso, -dowOf(iso));
const addMonths = (iso, n) => { const d = new Date(+iso.slice(0,4), +iso.slice(5,7) - 1 + n, +iso.slice(8,10) || 1); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const daysIn = iso => new Date(+iso.slice(0,4), +iso.slice(5,7), 0).getDate();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function toast(msg){ const t = document.createElement('div'); t.textContent = msg; t.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#002859;color:#fff;padding:9px 16px;border-radius:20px;font-weight:700;font-size:12.5px;z-index:300'; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
function deltaHtml(cur, prev, lowerBetter, isRate){
  if(!isNum(cur) || !isNum(prev) || (!isRate && prev === 0)) return '<span class="dl flat">n/a</span>';
  const d = isRate ? cur - prev : cur / prev - 1;
  const good = lowerBetter ? d < 0 : d > 0;
  const cls = Math.abs(d) < (isRate ? 0.001 : 0.005) ? 'flat' : good ? 'up' : 'down';
  return `<span class="dl ${cls}">${d >= 0 ? '▲' : '▼'} ${isRate ? (d >= 0 ? '+' : '') + (d*100).toFixed(1) + ' pt' : (d >= 0 ? '+' : '') + (d*100).toFixed(1) + '%'}</span>`;
}
function spark(values, color){
  const v = values.filter(isNum); if(v.length < 2) return '';
  const mn = Math.min(...v), mx = Math.max(...v), W = 160, H = 26, p = 3;
  const x = i => p + i * (W - 2*p) / (values.length - 1), y = val => H - p - (mx === mn ? .5 : (val - mn) / (mx - mn)) * (H - 2*p);
  const pts = values.map((val, i) => isNum(val) ? `${x(i).toFixed(1)},${y(val).toFixed(1)}` : null).filter(Boolean);
  const li = values.length - 1;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>${isNum(values[li]) ? `<circle cx="${x(li)}" cy="${y(values[li])}" r="2.4" fill="${color}"/>` : ''}</svg>`;
}
function pearson(xs, ys){ const n = xs.length; if(n < 3) return NaN; const mx = xs.reduce((a,b)=>a+b)/n, my = ys.reduce((a,b)=>a+b)/n; let sxy=0,sxx=0,syy=0; for(let i=0;i<n;i++){ sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)**2; syy+=(ys[i]-my)**2; } return sxy/Math.sqrt(sxx*syy); }
function ranks(a){ const idx = a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]); const r = new Array(a.length); let i=0; while(i<idx.length){ let j=i; while(j+1<idx.length && idx[j+1][0]===idx[i][0]) j++; for(let k=i;k<=j;k++) r[idx[k][1]]=(i+j)/2+1; i=j+1; } return r; }
function ols(xs, ys){ const n = xs.length, mx = xs.reduce((a,b)=>a+b)/n, my = ys.reduce((a,b)=>a+b)/n; let sxy=0,sxx=0; for(let i=0;i<n;i++){ sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)**2; } const b = sxy/sxx; return {b, a: my - b*mx}; }
const strength = r => { const a = Math.abs(r); return !isNum(r) ? 'không đủ dữ liệu' : a < .1 ? 'gần như không có' : a < .3 ? 'yếu' : a < .5 ? 'vừa' : a < .7 ? 'khá mạnh' : 'mạnh'; };

async function rpcAll(name, params){
  const size = 1000; let from = 0, all = [];
  for(;;){
    const {data, error} = await sb.rpc(name, params).range(from, from + size - 1);
    if(error) throw error;
    all = all.concat(data || []);
    if(!data || data.length < size) break;
    from += size;
  }
  return all;
}
async function selectAll(table, build){
  const size = 1000; let from = 0, all = [];
  for(;;){
    let q = sb.from(table).select('*');
    if(build) q = build(q);
    const {data, error} = await q.range(from, from + size - 1);
    if(error) throw error;
    all = all.concat(data || []);
    if(!data || data.length < size) break;
    from += size;
  }
  return all;
}
const missingSchema = err => /does not exist|Could not find|schema cache|42P01|42883|PGRST20/.test(String(err && (err.message || err.code || err)));
const schemaHint = '<div class="notice">Cần chạy <b>00_schema_v2.sql</b> và các file dữ liệu trong Supabase SQL Editor để mở tính năng này.</div>';

// metric catalog --------------------------------------------------------
const SUM_KEYS = ['units','gmv','ads','promo','ads_gmv','ads_units','clicks','impressions','glance_views','cm3','cm3_gmv','cm3_units','cm3_base','cm3_mkt','sp_spend','sb_spend','sd_spend','dsp_spend','promo_deal','promo_coupon','promo_discount'];
function emptyAgg(){ const a = {}; SUM_KEYS.forEach(k => a[k] = 0); return a; }
function addInto(a, r){ SUM_KEYS.forEach(k => { a[k] += +r[k] || 0; }); return a; }
function derive(a){
  a.mkt = a.ads + a.promo; a.asp = div(a.gmv, a.units); a.mktGmv = div(a.mkt, a.gmv); a.tacos = div(a.ads, a.gmv);
  a.promoGmv = div(a.promo, a.gmv); a.acos = div(a.ads, a.ads_gmv); a.cr = div(a.units, a.glance_views); a.ctr = div(a.clicks, a.impressions);
  a.adShare = div(a.ads_units, a.units); a.cm3Pct = div(a.cm3, a.cm3_gmv); a.cm3Unit = div(a.cm3, a.units); a.mktUnit = div(a.mkt, a.units);
  return a;
}
const M = {
  gmv:{l:'GMV', f:f$}, units:{l:'Units', f:fN}, asp:{l:'ASP', f:f$2}, mkt:{l:'MKT $', f:f$, inv:1}, ads:{l:'Ads $', f:f$, inv:1},
  promo:{l:'Promo $', f:f$, inv:1}, ads_units:{l:'Ads units', f:fN}, glance_views:{l:'Glance views', f:fN}, cm3:{l:'CM3 $ (ước tính)', f:f$},
  mktGmv:{l:'%MKT/GMV', f:fP, inv:1, rate:1}, tacos:{l:'TACOS', f:fP, inv:1, rate:1}, promoGmv:{l:'%Promo/GMV', f:fP, inv:1, rate:1},
  acos:{l:'ACOS', f:fP, inv:1, rate:1}, cr:{l:'CR (units/GV)', f:v=>fP(v,2), rate:1}, ctr:{l:'CTR', f:v=>fP(v,2), rate:1},
  adShare:{l:'% Ads units', f:fP, rate:1}, cm3Pct:{l:'CM3 %', f:fP, rate:1}, cm3Unit:{l:'CM3 / unit', f:f$2}, mktUnit:{l:'MKT / unit', f:f$2, inv:1},
  gmvYoy:{l:'GMV YoY %', f:fP, rate:1}, clicks:{l:'Clicks', f:fN}, impressions:{l:'Impressions', f:fN},
};
const ABS_KEYS = ['gmv','units','asp','mkt','ads','promo','ads_units','glance_views','cm3'];
const RATE_KEYS = ['mktGmv','tacos','acos','promoGmv','cr','ctr','adShare','cm3Pct'];

// SKU master (from ROWS built by loadMonth) -------------------------------
function master(){ return ROWS; }
function skuInfo(sku){ return ROWS.find(r => r.sku === sku); }
function stockOf(r){ return (r.salableY4A || 0) + (r.salableAMZ || 0); }
function withCm3(sku, row){
  const k = skuInfo(sku);
  const o = {...row};
  if(k && isNum(k.cm3Base)){
    o.cm3_mkt = k.cm3Lane === 'SPT' ? 0 : (+row.ads || 0) * 0.985 + (+row.promo || 0);
    o.cm3_base = (+row.units || 0) * k.cm3Base;
    o.cm3 = o.cm3_base - o.cm3_mkt;
    o.cm3_gmv = +row.gmv || 0; o.cm3_units = +row.units || 0;
  } else { o.cm3 = 0; o.cm3_gmv = 0; o.cm3_units = 0; o.cm3_base = 0; o.cm3_mkt = 0; }
  return o;
}
function matchGS(r){
  if(GS.sku) return r.sku === GS.sku;
  if(GS.text){ const q = GS.text.toLowerCase(); return r.sku.toLowerCase().includes(q) || (r.productName || '').toLowerCase().includes(q) || (r.asin || '').toLowerCase().includes(q); }
  return true;
}
V2.matchGS = matchGS;

// ---------------------------------------------------------------- Plotly
const PAL = { s1:'#E86A10', s2:'#2a78d6', s3:'#1baf7a', other:'#A3ACB8', ink:'#1B2733', muted:'#66707C', line:'#E4E5E6', navy:'#002859', good:'#1E8E5A', warn:'#B8860B', crit:'#D64545', neg:'#D64545', mid:'#E9EBEE', pos:'#2a78d6' };
const CAT5 = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4'];
const PCFG = {displaylogo:false, responsive:true, modeBarButtonsToRemove:['lasso2d','select2d','autoScale2d','toggleSpikelines']};
const ax = extra => Object.assign({gridcolor:'#EEF0F3', linecolor:PAL.line, zeroline:false, tickfont:{color:PAL.muted, size:11}, title:{font:{color:PAL.muted, size:11}}}, extra || {});
function lay(extra){
  return Object.assign({
    paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)', font:{family:'Poppins, Arial, sans-serif', size:11.5, color:PAL.ink},
    margin:{l:58, r:16, t:12, b:44}, hoverlabel:{bgcolor:'#fff', bordercolor:PAL.line, font:{color:PAL.ink, family:'Poppins, Arial', size:11.5}},
    legend:{orientation:'h', y:-0.18, x:0, font:{color:PAL.muted, size:11}}, xaxis:ax(), yaxis:ax(),
  }, extra || {});
}
const divScale = [[0, PAL.neg], [.5, PAL.mid], [1, PAL.pos]];
function draw(el, data, layout){ if(typeof Plotly === 'undefined'){ (typeof el === 'string' ? document.getElementById(el) : el).innerHTML = '<div class="notice">Không tải được thư viện biểu đồ (Plotly).</div>'; return; } Plotly.react(el, data, layout, PCFG); }
function chipRow(el, items, isOn, onClick, swatch){
  el.querySelectorAll('.cv-btn').forEach(c => c.remove());
  items.forEach(m => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cv-btn' + (isOn(m) ? ' active' : '');
    b.innerHTML = (swatch && isOn(m) ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${swatch(m)};margin-right:5px"></span>` : '') + esc(m.l);
    b.onclick = () => onClick(m); el.appendChild(b);
  });
}

// =====================================================================
// Shared loaders (after each month load)
// =====================================================================
V2.state = { maxDate: null, lockBefore: null, schemaOk: true, incoming: new Map(), demand: new Map(), recent: new Map(), notes: [] };
V2.afterLoadMonth = async function(){
  const S = V2.state;
  // extra SKU fields not mapped by loadMonth
  try {
    const skus = await selectAll('skus', q => q);
    const bySku = new Map(skus.map(s => [s.sku, s]));
    ROWS.forEach(r => { const s = bySku.get(r.sku) || {}; r.cm3Base = s.cm3_unit_base == null ? null : +s.cm3_unit_base; r.cm3Lane = s.cm3_lane || null; r.blockAds = s.block_ads || ''; r.labels = s.labels || ''; r.category = s.category || ''; r.normalAsp = s.normal_asp == null ? null : +s.normal_asp; r.asinStatus = s.asin_status || r.asinStatus; });
  } catch(e){ console.warn(e); }
  try {
    const b = (await sb.rpc('sales_date_bounds')).data;
    if(b && b[0]){ S.maxDate = b[0].max_date; S.lockBefore = b[0].lock_before; }
    S.schemaOk = true;
  } catch(e){ S.schemaOk = !missingSchema(e); }
  if(!S.maxDate) S.maxDate = DATA.asOfDate || todayISO();
  const asOf = S.maxDate;
  // recent windows for price / glance-view signals
  try {
    const [w7, p7, w28] = await Promise.all([
      rpcAll('sales_by_sku', {p_from: addDaysIso(asOf, -6), p_to: asOf}),
      rpcAll('sales_by_sku', {p_from: addDaysIso(asOf, -13), p_to: addDaysIso(asOf, -7)}),
      rpcAll('sales_by_sku', {p_from: addDaysIso(asOf, -34), p_to: addDaysIso(asOf, -7)}),
    ]);
    const m7 = new Map(w7.map(r => [r.sku, r])), mp = new Map(p7.map(r => [r.sku, r])), m28 = new Map(w28.map(r => [r.sku, r]));
    S.recent = new Map();
    ROWS.forEach(r => {
      const a = m7.get(r.sku), p = mp.get(r.sku), b = m28.get(r.sku);
      const x = { units7: +(a?.units || 0), gmv7: +(a?.gmv || 0), ads7: +(a?.ads || 0), gv7: +(a?.glance_views || 0), gvPrev7: +(p?.glance_views || 0),
        gmvPrev7: +(p?.gmv || 0), adsPrev7: +(p?.ads || 0), units28: +(b?.units || 0) + +(a?.units || 0) * 0, gmv28: +(b?.gmv || 0), unitsPrev7: +(p?.units || 0) };
      x.asp7 = div(x.gmv7, x.units7); x.asp28 = div(+(b?.gmv || 0), +(b?.units || 0));
      x.vel = (x.units7 + (+(b?.units || 0))) / 35; // units/day over the last 5 weeks
      S.recent.set(r.sku, x); Object.assign(r, {sig: x});
    });
  } catch(e){ if(missingSchema(e)) S.schemaOk = false; console.warn(e); }
  // incoming + demand (optional tables)
  try {
    const inc = await selectAll('incoming_weekly', q => q.gte('week_start', sundayOf(asOf)).order('snapshot_date', {ascending:false}));
    const latest = inc.length ? inc.reduce((m, r) => r.snapshot_date > m ? r.snapshot_date : m, inc[0].snapshot_date) : null;
    S.incoming = new Map(); S.incomingAsOf = latest;
    inc.filter(r => r.snapshot_date === latest).forEach(r => { const a = S.incoming.get(r.sku) || []; a.push({week: r.week_start, qty: (+r.qty_y4a || 0) + (+r.qty_amz || 0)}); S.incoming.set(r.sku, a); });
    const dem = await selectAll('demand_forecast_monthly', q => q.gte('month', asOf.slice(0, 7) + '-01'));
    S.demand = new Map(); dem.forEach(r => { const a = S.demand.get(r.sku) || []; a.push({month: r.month, units: +r.units || 0}); S.demand.set(r.sku, a); });
  } catch(e){ console.warn(e); }
  // recent PIC notes for listing issues (zip block, long shipping...)
  try {
    S.notes = await selectAll('weekly_reviews', q => q.gte('week_start', addDaysIso(asOf, -42)));
  } catch(e){ S.notes = []; }
  initSearch();
};

// =====================================================================
// Global quick search
// =====================================================================
let searchInit = false, hl = -1, hits = [];
function initSearch(){
  if(searchInit) return; searchInit = true;
  const inp = $('#gSearch'), drop = $('#gSearchDrop');
  const renderDrop = () => {
    const q = inp.value.trim().toLowerCase();
    if(q.length < 2){ drop.hidden = true; return; }
    hits = ROWS.filter(r => r.sku.toLowerCase().includes(q) || (r.asin || '').toLowerCase().includes(q) || (r.productName || '').toLowerCase().includes(q))
      .sort((a, b) => (b.sku.toLowerCase() === q) - (a.sku.toLowerCase() === q) || (b.actualGMV || 0) - (a.actualGMV || 0)).slice(0, 14);
    hl = hits.length ? 0 : -1;
    drop.innerHTML = (hits.length ? hits.map((r, i) => `<div class="gs-item${i === hl ? ' hl' : ''}" data-sku="${esc(r.sku)}"><b>${esc(r.sku)}</b><span class="asin">${esc(r.asin || '')}</span><span class="nm">${esc(r.productName || '')}</span></div>`).join('') : '<div class="gs-item">Không tìm thấy</div>')
      + `<div class="gs-item" data-text="1" style="color:var(--muted)">↵ Lọc tất cả kết quả chứa “${esc(inp.value.trim())}”</div>`;
    drop.hidden = false;
  };
  inp.addEventListener('input', renderDrop);
  inp.addEventListener('focus', renderDrop);
  inp.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); if(!hits.length) return; hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; $$('#gSearchDrop .gs-item[data-sku]').forEach((el, i) => el.classList.toggle('hl', i === hl)); }
    else if(e.key === 'Enter'){
      e.preventDefault();
      const q = inp.value.trim().toLowerCase();
      if(!q){ setGS({}); return; }
      const exact = ROWS.find(r => r.sku.toLowerCase() === q || (r.asin || '').toLowerCase() === q);
      if(exact) setGS({sku: exact.sku});
      else if(hits.length === 1 || (hl > 0 && hits[hl])) setGS({sku: hits[hl].sku});
      else setGS({text: inp.value.trim()});
    }
    else if(e.key === 'Escape'){ drop.hidden = true; }
  });
  drop.addEventListener('mousedown', e => {
    const it = e.target.closest('.gs-item'); if(!it) return; e.preventDefault();
    if(it.dataset.sku) setGS({sku: it.dataset.sku}); else if(it.dataset.text) setGS({text: inp.value.trim()});
  });
  document.addEventListener('click', e => { if(!e.target.closest('.gsearch')) drop.hidden = true; });
}
function setGS(o){
  GS.sku = o.sku || null; GS.text = o.sku ? '' : (o.text || '');
  $('#gSearchDrop').hidden = true;
  $('#gSearch').value = GS.sku || GS.text;
  const label = GS.sku ? (GS.sku + ' · ' + ((skuInfo(GS.sku) || {}).productName || '').slice(0, 38)) : GS.text ? '“' + GS.text + '”' : '';
  $('#gSearchChip').innerHTML = label ? `<span class="gs-chip">Đang lọc: ${esc(label)} <button type="button" aria-label="Bỏ lọc tìm kiếm" id="gsClear">×</button></span>` : '';
  const b = $('#gsClear'); if(b) b.onclick = () => setGS({});
  rerenderAllTabs();
  if(GS.sku && V2.activeTab === 'sp') openSkuDetail(GS.sku);
}
function rerenderAllTabs(){
  try { renderAll(); } catch(e){ console.warn(e); }
  try { renderAdsTab(); } catch(e){ console.warn(e); }
  try { renderPerfTab(); } catch(e){ console.warn(e); }
  SPdirty = true; WRdirty = true; ADSdirty = true;
  V2.onTab(V2.activeTab);
}

// =====================================================================
// Tracking Target extras: DOC value + issue monitor + action labels
// =====================================================================
let issueFilter = null;
function priceOf(r){ return r.rrp > 0 ? r.rrp : (r.normalAsp > 0 ? r.normalAsp : (r.actualUnits ? r.actualGMV / r.actualUnits : 0)); }
const DOC_ORDER = ['OOS','DOC <14d','DOC 14–30d','DOC 30–90d','DOC >90d','N/A'];
function renderDocStats(rows){
  const el = $('#docStatsCard'); if(!el) return;
  const g = {}; DOC_ORDER.forEach(b => g[b] = {n:0, withInv:0, units:0, value:0, sell30:0, noRrp:0});
  rows.forEach(r => {
    const b = g[r.docBand] || g['N/A']; const inv = stockOf(r), p = priceOf(r);
    b.n++; if(inv > 0) b.withInv++; b.units += inv; b.value += inv * p; if(!(r.rrp > 0) && inv > 0) b.noRrp++;
    const vel = r.sig && isNum(r.sig.vel) ? r.sig.vel : (r.docVelocity || 0);
    b.sell30 += Math.min(inv, vel * 30) * p;
  });
  const tot = Object.values(g).reduce((t, b) => ({n:t.n+b.n, withInv:t.withInv+b.withInv, units:t.units+b.units, value:t.value+b.value, sell30:t.sell30+b.sell30, noRrp:t.noRrp+b.noRrp}), {n:0,withInv:0,units:0,value:0,sell30:0,noRrp:0});
  const over = g['DOC >90d'];
  const color = {OOS:COLOR.red, 'DOC <14d':COLOR.red, 'DOC 14–30d':COLOR.amber, 'DOC 30–90d':COLOR.green, 'DOC >90d':COLOR.navy, 'N/A':'#66707C'};
  el.innerHTML = `<h3 style="margin:0 0 4px">Tồn kho theo DOC & GMV tương ứng</h3>
    <div class="hint">GMV tiềm năng = tồn (Y4A + AMZ) × RRP (thiếu RRP thì dùng Normal ASP, rồi ASP tháng này). “Bán được 30 ngày” = min(tồn, tốc độ bán 5 tuần gần nhất × 30) × RRP. ${tot.noRrp ? `<b>${tot.noRrp} SKU còn tồn chưa có RRP.</b>` : ''}</div>
    <div class="readout" style="margin:8px 0 10px">Hàng tồn <b>&gt; 90 ngày</b>: <b>${over.withInv}</b> SKU còn tồn · <b>${fmtInt(over.units)}</b> units · GMV tương ứng <b>${f$(over.value)}</b> theo RRP, nhưng với tốc độ hiện tại chỉ bán được khoảng <b>${f$(over.sell30)}</b> trong 30 ngày → cần deal/ads để kéo.</div>
    <div class="tablewrap" style="max-height:none"><table class="doc-table"><thead><tr><th>DOC band</th><th class="num">SKU</th><th class="num">SKU còn tồn</th><th class="num">Units tồn</th><th class="num">GMV tiềm năng @RRP</th><th class="num">Bán được 30 ngày</th><th class="num">% giá trị tồn</th></tr></thead><tbody>
    ${DOC_ORDER.map(b => { const x = g[b]; return `<tr class="clickable" data-band="${b}"><td><span class="badge" style="background:#F1F3F6;color:${color[b]}">${b}</span></td><td class="num">${x.n}</td><td class="num">${x.withInv}</td><td class="num">${fmtInt(x.units)}</td><td class="num"><b>${f$(x.value)}</b></td><td class="num">${f$(x.sell30)}</td><td class="num">${tot.value ? fP(x.value / tot.value, 0) : '—'}</td></tr>`; }).join('')}
    <tr style="font-weight:800;background:#F5F7FA"><td>Tổng</td><td class="num">${tot.n}</td><td class="num">${tot.withInv}</td><td class="num">${fmtInt(tot.units)}</td><td class="num">${f$(tot.value)}</td><td class="num">${f$(tot.sell30)}</td><td class="num">100%</td></tr>
    </tbody></table></div>`;
  el.querySelectorAll('tr[data-band]').forEach(tr => tr.onclick = () => { mocBandFilter = mocBandFilter === tr.dataset.band ? null : tr.dataset.band; renderAll(); $('#skuTable').scrollIntoView({behavior:'smooth', block:'start'}); });
}

// SKU-level issue flags. Source noted per flag so the team knows what to trust.
const NOTE_RX = { zip: /zip ?code|zipcode|block zip|block sale/i, ship: /shipping|giao hàng|1-2 days|available in/i, listing: /bung listing|suppress|mất badge|badge|item highlight|listing bị|merge listing|bị block/i };
function notesMentions(){
  const out = { zip: new Set(), ship: new Set(), listing: new Set() };
  (V2.state.notes || []).forEach(n => {
    String(n.issue_text || '').split(/\n+/).forEach(line => {
      const skus = (line.match(/\b[A-Z0-9]{4}\b/g) || []).filter(x => /[A-Z]/.test(x) && skuInfo(x));
      if(!skus.length) return;
      Object.keys(NOTE_RX).forEach(k => { if(NOTE_RX[k].test(line)) skus.forEach(s => out[k].add(s)); });
    });
  });
  return out;
}
function issueDefs(){
  const nm = notesMentions();
  return [
    {key:'blockAds', label:'Block ads', src:'Target file', test:r => /block/i.test(r.blockAds || '') && !/not predominantly|no observation/i.test(r.blockAds || ''), sev:'crit'},
    {key:'zip', label:'Block zipcode', src:'Ghi chú PIC', test:r => nm.zip.has(r.sku), sev:'crit'},
    {key:'ship', label:'Long shipping time', src:'Ghi chú PIC', test:r => nm.ship.has(r.sku), sev:'warn'},
    {key:'listing', label:'Bung / lỗi listing', src:'Ghi chú PIC', test:r => nm.listing.has(r.sku), sev:'warn'},
    {key:'inactiveInv', label:'ASIN inactive còn tồn', src:'USA Inventory', test:r => /inactive/i.test(r.asinStatus || '') && stockOf(r) > 0, sev:'warn'},
    {key:'overRrp', label:'Bung giá (ASP 7N > RRP +5%)', src:'Sales daily', test:r => r.sig && r.rrp > 0 && r.sig.asp7 > r.rrp * 1.05 && r.sig.units7 >= 3, sev:'warn'},
    {key:'priceJump', label:'Nhảy giá (ASP 7N vs 4 tuần ±10%)', src:'Sales daily', test:r => r.sig && isNum(r.sig.asp7) && isNum(r.sig.asp28) && r.sig.units7 >= 3 && Math.abs(r.sig.asp7 / r.sig.asp28 - 1) > .10, sev:'warn'},
    {key:'oosAds', label:'Hết hàng vẫn chạy ads', src:'Sales + tồn', test:r => stockOf(r) <= 0 && r.sig && r.sig.ads7 > 5, sev:'crit'},
    {key:'gvDrop', label:'Glance view giảm > 30% WoW', src:'Sales daily', test:r => r.sig && r.sig.gvPrev7 >= 200 && r.sig.gv7 > 0 && r.sig.gv7 < r.sig.gvPrev7 * .7, sev:'warn'},
  ];
}
function renderIssueMonitor(rows){
  const el = $('#issueCard'); if(!el) return;
  const list = defs();
  el.innerHTML = `<h3 style="margin:0 0 4px">Issue monitor</h3><div class="hint">Đếm số SKU theo từng vấn đề trong bộ lọc hiện tại. Bấm một ô để lọc bảng SKU Breakdown. Nguồn ghi ở từng ô: “Ghi chú PIC” lấy từ Weekly Review 6 tuần gần nhất.</div>
    <div class="issue-grid" style="margin-top:8px">${list.map(d => { const hit = rows.filter(d.test); const g = hit.reduce((s, r) => s + (r.actualGMV || 0), 0); const c = d.sev === 'crit' ? COLOR.red : COLOR.amber;
      return `<div class="issue${issueFilter === d.key ? ' active' : ''}" data-k="${d.key}" role="button" tabindex="0"><span class="n" style="color:${hit.length ? c : '#66707C'}">${hit.length}</span><span class="t">${esc(d.label)}</span><span class="s">GMV MTD ${f$(g)} · <span class="src-tag">${esc(d.src)}</span></span></div>`; }).join('')}</div>`;
  el.querySelectorAll('.issue').forEach(x => x.onclick = () => { issueFilter = issueFilter === x.dataset.k ? null : x.dataset.k; renderAll(); $('#skuTable').scrollIntoView({behavior:'smooth', block:'start'}); });
}
let defsCache = null;
const defs = () => defsCache || (defsCache = issueDefs());
V2.renderTrackingExtras = function(rows){ defsCache = issueDefs(); renderDocStats(rows); renderIssueMonitor(rows); };
V2.applyIssueFilter = function(rows){ if(!issueFilter) return rows; const d = defs().find(x => x.key === issueFilter); return d ? rows.filter(d.test) : rows; };
V2.actionLabels = function(r){
  const out = [];
  ACTION_FLAGS.forEach(f => { if(f.key !== 'growing' && f.test(r)) out.push(`<span class="rec ${/OOS|Low cover/.test(f.label) ? 'p1' : 'p2'}" title="${esc(f.label)}">${esc(f.label.split(' — ')[0].split(' + ')[0])}</span>`); });
  defs().forEach(d => { if(d.test(r)) out.push(`<span class="rec ${d.sev === 'crit' ? 'p1' : 'p2'}" title="Nguồn: ${esc(d.src)}">${esc(d.label.split(' (')[0])}</span>`); });
  if(!out.length && r.trendLabel === 'Growing') out.push('<span class="rec ok">Growing</span>');
  return out.join('') || '<span class="v2-note">—</span>';
};

// =====================================================================
// Rule-based recommendations (daily; used by Weekly Review, SKU detail, Ads)
// c = current window, p = previous window, t = target for the window (optional)
// =====================================================================
function recsFor(k, c, p, t){
  const out = []; const add = (pr, text) => out.push({p: pr, text});
  const stock = stockOf(k || {}), weeklyUnits = Math.max(c.units || 0, (p && p.units) || 0) || 0;
  const cover = weeklyUnits ? stock / weeklyUnits : Infinity; // in windows (≈ weeks for a weekly window)
  const pc = (a, b) => b ? a / b - 1 : NaN;
  const gvW = p ? pc(c.glance_views, p.glance_views) : NaN, adsW = p ? pc(c.ads, p.ads) : NaN, gmvW = p ? pc(c.gmv, p.gmv) : NaN;
  const crC = div(c.units, c.glance_views), crP = p ? div(p.units, p.glance_views) : NaN;
  const aspC = div(c.gmv, c.units), aspP = p ? div(p.gmv, p.units) : NaN;
  const acos = div(c.ads, c.ads_gmv), tacos = div(c.ads, c.gmv);
  if(stock <= 0 && c.ads > 5) add(1, `Hết hàng nhưng vẫn tiêu ads ${f$(c.ads)} → tạm dừng/giảm campaign`);
  else if(stock > 0 && cover < 2 && weeklyUnits >= 3) add(1, `Tồn ${fmtInt(stock)} chỉ đủ ~${cover.toFixed(1)} tuần → giảm ads, theo dõi hàng về`);
  if(!(c.glance_views > 0)) { /* current window has no glance-view data (hourly source) */ }
  else if(isNum(gvW) && p.glance_views >= 150 && gvW < -.25 && isNum(adsW) && adsW < -.25) add(1, `Glance view ${fP(gvW,0)} cùng Ads ${fP(adsW,0)} → check campaign (budget, trạng thái, bid)`);
  else if(isNum(gvW) && p.glance_views >= 150 && gvW < -.25) add(2, `Glance view ${fP(gvW,0)} (${fN(p.glance_views)}→${fN(c.glance_views)}) dù ads không giảm → check ranking/keyword, listing (suppressed, buy box, badge)`);
  if(isNum(crC) && isNum(crP) && c.glance_views >= 150 && crC < crP * .75) add(2, `CR giảm ${fP(crP,1)} → ${fP(crC,1)} → check giá, buy box, review, deal đối thủ`);
  if(k && k.rrp > 0 && isNum(aspC) && c.units >= 3 && aspC > k.rrp * 1.05) add(2, `Bung giá: ASP ${f$2(aspC)} cao hơn RRP ${f$2(k.rrp)} (${fP(aspC / k.rrp - 1, 0)})`);
  else if(isNum(aspC) && isNum(aspP) && c.units >= 3 && p.units >= 3 && Math.abs(aspC / aspP - 1) > .10) add(3, `Giá thay đổi ${fP(aspC / aspP - 1, 0)} so với kỳ trước (${f$2(aspP)} → ${f$2(aspC)})`);
  if(isNum(acos) && acos > .40 && c.ads > 50) add(2, `ACOS ${fP(acos,0)} trên ${f$(c.ads)} ads → hạ bid, thêm negative keyword, cắt search term lỗ`);
  if(t && t.gmv >= 100 && c.gmv <= 0 && stock > 0) add(1, `Có tồn ${fmtInt(stock)} và target ${f$(t.gmv)} nhưng không bán được → check listing (inactive/suppressed), buy box, giá`);
  else if(t && t.gmv >= 100 && c.gmv > 0 && c.gmv < t.gmv * .8 && cover >= 4 && (!isNum(tacos) || tacos < .05)) add(2, `Mới đạt ${fP(c.gmv / t.gmv, 0)} target tuần, TACOS chỉ ${fP(tacos,1)} và tồn đủ → tăng budget ads cho keyword chuyển đổi`);
  if(cover > 16 && isNum(gmvW) && gmvW < 0 && stock > 0) add(3, `Tồn ~${Math.round(cover)} tuần và số bán giảm ${fP(gmvW,0)} → cân nhắc coupon/deal để xả`);
  if(isNum(gmvW) && gmvW > .3 && p && p.gmv > 100 && cover >= 4) add(4, `Đang tăng ${fP(gmvW,0)} → giữ ngân sách, không đổi giá`);
  return out.sort((a, b) => a.p - b.p);
}
const recChip = r => `<span class="rec ${r.p === 1 ? 'p1' : r.p === 2 ? 'p2' : r.p === 4 ? 'ok' : 'p3'}" title="${esc(r.text)}">${esc(r.text.split(' → ')[0].slice(0, 44))}</span>`;

// AI call through the ai-recommend Edge Function --------------------------
async function askAI(scope, key, context, outEl, force){
  outEl.hidden = false; outEl.textContent = 'Đang hỏi AI…';
  try {
    const {data, error} = await sb.functions.invoke('ai-recommend', {body: {scope, scope_key: key, as_of: V2.state.maxDate || todayISO(), context, force: !!force}});
    if(error){ let msg = error.message; try { const j = await error.context.json(); msg = j.error || msg; } catch(_){} throw new Error(msg); }
    if(data && data.error) throw new Error(data.error);
    outEl.innerHTML = `<div style="font-size:10.5px;color:var(--muted);margin-bottom:6px">${data.cached ? 'Kết quả đã lưu hôm nay' : 'Mới tạo'} · ${esc(data.model || '')} <button class="btn small" type="button" data-reask>Hỏi lại</button></div>` + esc(data.answer);
    const b = outEl.querySelector('[data-reask]'); if(b) b.onclick = () => askAI(scope, key, context, outEl, true);
  } catch(e){
    outEl.innerHTML = `<b>Chưa gọi được AI:</b> ${esc(e.message || e)}<br><span class="v2-note">Cần deploy Edge Function <code>ai-recommend</code> và thêm secret <code>ANTHROPIC_API_KEY</code> (xem README). Các khuyến nghị theo rule bên trên vẫn chạy bình thường.</span>`;
  }
}

// =====================================================================
// SALES PERFORMANCE tab
// =====================================================================
let SPdirty = true, SPbuilt = false;
const SP = { from:null, to:null, compare:'yoy', pic:'', mpl:'', spl:'', ch:'', grain:'auto', abs:'gmv', rates:['mktGmv','tacos','cr'],
  relLevel:'mpl', preset:'promoAds', x:'promo', y:'ads', s:'gmv', h:12, invSel:null, sortKey:'gmv', sortDir:-1, cur:new Map(), prev:new Map(), key:'' };
function spBuild(){
  const v = $('#view-sp');
  v.innerHTML = `
  <div class="filterbar">
    <div class="fld"><label for="spFrom">Từ ngày</label><input type="date" id="spFrom"></div>
    <div class="fld"><label for="spTo">Đến ngày</label><input type="date" id="spTo"></div>
    <div class="fld"><label>Nhanh</label><div class="cv-toggle" id="spPresets">
      <button class="cv-btn" data-p="mtd" type="button">MTD</button><button class="cv-btn" data-p="7" type="button">7 ngày</button><button class="cv-btn" data-p="30" type="button">30 ngày</button>
      <button class="cv-btn" data-p="lm" type="button">Tháng trước</button><button class="cv-btn" data-p="qtd" type="button">QTD</button><button class="cv-btn" data-p="ytd" type="button">YTD</button><button class="cv-btn" data-p="12m" type="button">12 tháng</button></div></div>
    <div class="fld"><label for="spCompare">So sánh</label><select id="spCompare"><option value="yoy">Cùng kỳ năm trước</option><option value="pop">Kỳ liền trước</option></select></div>
    <div class="fld"><label for="spPic">PIC</label><select id="spPic"><option value="">All</option></select></div>
    <div class="fld"><label for="spMpl">Main PL</label><select id="spMpl"><option value="">All</option></select></div>
    <div class="fld"><label for="spSpl">Old Product Line</label><select id="spSpl"><option value="">All</option></select></div>
    <div class="fld"><label for="spCh">Channel</label><select id="spCh"><option value="">All</option></select></div>
    <button class="btn" id="spReset" type="button">Reset</button>
    <span class="result-count" id="spCount"></span>
  </div>
  <div id="spSchema"></div>
  <div class="section-title" id="spPeriodTitle">Tổng quan</div>
  <div class="tiles" id="spTiles"></div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Trend explorer</h3>
      <div class="cv-toggle" id="spGrain"><button class="cv-btn" data-g="auto" type="button">Tự động</button><button class="cv-btn" data-g="day" type="button">Ngày</button><button class="cv-btn" data-g="week" type="button">Tuần</button><button class="cv-btn" data-g="month" type="button">Tháng</button></div></div>
    <div class="hint">Panel trên: chỉ số chính (cột = kỳ đang xem, đường chấm = kỳ so sánh). Panel dưới: tối đa 3 tỷ lệ %. Hai panel dùng chung trục thời gian, không dùng trục phụ.</div>
    <div class="chipbar" id="spAbs" style="margin:6px 0 4px"><span class="lbl2">Chỉ số chính</span></div>
    <div class="chipbar" id="spRates"><span class="lbl2">Tỷ lệ (≤3)</span></div>
    <div id="spTrend" class="plot xl"></div>
  </div>
  <div class="grid-8-4">
    <div class="card"><h3 style="margin:0 0 3px">Product mix · Old Product Line</h3><div class="hint">Diện tích = GMV, màu = CM3 % (đỏ âm, xám hòa vốn, xanh tốt; xám nhạt = chưa có cost stack). Rê chuột xem GMV, units, %MKT/GMV, ACOS, CM3. Bấm để lọc cả tab theo group.</div><div id="spTree" class="plot tall"></div></div>
    <div class="card"><h3 style="margin:0 0 3px">Xếp hạng</h3><div class="hint">Bấm dòng để lọc.</div><div class="tablewrap" style="max-height:430px"><table id="spRank"></table></div></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Relationship explorer</h3>
      <div class="cv-toggle" id="spLevel"><button class="cv-btn" data-l="spl" type="button">Old PL</button><button class="cv-btn" data-l="mpl" type="button">Main PL</button><button class="cv-btn" data-l="sku" type="button">SKU</button></div></div>
    <div class="hint">Mỗi chấm là một group hoặc SKU. Đường gạch là xu hướng (OLS); hai đường xám là trung vị. Đây là tương quan mô tả, không phải quan hệ nhân quả.</div>
    <div class="chipbar" id="spPreset" style="margin:6px 0"></div>
    <div class="chipbar" id="spCustom" hidden style="margin-bottom:6px">
      <div class="fld"><label for="spCx">Trục X</label><select id="spCx"></select></div><div class="fld"><label for="spCy">Trục Y</label><select id="spCy"></select></div><div class="fld"><label for="spCs">Kích thước</label><select id="spCs"></select></div></div>
    <div class="grid-8-4" style="margin:0"><div id="spRel" class="plot tall"></div><div><div class="corr" id="spCorr"></div><div class="readout" id="spRead"></div></div></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Tồn kho vs nhu cầu</h3>
      <div class="cv-toggle" id="spH"><button class="cv-btn" data-h="8" type="button">8 tuần</button><button class="cv-btn" data-h="12" type="button">12 tuần</button><button class="cv-btn" data-h="26" type="button">26 tuần</button></div></div>
    <div class="hint" id="spInvHint"></div>
    <div class="grid-7-5" style="margin:6px 0 10px"><div id="spCover" class="plot tall"></div><div><div id="spProjTitle" style="font-weight:800;color:var(--navy);font-size:13px"></div><div id="spProj" class="plot tall"></div></div></div>
    <div class="tablewrap" style="max-height:340px"><table id="spInvTable"></table></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">SKU breakdown</h3><button class="btn small" id="spExport" type="button">&#128190; Export to Excel</button></div>
    <div class="hint">Bấm tiêu đề cột để sắp xếp. Bấm một dòng để mở chi tiết SKU (trend, tồn kho, khuyến nghị). Bấm mã SKU để mở listing Amazon.</div>
    <div class="tablewrap"><table id="spSkuTable"></table></div>
  </div>`;
  // defaults
  const mx = V2.state.maxDate || todayISO();
  SP.to = mx; SP.from = mx.slice(0, 8) + '01';
  $('#spFrom').value = SP.from; $('#spTo').value = SP.to;
  const fill = (id, vals) => { const el = $(id); vals.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); }); };
  const uq = k => [...new Set(ROWS.map(r => r[k]).filter(Boolean))].sort();
  fill('#spPic', uq('pic')); fill('#spMpl', uq('mainPL')); fill('#spSpl', uq('subPL')); fill('#spCh', uq('channel'));
  ['#spCx','#spCy','#spCs'].forEach(id => { const el = $(id); ['gmv','units','asp','mkt','ads','promo','ads_units','glance_views','cm3','mktGmv','tacos','acos','promoGmv','cr','cm3Pct','cm3Unit','mktUnit','gmvYoy'].forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = M[k].l; el.appendChild(o); }); });
  const onDates = () => { SP.from = $('#spFrom').value || SP.from; SP.to = $('#spTo').value || SP.to; if(SP.from > SP.to){ [SP.from, SP.to] = [SP.to, SP.from]; $('#spFrom').value = SP.from; $('#spTo').value = SP.to; } renderSP(); };
  $('#spFrom').onchange = onDates; $('#spTo').onchange = onDates;
  $('#spPresets').onclick = e => { const b = e.target.closest('[data-p]'); if(!b) return; const mx2 = V2.state.maxDate || todayISO(); let f = mx2, t = mx2;
    if(b.dataset.p === 'mtd') f = mx2.slice(0, 8) + '01';
    else if(b.dataset.p === '7') f = addDaysIso(mx2, -6);
    else if(b.dataset.p === '30') f = addDaysIso(mx2, -29);
    else if(b.dataset.p === 'lm'){ f = addMonths(mx2.slice(0, 8) + '01', -1); t = addDaysIso(mx2.slice(0, 8) + '01', -1); }
    else if(b.dataset.p === 'qtd'){ const q = Math.floor((+mx2.slice(5, 7) - 1) / 3) * 3 + 1; f = mx2.slice(0, 5) + String(q).padStart(2, '0') + '-01'; }
    else if(b.dataset.p === 'ytd') f = mx2.slice(0, 4) + '-01-01';
    else if(b.dataset.p === '12m') f = addDaysIso(addMonths(mx2, -12), 1);
    SP.from = f; SP.to = t; $('#spFrom').value = f; $('#spTo').value = t; renderSP(); };
  $('#spCompare').onchange = () => { SP.compare = $('#spCompare').value; renderSP(); };
  [['#spPic','pic'],['#spMpl','mpl'],['#spSpl','spl'],['#spCh','ch']].forEach(([id, k]) => $(id).onchange = () => { SP[k] = $(id).value; SP.invSel = null; renderSP(false); });
  $('#spReset').onclick = () => { SP.pic = SP.mpl = SP.spl = SP.ch = ''; ['#spPic','#spMpl','#spSpl','#spCh'].forEach(id => $(id).value = ''); SP.invSel = null; renderSP(false); };
  $('#spGrain').onclick = e => { const b = e.target.closest('[data-g]'); if(!b) return; SP.grain = b.dataset.g; spTrend(); };
  $('#spLevel').onclick = e => { const b = e.target.closest('[data-l]'); if(!b) return; SP.relLevel = b.dataset.l; spRel(); };
  $('#spH').onclick = e => { const b = e.target.closest('[data-h]'); if(!b) return; SP.h = +b.dataset.h; spInv(); };
  ['#spCx','#spCy','#spCs'].forEach(id => $(id).onchange = () => { SP.x = $('#spCx').value; SP.y = $('#spCy').value; SP.s = $('#spCs').value; spRel(); });
  $('#spExport').onclick = spExport;
  SPbuilt = true;
}
function spComparePeriod(){
  if(SP.compare === 'yoy') return [addMonths(SP.from, -12), addMonths(SP.to, -12)];
  const n = daysBetweenInclusive(SP.from, SP.to); return [addDaysIso(SP.from, -n), addDaysIso(SP.from, -1)];
}
function spScope(ignore){
  return ROWS.filter(r => (!SP.pic || r.pic === SP.pic) && (!SP.mpl || r.mainPL === SP.mpl) && (ignore === 'spl' || !SP.spl || r.subPL === SP.spl) && (!SP.ch || r.channel === SP.ch) && matchGS(r));
}
function aggFor(rows, map){ const a = emptyAgg(); rows.forEach(r => { const x = map.get(r.sku); if(x) addInto(a, x); }); return derive(a); }
async function renderSP(refetch = true){
  if(!SPbuilt) spBuild();
  if(!V2.state.schemaOk){ $('#spSchema').innerHTML = schemaHint; }
  $$('#spGrain .cv-btn').forEach(b => b.classList.toggle('active', b.dataset.g === SP.grain));
  $$('#spLevel .cv-btn').forEach(b => b.classList.toggle('active', b.dataset.l === SP.relLevel));
  $$('#spH .cv-btn').forEach(b => b.classList.toggle('active', +b.dataset.h === SP.h));
  const [pf, pt] = spComparePeriod();
  const key = [SP.from, SP.to, pf, pt].join('|');
  if(refetch || key !== SP.key){
    $('#spPeriodTitle').textContent = 'Đang tải…';
    try {
      const [cur, prev] = await Promise.all([rpcAll('sales_by_sku', {p_from: SP.from, p_to: SP.to}), rpcAll('sales_by_sku', {p_from: pf, p_to: pt})]);
      SP.cur = new Map(cur.map(r => [r.sku, withCm3(r.sku, r)])); SP.prev = new Map(prev.map(r => [r.sku, withCm3(r.sku, r)])); SP.key = key;
    } catch(e){ console.error(e); if(missingSchema(e)) { $('#spSchema').innerHTML = schemaHint; } $('#spPeriodTitle').textContent = 'Không tải được dữ liệu: ' + (e.message || e); return; }
  }
  const scope = spScope();
  cm3Blend = blendFor(scope);
  $('#spCount').textContent = scope.length + ' / ' + ROWS.length + ' SKU';
  $('#spPeriodTitle').textContent = `Tổng quan · ${dm(SP.from)}/${SP.from.slice(0, 4)} → ${dm(SP.to)}/${SP.to.slice(0, 4)} so với ${dm(pf)}/${pf.slice(0, 4)} → ${dm(pt)}/${pt.slice(0, 4)}` + (SP.to >= (V2.state.lockBefore || '9999') ? ' · dữ liệu tháng hiện tại cập nhật theo giờ' : '');
  spTiles(scope, pf, pt);
  spTrend(); spTree(); spRel(); spInv(); spSkuTable();
  SPdirty = false;
  if(GS.sku && SP.openedFor !== GS.sku){ SP.openedFor = GS.sku; openSkuDetail(GS.sku); }
  if(!GS.sku) SP.openedFor = null;
}
async function spTiles(scope){
  const c = aggFor(scope, SP.cur), p = aggFor(scope, SP.prev);
  const keys = ['gmv','units','asp','mkt','mktGmv','ads','tacos','acos','promo','promoGmv','ads_units','glance_views','cr','cm3','cm3Pct'];
  const cmp = SP.compare === 'yoy' ? 'vs LY' : 'vs kỳ trước';
  const noGv = !(c.glance_views > 0);
  $('#spTiles').innerHTML = keys.map(k => (noGv && (k === 'glance_views' || k === 'cr'))
    ? `<div class="tile"><div class="k">${M[k].l}</div><div class="v">—</div><div class="d"><span title="File hourly của tháng hiện tại không có cột Glance_views; số sẽ có khi nạp file daily">nguồn chưa có glance view</span></div><div class="spk" data-k="${k}"></div></div>`
    : `<div class="tile"><div class="k">${M[k].l}</div><div class="v">${M[k].f(c[k])}</div><div class="d">${deltaHtml(c[k], p[k], M[k].inv, M[k].rate)}<span>${cmp}</span></div><div class="spk" data-k="${k}"></div></div>`).join('');
  // sparklines: last 12 months for the same scope
  try {
    const to = SP.to, from = addMonths(to.slice(0, 8) + '01', -11);
    const skus = scope.length === ROWS.length ? null : scope.map(r => r.sku);
    const tr = await rpcAll('sales_trend', {p_from: from, p_to: to, p_grain: 'month', p_skus: skus});
    const rows = tr.map(r => derive(addInto(emptyAgg(), withCm3Trend(r, scope))));
    $$('#spTiles .spk').forEach(el => { el.innerHTML = spark(rows.map(a => a[el.dataset.k]), '#2a78d6'); });
  } catch(e){ console.warn(e); }
}
// CM3 for trend rows (the trend RPC has no SKU split): use the scope's blended
// CM3 base per unit and costed shares from the selected period. Estimate only.
let cm3Blend = null;
function blendFor(scope){
  const c = aggFor(scope, SP.cur);
  return {base: div(c.cm3_base, c.cm3_units), unitShare: div(c.cm3_units, c.units), gmvShare: div(c.cm3_gmv, c.gmv), mktShare: div(c.cm3_mkt, c.ads * .985 + c.promo)};
}
function withCm3Trend(r, scope){
  const b = cm3Blend || blendFor(scope);
  const o = {...r};
  if(isNum(b.base) && isNum(b.unitShare)){
    o.cm3 = (+r.units || 0) * b.unitShare * b.base - ((+r.ads || 0) * .985 + (+r.promo || 0)) * (isNum(b.mktShare) ? b.mktShare : 1);
    o.cm3_gmv = (+r.gmv || 0) * (isNum(b.gmvShare) ? b.gmvShare : 0);
  } else { o.cm3 = 0; o.cm3_gmv = 0; }
  return o;
}
function spGrain(){
  if(SP.grain !== 'auto') return SP.grain;
  const n = daysBetweenInclusive(SP.from, SP.to);
  return n <= 62 ? 'day' : n <= 400 ? 'week' : 'month';
}
async function spTrend(){
  $$('#spGrain .cv-btn').forEach(b => b.classList.toggle('active', b.dataset.g === SP.grain));
  const rateColors = CAT5.slice(0, 3);
  chipRow($('#spAbs'), ABS_KEYS.map(k => ({k, l:M[k].l})), m => m.k === SP.abs, m => { SP.abs = m.k; spTrend(); });
  chipRow($('#spRates'), RATE_KEYS.map(k => ({k, l:M[k].l})), m => SP.rates.includes(m.k), m => { if(SP.rates.includes(m.k)) SP.rates = SP.rates.filter(x => x !== m.k); else { SP.rates.push(m.k); if(SP.rates.length > 3) SP.rates.shift(); } spTrend(); }, m => rateColors[SP.rates.indexOf(m.k)]);
  const scope = spScope(); const g = spGrain();
  const skus = scope.length === ROWS.length ? null : scope.map(r => r.sku);
  const [pf, pt] = spComparePeriod();
  let cur, prev;
  try { [cur, prev] = await Promise.all([rpcAll('sales_trend', {p_from: SP.from, p_to: SP.to, p_grain: g, p_skus: skus}), rpcAll('sales_trend', {p_from: pf, p_to: pt, p_grain: g, p_skus: skus})]); }
  catch(e){ $('#spTrend').innerHTML = '<div class="notice">Không tải được trend: ' + esc(e.message || e) + '</div>'; return; }
  const shift = SP.compare === 'yoy' ? (g === 'month' ? (iso => addMonths(iso, 12)) : (iso => addDaysIso(iso, 364))) : (iso => addDaysIso(iso, daysBetweenInclusive(SP.from, SP.to)));
  const prevBy = new Map(prev.map(r => [ g === 'month' ? shift(r.period) : (g === 'week' ? sundayOf(shift(r.period)) : shift(r.period)), derive(addInto(emptyAgg(), withCm3Trend(r, scope)))]));
  const cA = cur.map(r => derive(addInto(emptyAgg(), withCm3Trend(r, scope))));
  const x = cur.map(r => r.period);
  const am = M[SP.abs]; const money = ['gmv','mkt','ads','promo','cm3','asp'].includes(SP.abs);
  const fmtX = g === 'month' ? '%b-%y' : '%d/%m';
  const data = [
    {type:'bar', x, y:cA.map(a => a[SP.abs]), name:am.l + ' kỳ này', marker:{color:'#2a78d6'}, xaxis:'x', yaxis:'y', hovertemplate:`%{x|${g === 'month' ? '%b-%Y' : '%d/%m/%Y'}}<br>${am.l}: ${money ? '$' : ''}%{y:,.${SP.abs === 'asp' ? 2 : 0}f}<extra></extra>`},
    {type:'scatter', mode:'lines+markers', x, y:x.map(p => { const a = prevBy.get(p); return a ? a[SP.abs] : null; }), name:am.l + (SP.compare === 'yoy' ? ' năm trước' : ' kỳ trước'), line:{color:'#8A94A3', width:1.6, dash:'dot'}, marker:{size:4, color:'#8A94A3'}, xaxis:'x', yaxis:'y', hovertemplate:`${SP.compare === 'yoy' ? 'LY' : 'Kỳ trước'}: ${money ? '$' : ''}%{y:,.${SP.abs === 'asp' ? 2 : 0}f}<extra></extra>`},
  ];
  SP.rates.forEach((k, i) => data.push({type:'scatter', mode:'lines+markers', x, y:cA.map(a => a[k]), name:M[k].l, line:{color:rateColors[i], width:2}, marker:{size:6, color:rateColors[i], line:{width:1.5, color:'#fff'}}, xaxis:'x', yaxis:'y2', hovertemplate:`${M[k].l}: %{y:.${k === 'cr' || k === 'ctr' ? 2 : 1}%}<extra></extra>`}));
  draw('spTrend', data, lay({
    grid:{rows:2, columns:1, subplots:[['xy'],['xy2']], roworder:'top to bottom'},
    xaxis:ax({anchor:'y2', type:'date', tickformat:fmtX}), yaxis:ax({domain:[.44, 1], title:{text:am.l, font:{color:PAL.muted, size:11}}, tickprefix:money ? '$' : '', tickformat:SP.abs === 'asp' ? ',.0f' : '~s', rangemode:'tozero'}),
    yaxis2:ax({domain:[0, .36], title:{text:'Tỷ lệ', font:{color:PAL.muted, size:11}}, tickformat:'.0%', rangemode:'tozero'}),
    hovermode:'x unified', bargap:.3, margin:{l:62, r:16, t:8, b:60}, legend:{orientation:'h', y:-.14, x:0, font:{color:PAL.muted, size:11}},
  }));
}
function groupAgg(rows, keyFn, map){
  const g = new Map();
  rows.forEach(r => { const k = keyFn(r) || 'Unclassified'; if(!g.has(k)) g.set(k, {rows:[], a:emptyAgg()}); const e = g.get(k); e.rows.push(r); const x = map.get(r.sku); if(x) addInto(e.a, x); });
  g.forEach(e => derive(e.a));
  return g;
}
function spTree(){
  const scope = spScope('spl');
  const cur = groupAgg(scope, r => r.subPL, SP.cur), prev = groupAgg(scope, r => r.subPL, SP.prev);
  const items = [...cur].filter(([, e]) => e.a.gmv > 0).sort((a, b) => b[1].a.gmv - a[1].a.gmv);
  const ROOT = 'Tất cả';
  const labels = [ROOT, ...items.map(([k]) => k)];
  const maxAbs = Math.max(.05, ...items.map(([, e]) => Math.abs(e.a.cm3Pct)).filter(isNum));
  const col = [0, ...items.map(([, e]) => isNum(e.a.cm3Pct) ? e.a.cm3Pct : null)];
  draw('spTree', [{
    type:'treemap', labels, parents: labels.map((l, i) => i ? ROOT : ''), values:[items.reduce((t, [, e]) => t + e.a.gmv, 0), ...items.map(([, e]) => e.a.gmv)], branchvalues:'total',
    marker:{colors: col.map(v => v === null ? 0 : v), colorscale:divScale, cmin:-maxAbs, cmax:maxAbs, cmid:0, pad:{t:0, l:0, r:0, b:0},
      line:{width: labels.map(l => l === SP.spl ? 4 : 2), color: labels.map(l => l === SP.spl ? '#FF7000' : '#fff')},
      colorbar:{title:{text:'CM3 %', font:{size:10.5, color:PAL.muted}}, tickformat:'.0%', thickness:10, len:.8, outlinewidth:0, tickfont:{color:PAL.muted}}},
    customdata:[[0,0,0,0,0,0,NaN], ...items.map(([k, e]) => { const p = prev.get(k); return [e.a.gmv, e.a.units, e.a.mktGmv, e.a.acos, e.a.cm3, e.a.cm3Pct, p && p.a.gmv ? e.a.gmv / p.a.gmv - 1 : NaN]; })],
    texttemplate:'<b>%{label}</b><br>%{customdata[0]:$,.3s}<br>CM3 %{customdata[5]:.1%}', textfont:{family:'Poppins, Arial', size:11.5, color:PAL.ink},
    hovertemplate:'<b>%{label}</b><br>GMV: %{customdata[0]:$,.0f} (so sánh %{customdata[6]:+.1%})<br>Units: %{customdata[1]:,.0f}<br>%MKT/GMV: %{customdata[2]:.1%}<br>ACOS: %{customdata[3]:.1%}<br>CM3: %{customdata[4]:$,.0f} · %{customdata[5]:.1%}<extra>Bấm để lọc</extra>',
    tiling:{pad:2}, pathbar:{visible:false},
  }], lay({margin:{l:0, r:0, t:0, b:0}}));
  const el = $('#spTree');
  if(el.removeAllListeners) el.removeAllListeners('plotly_treemapclick');
  if(el.on) el.on('plotly_treemapclick', ev => { const pl = ev.points[0].label; if(pl !== ROOT){ SP.spl = SP.spl === pl ? '' : pl; $('#spSpl').value = SP.spl; SP.invSel = null; renderSP(false); } return false; });
  const maxG = Math.max(1, ...items.map(([, e]) => e.a.gmv));
  $('#spRank').innerHTML = `<thead><tr><th>Old PL</th><th class="num">GMV</th><th class="num">So sánh</th><th class="num">CM3 %</th></tr></thead><tbody>` + items.map(([k, e]) => { const p = prev.get(k);
    return `<tr class="clickable${k === SP.spl ? ' sel' : ''}" data-k="${esc(k)}"><td style="white-space:normal;min-width:130px">${esc(k)}<div class="progress-track" style="height:4px;margin-top:3px"><div class="progress-fill" style="width:${(e.a.gmv / maxG * 100).toFixed(1)}%;background:#2a78d6"></div></div></td><td class="num">${f$(e.a.gmv)}</td><td class="num">${deltaHtml(e.a.gmv, p ? p.a.gmv : NaN)}</td><td class="num">${fP(e.a.cm3Pct)}</td></tr>`; }).join('') + '</tbody>';
  $$('#spRank tr.clickable').forEach(tr => tr.onclick = () => { SP.spl = SP.spl === tr.dataset.k ? '' : tr.dataset.k; $('#spSpl').value = SP.spl; SP.invSel = null; renderSP(false); });
}
const PRESETS = [
  {id:'promoAds', l:'Promo vs Ads', x:'promo', y:'ads', s:'gmv', read:'Chấm cao (nhiều Ads) mà màu xanh dương = Ads đang hiệu quả; chấm lệch phải và đỏ = phụ thuộc Promo nhưng margin âm.'},
  {id:'priceCm3', l:'Giá × chi phí MKT × CM3', x:'asp', y:'cm3Unit', s:'mktUnit', read:'Bong bóng to (MKT/unit cao) nằm dưới vạch 0 = marketing đang ăn hết margin. Giá cao không tự động đồng nghĩa CM3 tốt.'},
  {id:'mktGrowth', l:'%MKT/GMV vs tăng trưởng', x:'mktGmv', y:'gmvYoy', s:'gmv', read:'Tương quan yếu nghĩa là chi thêm MKT không đi kèm tăng trưởng. Tìm các chấm góc dưới-phải (chi nhiều, tăng ít).'},
  {id:'adsUnits', l:'Ads $ vs Ads units', x:'ads', y:'ads_units', s:'gmv', read:'Độ dốc là số unit mua được trên mỗi $ ads. Chấm nằm dưới đường xu hướng đang kém hiệu quả hơn mặt bằng chung.'},
  {id:'gvCr', l:'Glance view vs CR', x:'glance_views', y:'cr', s:'gmv', read:'Nhiều traffic mà CR thấp: xem lại giá, hình ảnh, review. Ít traffic mà CR cao: nên tăng ads.'},
  {id:'tacosCm3', l:'TACOS vs CM3 %', x:'tacos', y:'cm3Pct', s:'gmv', read:'Tương quan âm mạnh nghĩa là CM3 nhạy với chi ads; nên đặt trần TACOS theo group.'},
  {id:'custom', l:'Tùy chọn…'},
];
function spRel(){
  chipRow($('#spPreset'), PRESETS, p => p.id === SP.preset, p => { SP.preset = p.id; if(p.id !== 'custom'){ SP.x = p.x; SP.y = p.y; SP.s = p.s; } spRel(); });
  $$('#spLevel .cv-btn').forEach(b => b.classList.toggle('active', b.dataset.l === SP.relLevel));
  $('#spCustom').hidden = SP.preset !== 'custom'; $('#spCx').value = SP.x; $('#spCy').value = SP.y; $('#spCs').value = SP.s;
  const scope = spScope();
  const keyFn = SP.relLevel === 'spl' ? r => r.subPL : SP.relLevel === 'mpl' ? r => r.mainPL : r => r.sku;
  const cur = groupAgg(scope, keyFn, SP.cur), prev = groupAgg(scope, keyFn, SP.prev);
  let pts = [...cur].map(([k, e]) => { const a = e.a; const p = prev.get(k); a.gmvYoy = p && p.a.gmv ? a.gmv / p.a.gmv - 1 : NaN; a.key = k; a.pl = e.rows[0].mainPL; a.name = e.rows[0].productName; return a; })
    .filter(a => a.gmv > 0 && isNum(a[SP.x]) && isNum(a[SP.y]));
  if(SP.relLevel === 'sku') pts = pts.sort((a, b) => b.gmv - a.gmv).slice(0, 300);
  const xs = pts.map(a => a[SP.x]), ys = pts.map(a => a[SP.y]);
  const r = pearson(xs, ys), rho = pearson(ranks(xs), ranks(ys));
  const sz = pts.map(a => Math.max(0, a[SP.s]) || 0), smax = Math.max(1e-9, ...sz);
  const mx = M[SP.x], my = M[SP.y], ms = M[SP.s];
  const tf = m => m.rate ? '.1%' : ['asp','cm3Unit','mktUnit'].includes(Object.keys(M).find(k => M[k] === m)) ? '$,.2f' : ['units','ads_units','glance_views','clicks','impressions'].includes(Object.keys(M).find(k => M[k] === m)) ? ',.0f' : '$,.0f';
  const maxAbs = Math.max(.05, ...pts.map(a => Math.abs(a.cm3Pct)).filter(isNum));
  const topN = [...pts].sort((a, b) => b.gmv - a.gmv).slice(0, SP.relLevel === 'sku' ? 0 : 5).map(a => a.key);
  const data = [{type:'scatter', mode:'markers+text', x:xs, y:ys, text:pts.map(a => topN.includes(a.key) ? a.key : ''), textposition:'top center', textfont:{size:10, color:PAL.muted},
    marker:{size:sz.map(s => 8 + 32 * Math.sqrt(s / smax)), color:pts.map(a => isNum(a.cm3Pct) ? a.cm3Pct : 0), colorscale:divScale, cmin:-maxAbs, cmax:maxAbs, cmid:0, opacity:.85, line:{width:1.5, color:'#fff'},
      colorbar:{title:{text:'CM3 %', font:{size:10.5, color:PAL.muted}}, tickformat:'.0%', thickness:10, len:.7, outlinewidth:0, tickfont:{color:PAL.muted}}},
    customdata:pts.map(a => [a.key, a.pl, a.gmv, a.cm3Pct, a[SP.s], (a.name || '').slice(0, 60)]),
    hovertemplate:`<b>%{customdata[0]}</b>${SP.relLevel === 'sku' ? '<br>%{customdata[5]}<br>%{customdata[1]}' : ''}<br>${mx.l}: %{x:${tf(mx)}}<br>${my.l}: %{y:${tf(my)}}<br>${ms.l}: %{customdata[4]:${tf(ms)}}<br>GMV %{customdata[2]:$,.0f} · CM3 %{customdata[3]:.1%}<extra></extra>`, showlegend:false}];
  if(pts.length >= 3){ const {a, b} = ols(xs, ys); const lo = Math.min(...xs), hi = Math.max(...xs); data.push({type:'scatter', mode:'lines', x:[lo, hi], y:[a + b*lo, a + b*hi], line:{color:PAL.ink, width:1.4, dash:'dash'}, hoverinfo:'skip', showlegend:false}); }
  const med = arr => { const s = [...arr].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const shapes = pts.length ? [{type:'line', xref:'x', yref:'paper', x0:med(xs), x1:med(xs), y0:0, y1:1, line:{color:'#D5D9DF', width:1.3}}, {type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:med(ys), y1:med(ys), line:{color:'#D5D9DF', width:1.3}}] : [];
  if(['cm3Unit','cm3Pct','gmvYoy'].includes(SP.y)) shapes.push({type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:0, y1:0, line:{color:PAL.crit, width:1.4, dash:'dot'}});
  const tick = m => m.rate ? {tickformat:'.0%'} : ['units','ads_units','glance_views'].includes(Object.keys(M).find(k => M[k] === m)) ? {tickformat:'~s'} : {tickprefix:'$', tickformat:'~s'};
  draw('spRel', data, lay({xaxis:ax({title:{text:mx.l, font:{color:PAL.muted, size:11}}, ...tick(mx)}), yaxis:ax({title:{text:my.l, font:{color:PAL.muted, size:11}}, ...tick(my)}), shapes, margin:{l:62, r:8, t:8, b:46}, hovermode:'closest'}));
  $('#spCorr').innerHTML = `<div class="box"><div class="t">Pearson r</div><div class="v">${isNum(r) ? r.toFixed(2) : '—'}</div><span class="badge ${Math.abs(r) >= .5 ? 'green' : Math.abs(r) >= .3 ? 'amber' : 'gray'}">${strength(r)}</span></div><div class="box"><div class="t">Spearman ρ</div><div class="v">${isNum(rho) ? rho.toFixed(2) : '—'}</div><div class="t">theo thứ hạng, ít bị outlier kéo</div></div><div class="box"><div class="t">R²</div><div class="v">${isNum(r) ? (r*r).toFixed(2) : '—'}</div><div class="t">n = ${pts.length}</div></div>`;
  const pr = PRESETS.find(p => p.id === SP.preset);
  $('#spRead').innerHTML = `<b>Đọc nhanh:</b> tương quan ${strength(r)}${isNum(r) ? ` (${mx.l} càng cao thì ${my.l} càng ${r > 0 ? 'cao' : 'thấp'})` : ''}. ${pr && pr.read ? esc(pr.read) : ''}<br><span class="v2-note">Kích thước = ${esc(ms.l)}, màu = CM3 %.</span>`;
}

// inventory vs demand ------------------------------------------------------
function weeklyDemand(k, weeks){
  const dem = V2.state.demand.get(k.sku);
  const vel = k.sig && isNum(k.sig.vel) ? k.sig.vel * 7 : (k.docVelocity || 0) * 7;
  return weeks.map(ws => {
    if(dem && dem.length){ const mid = addDaysIso(ws, 3); const m = dem.find(d => d.month.slice(0, 7) === mid.slice(0, 7)); if(m) return m.units * 7 / daysIn(mid); }
    return vel;
  });
}
function invRows(){
  const asOf = V2.state.maxDate || todayISO();
  const start = addDaysIso(sundayOf(asOf), 7);
  const weeks = Array.from({length: SP.h}, (_, i) => addDaysIso(start, 7 * i));
  const scope = spScope();
  const byKey = new Map();
  const keyFn = SP.mpl || SP.spl || GS.sku ? (r => r.sku) : (r => r.mainPL);
  scope.forEach(k => { const key = keyFn(k); if(!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(k); });
  return {weeks, rows: [...byKey].map(([key, ks]) => {
    let onhand = 0; const inc = new Array(SP.h).fill(0), dem = new Array(SP.h).fill(0); let fromForecast = 0;
    ks.forEach(k => { onhand += stockOf(k); (V2.state.incoming.get(k.sku) || []).forEach(x => { const i = weeks.indexOf(sundayOf(x.week)); if(i >= 0) inc[i] += x.qty; else if(x.week < weeks[0]) onhand += 0; }); const d = weeklyDemand(k, weeks); d.forEach((v, i) => dem[i] += v); if(V2.state.demand.has(k.sku)) fromForecast++; });
    let bal = onhand, stockout = null, lost = 0; const end = [];
    for(let i = 0; i < SP.h; i++){ bal += inc[i]; const sold = Math.min(bal, dem[i]); lost += dem[i] - sold; bal -= sold; end.push(bal); if(stockout === null && dem[i] > .5 && bal <= .5) stockout = i + 1; }
    const avg = dem.reduce((a, b) => a + b, 0) / SP.h;
    const coverNow = avg ? onhand / avg : Infinity, coverEnd = avg ? bal / avg : Infinity;
    const status = stockout !== null ? 'short' : coverEnd > 16 ? 'over' : coverEnd < 4 ? 'watch' : 'ok';
    return {key, n: ks.length, onhand, inc, dem, end, totalInc: inc.reduce((a, b) => a + b, 0), avg, coverNow, coverEnd, stockout, lost, status, fromForecast, name: ks.length === 1 ? ks[0].productName : ''};
  }).filter(r => r.onhand > 0 || r.avg > 0.1 || r.totalInc > 0).sort((a, b) => (isNum(a.coverNow) ? a.coverNow : 1e9) - (isNum(b.coverNow) ? b.coverNow : 1e9))};
}
const INVST = {short:['red','Thiếu hàng'], watch:['amber','Sát ngưỡng'], ok:['green','Khỏe'], over:['gray','Dư hàng']};
function spInv(){
  $$('#spH .cv-btn').forEach(b => b.classList.toggle('active', +b.dataset.h === SP.h));
  const {weeks, rows} = invRows();
  const S = V2.state;
  $('#spInvHint').innerHTML = `Tồn Y4A + AMZ (USA Inventory${S.incomingAsOf ? ' ' + dm(S.incomingAsOf) : ''}) + incoming theo tuần về, trừ nhu cầu dự báo (6-month demand trong file target; SKU không có thì dùng tốc độ bán 5 tuần gần nhất). Thiếu hàng = tồn chạm 0 trong horizon; khỏe = 4–16 tuần cover cuối kỳ; dư = &gt; 16 tuần.`;
  const shown = rows.slice(0, 40);
  if(!shown.find(r => r.key === SP.invSel)) SP.invSel = shown.length ? shown[0].key : null;
  const col = st => ({short:PAL.crit, watch:PAL.warn, ok:PAL.good, over:PAL.other})[st];
  const ord = [...shown].reverse(), cap = 40;
  draw('spCover', [{type:'bar', orientation:'h', y:ord.map(r => r.key), x:ord.map(r => Math.min(cap, isNum(r.coverNow) ? r.coverNow : cap)),
    marker:{color:ord.map(r => col(r.status)), line:{width:ord.map(r => r.key === SP.invSel ? 2.5 : 0), color:PAL.ink}},
    text:ord.map(r => INVST[r.status][1]), textposition:'outside', textfont:{size:10, color:PAL.muted}, cliponaxis:false,
    customdata:ord.map(r => [r.onhand, r.totalInc, r.avg, isNum(r.coverEnd) ? r.coverEnd : 999, r.stockout ? 'tuần ' + r.stockout : 'không', r.name || '']),
    hovertemplate:'<b>%{y}</b> %{customdata[5]}<br>Tồn: %{customdata[0]:,.0f}<br>Incoming: %{customdata[1]:,.0f}<br>Nhu cầu: %{customdata[2]:,.0f}/tuần<br>Cover hiện tại: %{x:.1f} tuần<br>Cover cuối kỳ: %{customdata[3]:.1f} tuần<br>Hết hàng: %{customdata[4]}<extra></extra>'}],
    lay({xaxis:ax({title:{text:'Weeks of cover hiện tại (cắt ở 40)', font:{color:PAL.muted, size:11}}, range:[0, cap + 9]}), yaxis:ax({automargin:true, tickfont:{size:10, color:PAL.muted}}), margin:{l:8, r:8, t:6, b:42}, showlegend:false, bargap:.3,
      shapes:[4, 16].map(v => ({type:'line', xref:'x', yref:'paper', x0:v, x1:v, y0:0, y1:1, line:{color:PAL.muted, width:1, dash:'dot'}})), height:Math.max(360, shown.length * 22 + 70)}));
  const el = $('#spCover'); if(el.removeAllListeners) el.removeAllListeners('plotly_click'); if(el.on) el.on('plotly_click', ev => { SP.invSel = ev.points[0].y; spInv(); });
  const r = shown.find(x => x.key === SP.invSel);
  if(r){
    const wl = weeks.map(w => 'W ' + dm(w));
    $('#spProjTitle').innerHTML = `Dự phóng tồn kho · ${esc(r.key)} <span class="badge ${INVST[r.status][0]}">${INVST[r.status][1]}</span>`;
    draw('spProj', [
      {type:'bar', x:wl, y:r.dem, name:'Nhu cầu dự báo', marker:{color:'#2a78d6'}, hovertemplate:'%{x}<br>Nhu cầu: %{y:,.0f}<extra></extra>'},
      {type:'bar', x:wl, y:r.inc, name:'Incoming', marker:{color:'#E86A10'}, hovertemplate:'%{x}<br>Incoming: %{y:,.0f}<extra></extra>'},
      {type:'scatter', mode:'lines+markers', x:wl, y:r.end, name:'Tồn cuối tuần', line:{color:PAL.ink, width:2}, marker:{size:6, color:r.end.map(v => v <= .5 ? PAL.crit : PAL.ink), line:{width:1.5, color:'#fff'}}, hovertemplate:'%{x}<br>Tồn cuối: %{y:,.0f}<extra></extra>'},
    ], lay({barmode:'group', bargap:.35, xaxis:ax({tickangle:-45, tickfont:{size:9.5, color:PAL.muted}}), yaxis:ax({title:{text:'Units', font:{color:PAL.muted, size:11}}, rangemode:'tozero', tickformat:'~s'}), margin:{l:52, r:8, t:6, b:86}, legend:{orientation:'h', y:-.45, x:0, font:{color:PAL.muted, size:11}}, hovermode:'x unified'}));
  }
  $('#spInvTable').innerHTML = `<thead><tr><th>${rows.length && rows[0].n === 1 ? 'SKU' : 'Main PL'}</th><th>Trạng thái</th><th class="num">Tồn</th><th class="num">Incoming</th><th class="num">Nhu cầu/tuần</th><th class="num">Cover hiện tại</th><th class="num">Cover cuối kỳ</th><th class="num">Units có thể mất</th><th>Nguồn nhu cầu</th></tr></thead><tbody>` +
    rows.map(r => `<tr class="clickable${r.key === SP.invSel ? ' sel' : ''}" data-k="${esc(r.key)}"><td>${esc(r.key)}${r.name ? ' <span class="v2-note">' + esc(r.name.slice(0, 40)) + '</span>' : ''}</td><td><span class="badge ${INVST[r.status][0]}">${INVST[r.status][1]}</span></td><td class="num">${fmtInt(r.onhand)}</td><td class="num">${fmtInt(r.totalInc)}</td><td class="num">${fN(r.avg)}</td><td class="num">${isNum(r.coverNow) ? r.coverNow.toFixed(1) + ' w' : '∞'}</td><td class="num">${isNum(r.coverEnd) ? r.coverEnd.toFixed(1) + ' w' : '∞'}</td><td class="num">${r.lost > .5 ? fmtInt(r.lost) : '—'}</td><td class="v2-note">${r.fromForecast ? r.fromForecast + '/' + r.n + ' SKU theo forecast' : 'tốc độ bán'}</td></tr>`).join('') + '</tbody>';
  $$('#spInvTable tr.clickable').forEach(tr => tr.onclick = () => { SP.invSel = tr.dataset.k; spInv(); });
}

// SKU breakdown -----------------------------------------------------------
const SP_COLS = [
  ['sku','SKU'],['productName','Product name'],['pic','PIC'],['mainPL','Main PL'],['subPL','Old PL'],['gmv','GMV'],['gmvD','So sánh'],['units','Units'],['asp','ASP'],['rrp','RRP'],
  ['ads','Ads'],['acos','ACOS'],['tacos','TACOS'],['promo','Promo'],['mktGmv','%MKT/GMV'],['glance_views','GV'],['cr','CR'],['cm3Pct','CM3 %'],['stock','Tồn'],['cover','Cover (tuần)'],
];
let spSkuRows = [];
function spSkuTable(){
  const scope = spScope();
  spSkuRows = scope.map(k => { const a = derive(addInto(emptyAgg(), SP.cur.get(k.sku) || {})); const p = derive(addInto(emptyAgg(), SP.prev.get(k.sku) || {}));
    const vel = k.sig && isNum(k.sig.vel) ? k.sig.vel * 7 : 0;
    return {...a, sku:k.sku, asin:k.asin, productName:k.productName, pic:k.pic, mainPL:k.mainPL, subPL:k.subPL, rrp:k.rrp, gmvD: p.gmv ? a.gmv / p.gmv - 1 : NaN, prevGmv:p.gmv, stock:stockOf(k), cover: vel ? stockOf(k) / vel : (stockOf(k) > 0 ? Infinity : NaN)}; })
    .filter(r => r.gmv > 0 || r.prevGmv > 0 || r.stock > 0);
  const k = SP.sortKey;
  spSkuRows.sort((a, b) => { const va = a[k], vb = b[k]; if(typeof va === 'string' || typeof vb === 'string') return SP.sortDir * String(va || '').localeCompare(String(vb || '')); return SP.sortDir * ((isNum(va) ? va : (va === Infinity ? 1e12 : -1e12)) - (isNum(vb) ? vb : (vb === Infinity ? 1e12 : -1e12))); });
  const cell = (r, c) => {
    switch(c){
      case 'sku': return r.asin ? `<a href="https://www.amazon.com/dp/${encodeURIComponent(r.asin)}" target="_blank" rel="noopener noreferrer" style="color:var(--navy);font-weight:700;text-decoration:none;border-bottom:1px dashed var(--navy)" title="Mở listing ${esc(r.asin)}" onclick="event.stopPropagation()">${esc(r.sku)}</a>` : `<b>${esc(r.sku)}</b>`;
      case 'productName': return `<span class="name-cell" style="display:inline-block;max-width:230px" title="${esc(r.productName)}">${esc(r.productName || '')}</span>`;
      case 'pic': case 'mainPL': case 'subPL': return esc(r[c] || '');
      case 'gmvD': return deltaHtml(r.gmv, r.prevGmv);
      case 'gmv': case 'ads': case 'promo': return f$(r[c]);
      case 'asp': case 'rrp': return r[c] > 0 ? f$2(r[c]) : '—';
      case 'units': case 'glance_views': case 'stock': return fN(r[c]);
      case 'cover': return isNum(r.cover) ? `<span class="badge ${r.cover < 2 ? 'red' : r.cover < 4 ? 'amber' : r.cover > 16 ? 'gray' : 'green'}">${r.cover.toFixed(1)}</span>` : (r.cover === Infinity ? '∞' : '—');
      case 'cr': return fP(r.cr, 2);
      default: return fP(r[c]);
    }
  };
  $('#spSkuTable').innerHTML = `<thead><tr>${SP_COLS.map(([k2, l]) => `<th data-k="${k2}" class="${['sku','productName','pic','mainPL','subPL'].includes(k2) ? '' : 'num'}">${l}${SP.sortKey === k2 ? (SP.sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead><tbody>` +
    spSkuRows.map(r => `<tr class="clickable" data-sku="${esc(r.sku)}">${SP_COLS.map(([c]) => `<td class="${['sku','productName','pic','mainPL','subPL'].includes(c) ? '' : 'num'}">${cell(r, c)}</td>`).join('')}</tr>`).join('') + '</tbody>';
  $$('#spSkuTable th').forEach(th => th.onclick = () => { const k2 = th.dataset.k; if(SP.sortKey === k2) SP.sortDir *= -1; else { SP.sortKey = k2; SP.sortDir = -1; } spSkuTable(); });
  $$('#spSkuTable tr.clickable').forEach(tr => tr.onclick = () => openSkuDetail(tr.dataset.sku));
}
function spExport(){
  if(!spSkuRows.length){ toast('Không có dòng nào để export'); return; }
  const data = spSkuRows.map(r => ({SKU:r.sku, ASIN:r.asin, 'Product name':r.productName, PIC:r.pic, 'Main PL':r.mainPL, 'Old PL':r.subPL, GMV:+r.gmv.toFixed(2), 'GMV so sánh':+(r.prevGmv || 0).toFixed(2), Units:r.units, ASP:isNum(r.asp) ? +r.asp.toFixed(2) : '', RRP:r.rrp || '', Ads:+r.ads.toFixed(2), ACOS:isNum(r.acos) ? +r.acos.toFixed(4) : '', TACOS:isNum(r.tacos) ? +r.tacos.toFixed(4) : '', Promo:+r.promo.toFixed(2), '%MKT/GMV':isNum(r.mktGmv) ? +r.mktGmv.toFixed(4) : '', 'Glance views':r.glance_views, CR:isNum(r.cr) ? +r.cr.toFixed(4) : '', 'CM3 %':isNum(r.cm3Pct) ? +r.cm3Pct.toFixed(4) : '', 'Tồn':r.stock, 'Cover (tuần)':isNum(r.cover) ? +r.cover.toFixed(1) : ''}));
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'SKU breakdown');
  XLSX.writeFile(wb, `Yes4All_Sales_${SP.from}_${SP.to}.xlsx`);
}

// SKU detail modal --------------------------------------------------------
async function openSkuDetail(sku){
  const k = skuInfo(sku); if(!k) return;
  const from = SP.from || addDaysIso(V2.state.maxDate || todayISO(), -29), to = SP.to || V2.state.maxDate || todayISO();
  const wrap = document.createElement('div'); wrap.className = 'v2-modal';
  wrap.innerHTML = `<div class="panel" role="dialog" aria-label="Chi tiết SKU ${esc(sku)}"><button class="x" type="button" aria-label="Đóng">×</button>
    <h3 style="margin:0;color:var(--navy)">${esc(sku)} · ${esc(k.productName || '')}</h3>
    <div class="v2-note" style="margin:3px 0 10px">${esc(k.pic || '')} · ${esc(k.mainPL || '')} / ${esc(k.subPL || '')} · ${esc(k.channel || '')} · ${k.asin ? `<a href="https://www.amazon.com/dp/${encodeURIComponent(k.asin)}" target="_blank" rel="noopener noreferrer">Mở listing ${esc(k.asin)} ↗</a>` : ''} · ${dm(from)} → ${dm(to)}</div>
    <div class="tiles" id="sdTiles"></div><div id="sdTrend" class="plot tall"></div>
    <div class="grid-7-5" style="margin-top:10px"><div><h4 style="margin:0 0 6px;color:var(--navy)">Khuyến nghị (rule, cập nhật theo data mới nhất)</h4><div id="sdRecs"></div>
      <button class="btn primary small" type="button" id="sdAsk" style="margin-top:8px">Hỏi AI cho SKU này</button><div class="ai-box" id="sdAI" hidden></div></div>
      <div><h4 style="margin:0 0 6px;color:var(--navy)">Tồn kho & incoming</h4><div id="sdInv" class="v2-note"></div></div></div></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.x').onclick = close; wrap.addEventListener('click', e => { if(e.target === wrap) close(); });
  document.addEventListener('keydown', function onk(e){ if(e.key === 'Escape'){ close(); document.removeEventListener('keydown', onk); } });
  const n = daysBetweenInclusive(from, to); const g = n <= 92 ? 'day' : 'week';
  const [pf, pt] = [addMonths(from, -12), addMonths(to, -12)];
  let cur = [], ly = [], c = {}, p = {};
  try {
    [cur, ly] = await Promise.all([rpcAll('sales_trend', {p_from: from, p_to: to, p_grain: g, p_skus: [sku]}), rpcAll('sales_trend', {p_from: pf, p_to: pt, p_grain: g, p_skus: [sku]})]);
    c = derive(addInto(emptyAgg(), withCm3(sku, cur.reduce((a, r) => addInto(a, r), emptyAgg()))));
    p = derive(addInto(emptyAgg(), withCm3(sku, ly.reduce((a, r) => addInto(a, r), emptyAgg()))));
  } catch(e){ wrap.querySelector('#sdTrend').innerHTML = '<div class="notice">Không tải được: ' + esc(e.message || e) + '</div>'; }
  const noGv = !(c.glance_views > 0);
  wrap.querySelector('#sdTiles').innerHTML = ['gmv','units','asp','ads','acos','tacos','promo','glance_views','cr','cm3Pct'].map(key => (noGv && (key === 'glance_views' || key === 'cr'))
    ? `<div class="tile"><div class="k">${M[key].l}</div><div class="v">—</div><div class="d"><span>nguồn chưa có glance view</span></div></div>`
    : `<div class="tile"><div class="k">${M[key].l}</div><div class="v">${M[key].f(c[key])}</div><div class="d">${deltaHtml(c[key], p[key], M[key].inv, M[key].rate)}<span>vs LY</span></div></div>`).join('');
  const x = cur.map(r => r.period), A = cur.map(r => derive(addInto(emptyAgg(), r)));
  const lyBy = new Map(ly.map(r => [g === 'week' ? sundayOf(addDaysIso(r.period, 364)) : addDaysIso(r.period, 364), +r.gmv || 0]));
  draw(wrap.querySelector('#sdTrend'), [
    {type:'bar', x, y:A.map(a => a.gmv), name:'GMV', marker:{color:'#2a78d6'}, xaxis:'x', yaxis:'y', hovertemplate:'GMV %{y:$,.0f}<extra></extra>'},
    {type:'scatter', mode:'lines', x, y:x.map(d => lyBy.get(d) ?? null), name:'GMV năm trước', line:{color:'#8A94A3', dash:'dot', width:1.5}, xaxis:'x', yaxis:'y', hovertemplate:'LY %{y:$,.0f}<extra></extra>'},
    {type:'bar', x, y:A.map(a => a.glance_views), name:'Glance views', marker:{color:'#A3ACB8'}, xaxis:'x', yaxis:'y2', hovertemplate:'GV %{y:,.0f}<extra></extra>'},
    {type:'scatter', mode:'lines+markers', x, y:A.map(a => a.tacos), name:'TACOS', line:{color:CAT5[1], width:2}, marker:{size:5}, xaxis:'x', yaxis:'y3', hovertemplate:'TACOS %{y:.1%}<extra></extra>'},
    {type:'scatter', mode:'lines+markers', x, y:A.map(a => a.cr), name:'CR', line:{color:CAT5[2], width:2}, marker:{size:5}, xaxis:'x', yaxis:'y3', hovertemplate:'CR %{y:.2%}<extra></extra>'},
  ], lay({grid:{rows:3, columns:1, subplots:[['xy'],['xy2'],['xy3']], roworder:'top to bottom'}, xaxis:ax({anchor:'y3', type:'date', tickformat:'%d/%m'}),
    yaxis:ax({domain:[.58, 1], tickprefix:'$', tickformat:'~s', title:{text:'GMV', font:{size:10.5, color:PAL.muted}}}), yaxis2:ax({domain:[.32, .52], tickformat:'~s', title:{text:'GV', font:{size:10.5, color:PAL.muted}}}), yaxis3:ax({domain:[0, .26], tickformat:'.0%', title:{text:'%', font:{size:10.5, color:PAL.muted}}}),
    hovermode:'x unified', margin:{l:58, r:12, t:6, b:52}, legend:{orientation:'h', y:-.12, x:0, font:{size:10.5, color:PAL.muted}}}));
  // recommendations: last 7 days vs previous 7 days from the loaded signals
  const s = k.sig || {};
  const cw = {units:s.units7 || 0, gmv:s.gmv7 || 0, ads:s.ads7 || 0, glance_views:s.gv7 || 0, ads_gmv:NaN, promo:0};
  const pw = {units:s.unitsPrev7 || 0, gmv:s.gmvPrev7 || 0, ads:s.adsPrev7 || 0, glance_views:s.gvPrev7 || 0};
  const recs = recsFor(k, cw, pw, null);
  wrap.querySelector('#sdRecs').innerHTML = recs.length ? '<ul style="margin:0;padding-left:18px">' + recs.map(r => `<li style="margin-bottom:4px"><span class="rec ${r.p === 1 ? 'p1' : r.p === 2 ? 'p2' : r.p === 4 ? 'ok' : 'p3'}">${r.p === 1 ? 'Cao' : r.p === 2 ? 'TB' : r.p === 4 ? 'Tốt' : 'Thấp'}</span> ${esc(r.text)}</li>`).join('') + '</ul>' : '<span class="v2-note">Không có tín hiệu bất thường trong 7 ngày gần nhất.</span>';
  const inc = (V2.state.incoming.get(sku) || []).sort((a, b) => a.week.localeCompare(b.week));
  wrap.querySelector('#sdInv').innerHTML = `Tồn Y4A <b>${fmtInt(k.salableY4A)}</b> · AMZ <b>${fmtInt(k.salableAMZ)}</b> · tốc độ ~${fN((s.vel || 0) * 7)} units/tuần<br>` + (inc.length ? 'Incoming: ' + inc.map(x => `${dm(x.week)}: <b>${fmtInt(x.qty)}</b>`).join(' · ') : 'Không có incoming trong file tồn kho.') + (k.rrp ? `<br>RRP ${f$2(k.rrp)} · ASP 7 ngày ${f$2(s.asp7)}` : '');
  wrap.querySelector('#sdAsk').onclick = () => askAI('sku', sku, {sku, product: k.productName, pic: k.pic, main_pl: k.mainPL, old_pl: k.subPL, channel: k.channel, rrp: k.rrp, period: {from, to}, current: pick(c), last_year: pick(p), last_7d: cw, prev_7d: pw, stock: {y4a: k.salableY4A, amz: k.salableAMZ, incoming: inc}, rule_recommendations: recs.map(r => r.text)}, wrap.querySelector('#sdAI'));
}
const pick = a => { const o = {}; ['gmv','units','asp','ads','promo','ads_gmv','ads_units','glance_views','clicks','impressions','acos','tacos','cr','ctr','mktGmv','cm3Pct'].forEach(k => { if(isNum(a[k])) o[k] = +(+a[k]).toFixed(4); }); return o; };
V2.openSkuDetail = openSkuDetail;

// =====================================================================
// WEEKLY REVIEW tab
// =====================================================================
let WRdirty = true, WRbuilt = false;
const WR = { ws:null, pl:null, open:new Set(), data:null, weeks:[], reviews:[], actions:[], dueDow:2, dueTime:'12:00' };
const CODES = ['INV','LIS','PRC','MKT','Others'];
const CODE_RX = {
  INV:/(tồn|stock|\boos\b|hết hàng|hàng về|về hàng|incoming|replenish|\bmoc\b|inventory|lô hàng)/i,
  LIS:/(listing|badge|hình|image|review|block|zip ?code|zipcode|shipping|kiện case|\bcase\b|swatch|content|item highlight)/i,
  PRC:/(giá|price|\brrp\b|coupon|\bmap\b|discount|ppm)/i,
  MKT:/(\bads?\b|promo|deal|\bbd\b|\bcamp|acos|tacos|budget|spend|traffic|keyword)/i,
};
const SKU_STOP = new Set(['ASIN','PUSH','DEAL','BEST','PRIME','TYPE','CASE','ACOS','TACOS']);
function parseIssues(text){
  return String(text || '').split(/\n+/).map(t => t.replace(/^[\s\-•*·]+/, '').trim()).filter(t => t.length > 3).map(t => {
    const hits = CODES.slice(0, 4).map(c => ({c, i: t.search(CODE_RX[c])})).filter(h => h.i >= 0).sort((a, b) => a.i - b.i).map(h => h.c);
    return {text: t, codes: hits.length ? hits : ['Others'], skus: [...new Set((t.match(/\b[A-Z0-9]{4}\b/g) || []).filter(x => /[A-Z]/.test(x) && !SKU_STOP.has(x)))]};
  });
}
function parseActions(text, ws){
  const out = []; let cur = null; const y = +ws.slice(0, 4); const def = addDaysIso(ws, 13);
  String(text || '').split(/\n+/).forEach(raw => {
    let t = raw.trim(); if(!t) return;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\s*[:\-]?\s*(.*)$/);
    if(m){ const mo = +m[2]; const yy = mo < +ws.slice(5, 7) - 6 ? y + 1 : y; cur = yy + '-' + String(mo).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0'); t = m[3].trim(); if(!t) return; }
    t = t.replace(/^[\-•*·]+\s*/, ''); if(t.length < 3) return;
    out.push({text: t, due: cur || def, dated: !!cur, skus: [...new Set((t.match(/\b[A-Z0-9]{4}\b/g) || []).filter(x => /[A-Z]/.test(x) && !SKU_STOP.has(x)))]});
  });
  return out;
}
function wrBuild(){
  const v = $('#view-wr');
  v.innerHTML = `
  <div class="filterbar">
    <div class="fld"><label for="wrWeek">Tuần (CN → T7)</label><select id="wrWeek"></select></div>
    <div class="fld"><label for="wrPic">PIC</label><select id="wrPic"><option value="">All</option></select></div>
    <div class="fld"><label for="wrDueDow">Hạn nhập</label><select id="wrDueDow"><option value="1">Thứ Hai</option><option value="2" selected>Thứ Ba</option><option value="3">Thứ Tư</option></select></div>
    <div class="fld"><label for="wrDueTime">Giờ</label><input type="time" id="wrDueTime" value="12:00" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px"></div>
    <button class="btn" type="button" id="wrFreeze">Chụp snapshot tuần này</button>
    <span class="result-count" id="wrStatus"></span>
  </div>
  <div class="lockbar" id="wrLock"></div>
  <div class="review-layout">
    <div class="card" style="margin:0">
      <h3 style="margin:0 0 3px">Snapshot tuần theo Main PL</h3>
      <div class="hint">Số liệu đầy đủ của tuần (khóa khi đã chụp snapshot). Bấm ▸ để xem từng SKU kèm khuyến nghị; rê chuột lên nhãn khuyến nghị để đọc đầy đủ. Bấm tên group để mở ô diễn giải bên phải.</div>
      <div class="tablewrap" style="max-height:680px"><table id="wrTable"></table></div>
    </div>
    <div class="card editor-card" style="margin:0" id="wrEditor"></div>
  </div>
  <div class="section-title">Knowledge hub</div>
  <div class="tiles" id="wrHubTiles"></div>
  <div class="grid-7-5"><div class="card" style="margin:0"><h3 style="margin:0 0 3px">Vấn đề theo mã, theo tuần</h3><div class="hint">INV tồn kho · LIS listing · PRC giá · MKT ads/promo · Others. Tách tự động từ ô “Vấn đề” mỗi khi PIC lưu.</div><div id="wrIssuePlot" class="plot"></div></div>
    <div class="card" style="margin:0"><h3 style="margin:0 0 3px">Vấn đề lặp lại (≥ 2 tuần)</h3><div class="hint">Cùng group + cùng mã xuất hiện nhiều tuần = vấn đề gốc cần xử lý dứt điểm.</div><div class="tablewrap" style="max-height:300px"><table id="wrRecur"></table></div></div></div>
  <div class="card"><h3 style="margin:0 0 3px">Action tracker</h3><div class="hint">Deadline lấy từ “dd/mm:” trong ô Hành động; không ghi ngày thì mặc định thứ Bảy tuần kế tiếp.</div><div class="board" id="wrBoard" style="margin-top:8px"></div></div>`;
  const today = todayISO(); const thisSun = sundayOf(today);
  WR.weeks = Array.from({length: 10}, (_, i) => addDaysIso(thisSun, -7 * i));
  const sel = $('#wrWeek');
  WR.weeks.forEach((w, i) => { const o = document.createElement('option'); o.value = w; o.textContent = `W${String(weekNo(w)).padStart(2, '0')} · ${dm(w)} → ${dm(addDaysIso(w, 6))}${i === 0 ? ' (đang chạy)' : ''}`; sel.appendChild(o); });
  WR.ws = WR.weeks[1]; sel.value = WR.ws;
  [...new Set(ROWS.map(r => r.pic).filter(Boolean))].sort().forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; $('#wrPic').appendChild(o); });
  sel.onchange = () => { WR.ws = sel.value; WR.pl = null; WR.open.clear(); renderWR(); };
  $('#wrPic').onchange = () => wrTable();
  $('#wrDueDow').onchange = () => { WR.dueDow = +$('#wrDueDow').value; wrLock(); };
  $('#wrDueTime').onchange = () => { WR.dueTime = $('#wrDueTime').value || '12:00'; wrLock(); };
  $('#wrFreeze').onclick = async () => { try { const {data, error} = await sb.rpc('freeze_review_week', {p_week_start: WR.ws}); if(error) throw error; toast(data ? `Đã chụp snapshot ${data} SKU` : 'Tuần này đã khóa hoặc chưa kết thúc'); renderWR(); } catch(e){ toast('Không chụp được: ' + (e.message || e)); } };
  WRbuilt = true;
}
function weekNo(sun){ const sat = addDaysIso(sun, 6); const d = new Date(sat + 'T00:00:00'); const j1 = new Date(d.getFullYear(), 0, 1); return Math.ceil(((d - j1) / 864e5 + j1.getDay() + 1) / 7); }
function dueOf(ws){ return new Date(addDaysIso(ws, 7 + WR.dueDow) + 'T' + WR.dueTime + ':00'); }
function snapOf(ws){ return new Date(addDaysIso(ws, 8) + 'T06:00:00'); }
async function loadWeek(ws){
  const we = addDaysIso(ws, 6); const today = todayISO();
  let frozen = null;
  try { const {data} = await sb.from('review_weeks').select('*').eq('week_start', ws); frozen = data && data[0] && data[0].frozen_at ? data[0] : null; } catch(e){}
  // auto-freeze an ended week once its snapshot time has passed
  if(!frozen && new Date() >= snapOf(ws)){
    try { const {data} = await sb.rpc('freeze_review_week', {p_week_start: ws}); if(data){ const r = await sb.from('review_weeks').select('*').eq('week_start', ws); frozen = r.data && r.data[0]; } } catch(e){}
  }
  const bySku = new Map();
  if(frozen){
    const rows = await selectAll('review_snapshot', q => q.eq('week_start', ws));
    rows.forEach(r => bySku.set(r.sku, {c:{units:+r.units||0, gmv:+r.gmv||0, ads:+r.ads||0, promo:+r.promo||0, ads_gmv:+r.ads_gmv||0, ads_units:+r.ads_units||0, clicks:+r.clicks||0, impressions:+r.impressions||0, glance_views:+r.glance_views||0},
      p:{units:+r.prev_units||0, gmv:+r.prev_gmv||0, ads:+r.prev_ads||0, promo:+r.prev_promo||0, ads_gmv:+r.prev_ads_gmv||0, glance_views:+r.prev_glance_views||0, clicks:+r.prev_clicks||0},
      t:{units:+r.target_units||0, gmv:+r.target_gmv||0, ads:+r.ads_budget||0, promo:+r.promo_budget||0}, stock:(+r.salable_y4a||0) + (+r.salable_amz||0)}));
    return {frozen, bySku, live:false};
  }
  const to = we < (V2.state.maxDate || today) ? we : (V2.state.maxDate || today);
  const [cur, prev] = await Promise.all([rpcAll('sales_by_sku', {p_from: ws, p_to: to}), rpcAll('sales_by_sku', {p_from: addDaysIso(ws, -7), p_to: addDaysIso(ws, -1)})]);
  const months = [...new Set([ws.slice(0, 7), we.slice(0, 7)])].map(m => m + '-01');
  let tg = [];
  try { tg = await selectAll('targets_monthly', q => q.in('month', months)); } catch(e){}
  const tBy = new Map();
  tg.forEach(t => { let f = 0; for(let i = 0; i < 7; i++){ const d = addDaysIso(ws, i); if(d.slice(0, 7) === t.month.slice(0, 7)) f += 1 / daysIn(d); } const o = tBy.get(t.sku) || {units:0, gmv:0, ads:0, promo:0}; o.units += (+t.target_units||0) * f; o.gmv += (+t.target_gmv||0) * f; o.ads += (+t.ads_target||0) * f; o.promo += (+t.promo_target||0) * f; tBy.set(t.sku, o); });
  const pBy = new Map(prev.map(r => [r.sku, r]));
  const keys = new Set([...cur.map(r => r.sku), ...prev.map(r => r.sku), ...tBy.keys()]);
  const cBy = new Map(cur.map(r => [r.sku, r]));
  keys.forEach(sku => { const c = cBy.get(sku) || {}, p = pBy.get(sku) || {}; const k = skuInfo(sku);
    bySku.set(sku, {c:{units:+c.units||0, gmv:+c.gmv||0, ads:+c.ads||0, promo:+c.promo||0, ads_gmv:+c.ads_gmv||0, ads_units:+c.ads_units||0, clicks:+c.clicks||0, impressions:+c.impressions||0, glance_views:+c.glance_views||0},
      p:{units:+p.units||0, gmv:+p.gmv||0, ads:+p.ads||0, promo:+p.promo||0, ads_gmv:+p.ads_gmv||0, glance_views:+p.glance_views||0, clicks:+p.clicks||0}, t:tBy.get(sku) || {units:0, gmv:0, ads:0, promo:0}, stock: k ? stockOf(k) : 0}); });
  return {frozen:null, bySku, live:true, liveTo:to};
}
async function renderWR(){
  if(!WRbuilt) wrBuild();
  $('#wrStatus').textContent = 'Đang tải…';
  try { WR.data = await loadWeek(WR.ws); }
  catch(e){ $('#wrStatus').textContent = ''; $('#wrTable').innerHTML = missingSchema(e) ? '<tr><td>' + schemaHint + '</td></tr>' : '<tr><td>Không tải được: ' + esc(e.message || e) + '</td></tr>'; return; }
  try { WR.reviews = await selectAll('weekly_reviews', q => q.gte('week_start', addDaysIso(WR.weeks[WR.weeks.length - 1], -56))); } catch(e){ WR.reviews = []; }
  try { WR.actions = await selectAll('review_actions', q => q.order('due_date', {ascending:true})); } catch(e){ WR.actions = []; }
  $('#wrStatus').innerHTML = WR.data.frozen ? `<span class="badge green">Đã khóa ${new Date(WR.data.frozen.frozen_at).toLocaleString('vi-VN')}</span>` : `<span class="badge amber">Chưa khóa · số liệu live tới ${dm(WR.data.liveTo)}</span>`;
  $('#wrFreeze').disabled = !!WR.data.frozen || new Date() < new Date(addDaysIso(WR.ws, 7) + 'T00:00:00');
  wrLock(); wrTable(); wrEditor(); wrHub(); WRdirty = false;
}
function wrLock(){
  const ws = WR.ws, we = addDaysIso(ws, 6), snap = snapOf(ws), due = dueOf(ws), now = new Date();
  const phase = now < new Date(addDaysIso(ws, 7) + 'T00:00:00') ? 0 : now < snap ? 1 : now < due ? 2 : 3;
  const fdt = d => ['CN','T2','T3','T4','T5','T6','T7'][d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const steps = [['Tuần bán hàng', dm(ws) + ' → ' + dm(we), 'Data load daily, số còn thay đổi'], ['Chụp snapshot', fdt(snap), 'Khóa số liệu tuần (tự động bằng pg_cron hoặc khi mở tuần này)'], ['Hạn nhập diễn giải', fdt(due), 'PIC nhập trước hạn = On time'], ['Sau hạn', 'Vẫn mở', 'Nhập được, gắn nhãn Late, lưu mọi version']];
  $('#wrLock').innerHTML = steps.map((s, i) => `<div class="step ${i < phase ? 'done' : ''} ${i === phase ? 'now' : ''}"><span class="lbl" style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase">${s[0]}</span><span class="when">${s[1]}</span><span class="v2-note">${s[2]}${i === phase ? ' · <b>đang ở bước này</b>' : ''}</span></div>`).join('');
}
function wrPlStats(){
  const pic = $('#wrPic').value;
  const g = new Map();
  WR.data.bySku.forEach((x, sku) => {
    const k = skuInfo(sku); if(!k || !matchGS(k) || (pic && k.pic !== pic)) return;
    const pl = k.mainPL || 'Unclassified';
    if(!g.has(pl)) g.set(pl, {pl, pics:{}, c:emptyAgg(), p:emptyAgg(), t:{units:0, gmv:0, ads:0, promo:0}, stock:0, skus:[]});
    const e = g.get(pl); addInto(e.c, x.c); addInto(e.p, x.p); ['units','gmv','ads','promo'].forEach(q => e.t[q] += x.t[q] || 0); e.stock += x.stock; e.pics[k.pic] = (e.pics[k.pic] || 0) + 1;
    e.skus.push({sku, k, ...x, recs: recsFor(k, x.c, x.p, x.t)});
  });
  g.forEach(e => { derive(e.c); derive(e.p); e.pic = Object.entries(e.pics).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; e.ach = e.t.gmv ? e.c.gmv / e.t.gmv : NaN; e.recs = e.skus.flatMap(s => s.recs.filter(r => r.p <= 2).map(r => ({...r, sku:s.sku}))); });
  return [...g.values()].filter(e => e.c.gmv > 0 || e.p.gmv > 0 || e.t.gmv > 0).sort((a, b) => b.c.gmv - a.c.gmv);
}
const autoSt = ach => !isNum(ach) ? ['gray','Không có target'] : ach >= .95 ? ['green','Đạt tiến độ'] : ach >= .8 ? ['amber','Cần chú ý'] : ['red','Chậm tiến độ'];
function reviewOf(ws, pl){ return WR.reviews.find(r => r.week_start === ws && r.main_pl === pl); }
function wrTable(){
  const stats = wrPlStats(); WR.stats = stats;
  if(!WR.pl || !stats.find(s => s.pl === WR.pl)) WR.pl = (stats.find(s => !reviewOf(WR.ws, s.pl) && autoSt(s.ach)[0] !== 'green') || stats[0] || {}).pl || null;
  const row = (e, isSku) => { const c = e.c, p = e.p; const cover = (c.units || 0) ? e.stock / c.units : (e.stock > 0 ? Infinity : NaN);
    return `<td class="num">${f$(c.gmv)}</td><td class="num">${deltaHtml(c.gmv, p.gmv)}</td><td class="num">${isNum(isSku ? div(c.gmv, e.t.gmv) : e.ach) ? fP(isSku ? div(c.gmv, e.t.gmv) : e.ach, 0) : '—'}</td><td class="num">${fN(c.units)}</td><td class="num">${f$2(div(c.gmv, c.units))}</td>
      <td class="num">${f$(c.ads)}</td><td class="num">${fP(div(c.ads, c.ads_gmv), 0)}</td><td class="num">${fP(div(c.ads, c.gmv))}</td><td class="num">${f$(c.promo)}</td><td class="num">${fP(div(c.ads + c.promo, c.gmv))}</td>
      <td class="num">${fN(c.glance_views)} ${deltaHtml(c.glance_views, p.glance_views)}</td><td class="num">${fP(div(c.units, c.glance_views), 1)}</td><td class="num">${fN(e.stock)}</td><td class="num">${isNum(cover) ? cover.toFixed(1) + 'w' : cover === Infinity ? '∞' : '—'}</td>`; };
  $('#wrTable').innerHTML = `<thead><tr><th>Group / SKU</th><th>Diễn giải</th><th>Tự động</th><th class="num">GMV</th><th class="num">WoW</th><th class="num">% target tuần</th><th class="num">Units</th><th class="num">ASP</th><th class="num">Ads</th><th class="num">ACOS</th><th class="num">TACOS</th><th class="num">Promo</th><th class="num">%MKT/GMV</th><th class="num">Glance views</th><th class="num">CR</th><th class="num">Tồn</th><th class="num">Cover</th><th>Khuyến nghị</th><th>PIC</th></tr></thead><tbody>` +
    stats.map(e => { const rv = reviewOf(WR.ws, e.pl); const st = autoSt(e.ach); const open = WR.open.has(e.pl);
      const note = rv ? `<span class="badge ${rv.is_late ? 'amber' : 'green'}">${rv.is_late ? 'Late' : 'Đã nhập'}</span>` : (st[0] === 'green' ? '<span class="badge gray">Không bắt buộc</span>' : '<span class="badge red">Thiếu</span>');
      const head = `<tr class="clickable${e.pl === WR.pl ? ' sel' : ''}" data-pl="${esc(e.pl)}"><td style="white-space:normal;min-width:170px"><span class="wr-tog" data-pl="${esc(e.pl)}" style="cursor:pointer;display:inline-block;width:14px">${open ? '▾' : '▸'}</span><b>${esc(e.pl)}</b> <span class="v2-note">${e.skus.length} SKU</span></td><td>${note}</td><td><span class="badge ${st[0]}">${st[1]}</span></td>${row(e, false)}<td>${e.recs.slice(0, 3).map(r => recChip(r)).join('')}${e.recs.length > 3 ? `<span class="v2-note">+${e.recs.length - 3}</span>` : ''}</td><td>${esc(e.pic)}</td></tr>`;
      const subs = open ? e.skus.sort((a, b) => b.c.gmv - a.c.gmv).map(s => `<tr class="sub"><td style="white-space:normal">${s.k.asin ? `<a href="https://www.amazon.com/dp/${encodeURIComponent(s.k.asin)}" target="_blank" rel="noopener noreferrer"><b>${esc(s.sku)}</b></a>` : `<b>${esc(s.sku)}</b>`} <span class="v2-note">${esc((s.k.productName || '').slice(0, 42))}</span></td><td></td><td></td>${row({c:s.c, p:s.p, t:s.t, stock:s.stock}, true)}<td>${s.recs.map(r => recChip(r)).join('') || '<span class="v2-note">—</span>'}</td><td></td></tr>`).join('') : '';
      return head + subs; }).join('') + '</tbody>';
  $$('#wrTable .wr-tog').forEach(t => t.onclick = ev => { ev.stopPropagation(); const pl = t.dataset.pl; WR.open.has(pl) ? WR.open.delete(pl) : WR.open.add(pl); wrTable(); });
  $$('#wrTable tr.clickable').forEach(tr => tr.onclick = () => { WR.pl = tr.dataset.pl; wrTable(); wrEditor(); });
}
function wrEditor(){
  const el = $('#wrEditor'); const e = (WR.stats || []).find(s => s.pl === WR.pl);
  if(!e){ el.innerHTML = '<span class="v2-note">Chọn một group bên trái.</span>'; return; }
  const rv = reviewOf(WR.ws, e.pl) || {};
  const owners = [...new Set(ROWS.map(r => r.pic).filter(Boolean))].sort();
  el.innerHTML = `<h3 style="margin:0">${esc(e.pl)}</h3><div class="v2-note" style="margin:2px 0 8px">GMV ${f$(e.c.gmv)} (${fP(div(e.c.gmv, e.p.gmv) - 1)} WoW) · target ${fP(e.ach, 0)} · Ads ${f$(e.c.ads)} · TACOS ${fP(e.c.tacos)} · GV ${fN(e.c.glance_views)}</div>
    <div style="display:flex;gap:8px;margin-bottom:8px"><div style="flex:1"><label class="lbl2" for="edSt">Trạng thái</label><select id="edSt">${['Đạt tiến độ','Cần chú ý','Chậm tiến độ'].map(s => `<option ${((rv.status || autoSt(e.ach)[1]) === s) ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div style="flex:1"><label class="lbl2" for="edOw">Owner</label><select id="edOw">${owners.map(o => `<option ${((rv.owner || e.pic) === o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div></div>
    <label class="lbl2" for="edIs">Vấn đề / Follow-up (mỗi ý một dòng)</label><textarea id="edIs" placeholder="VD: 5SU6 OOS, hàng về giữa tháng&#10;D5XI mất badge Best Deal">${esc(rv.issue_text || '')}</textarea>
    <label class="lbl2" for="edAc" style="margin-top:6px;display:block">Hành động tiếp theo (ghi “dd/mm:” để đặt deadline)</label><textarea id="edAc" placeholder="VD: 02/10: Kiện case long shipping cho 4M82&#10;Push ads vào SKU còn stock">${esc(rv.action_text || '')}</textarea>
    <div class="lbl2" style="margin-top:6px">Hệ thống tự bóc tách</div><div class="parsed" id="edParsed"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="edSave" type="button">Lưu diễn giải</button><button class="btn" id="edAI" type="button">Hỏi AI cho group này</button><span class="v2-note" id="edVer">${rv.id ? 'Lần lưu cuối ' + new Date(rv.updated_at).toLocaleString('vi-VN') + (rv.is_late ? ' · Late' : '') : 'Chưa có diễn giải tuần này.'}</span></div>
    <div class="lbl2" style="margin-top:10px">Khuyến nghị theo rule (${e.recs.length})</div>
    <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;max-height:190px;overflow:auto">${e.recs.slice(0, 12).map(r => `<li><b>${esc(r.sku)}</b>: ${esc(r.text)}</li>`).join('') || '<li class="v2-note">Không có tín hiệu ưu tiên cao/TB.</li>'}</ul>
    <div class="ai-box" id="edAIbox" hidden></div>`;
  const parsed = () => { const iss = parseIssues($('#edIs').value), acts = parseActions($('#edAc').value, WR.ws);
    $('#edParsed').innerHTML = (iss.length || acts.length) ? iss.map(i => `<div class="it"><span>${i.codes.map(c => `<span class="codeb ${c}">${c}</span>`).join(' ')}</span><span>${esc(i.text)}</span><span class="meta">${i.skus.map(s => `<span class="skutag">${esc(s)}</span>`).join(' ')}</span></div>`).join('') + acts.map(a => `<div class="it"><span class="badge gray">Action</span><span>${esc(a.text)}</span><span class="meta">hạn ${dm(a.due)}${a.dated ? '' : ' (mặc định)'}</span></div>`).join('') : '<span class="v2-note">Gõ vào hai ô trên, phần tách issue/action sẽ hiện ở đây.</span>'; };
  $('#edIs').oninput = parsed; $('#edAc').oninput = parsed; parsed();
  $('#edSave').onclick = async () => {
    const issue = $('#edIs').value.trim(), action = $('#edAc').value.trim();
    if(!issue && !action){ toast('Nhập ít nhất một vấn đề hoặc hành động'); return; }
    const btn = $('#edSave'); btn.disabled = true; btn.textContent = 'Đang lưu…';
    try {
      // make sure the week row exists (due time) before saving so the Late flag is right
      try { await sb.rpc('freeze_review_week', {p_week_start: WR.ws}); } catch(_){ }
      const {data, error} = await sb.from('weekly_reviews').upsert({week_start: WR.ws, main_pl: e.pl, owner: $('#edOw').value, status: $('#edSt').value, issue_text: issue, action_text: action}, {onConflict: 'week_start,main_pl'}).select().single();
      if(error) throw error;
      const acts = parseActions(action, WR.ws);
      const old = WR.actions.filter(a => a.review_id === data.id);
      const keepDone = new Set(old.filter(a => a.status === 'Done').map(a => a.text));
      await sb.from('review_actions').delete().eq('review_id', data.id);
      if(acts.length){ const {error: e2} = await sb.from('review_actions').insert(acts.map(a => ({review_id: data.id, week_start: WR.ws, main_pl: e.pl, owner: $('#edOw').value, text: a.text, due_date: a.due, due_from_text: a.dated, skus: a.skus, status: keepDone.has(a.text) ? 'Done' : 'Open'}))); if(e2) throw e2; }
      toast(data.is_late ? 'Đã lưu · gắn nhãn Late (sau hạn)' : 'Đã lưu diễn giải');
      WR.reviews = await selectAll('weekly_reviews', q => q.gte('week_start', addDaysIso(WR.weeks[WR.weeks.length - 1], -56)));
      WR.actions = await selectAll('review_actions', q => q.order('due_date', {ascending:true}));
      V2.state.notes = WR.reviews; wrTable(); wrEditor(); wrHub();
    } catch(err){ toast('Không lưu được: ' + (err.message || err)); btn.disabled = false; btn.textContent = 'Lưu diễn giải'; }
  };
  $('#edAI').onclick = () => askAI('main_pl', e.pl + ' · ' + WR.ws, {week: {start: WR.ws, end: addDaysIso(WR.ws, 6), frozen: !!WR.data.frozen}, main_pl: e.pl, pic: e.pic,
    totals: {current: pick(e.c), previous_week: pick(e.p), target_week: e.t, stock: e.stock},
    skus: e.skus.sort((a, b) => b.c.gmv - a.c.gmv).slice(0, 25).map(s => ({sku: s.sku, name: s.k.productName, rrp: s.k.rrp, current: pick(derive(addInto(emptyAgg(), s.c))), previous_week: pick(derive(addInto(emptyAgg(), s.p))), target_week: s.t, stock: s.stock, rule_recommendations: s.recs.map(r => r.text)})),
    pic_notes: {issues: $('#edIs').value, actions: $('#edAc').value}}, $('#edAIbox'));
}
function wrHub(){
  const today = todayISO();
  const issues = WR.reviews.flatMap(r => parseIssues(r.issue_text).map(i => ({...i, ws: r.week_start, pl: r.main_pl})));
  const stats = WR.stats || [];
  const need = stats.filter(s => autoSt(s.ach)[0] !== 'green' && autoSt(s.ach)[0] !== 'gray');
  const done = need.filter(s => reviewOf(WR.ws, s.pl)).length;
  const open = WR.actions.filter(a => a.status === 'Open'), overdue = open.filter(a => a.due_date < today);
  const wk = issues.filter(i => i.ws === WR.ws); const cc = {}; wk.forEach(i => i.codes.forEach(c => cc[c] = (cc[c] || 0) + 1));
  const top = Object.entries(cc).filter(([c]) => c !== 'Others').sort((a, b) => b[1] - a[1])[0] || Object.entries(cc).sort((a, b) => b[1] - a[1])[0];
  $('#wrHubTiles').innerHTML = [['Group cần diễn giải', `${done}/${need.length}`, need.length && done < need.length ? '<span class="dl down">còn thiếu</span>' : '<span class="dl up">đủ</span>'], ['Issue tuần này', fmtInt(wk.length), ''], ['Mã nổi bật', top ? top[0] : '—', top ? top[1] + ' lần' : ''], ['Action đang mở', fmtInt(open.length), ''], ['Quá hạn', fmtInt(overdue.length), overdue.length ? '<span class="dl down">cần xử lý</span>' : '<span class="dl up">0</span>']]
    .map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  const weeks = [...WR.weeks].reverse().slice(-8);
  draw('wrIssuePlot', CODES.map((c, i) => ({type:'bar', name:c, x:weeks.map(w => 'W' + weekNo(w)), y:weeks.map(w => issues.filter(x => x.ws === w && x.codes.includes(c)).length), marker:{color:CAT5[i], line:{color:'#fff', width:2}}, hovertemplate:`%{x} · ${c}: %{y}<extra></extra>`})),
    lay({barmode:'stack', bargap:.45, yaxis:ax({title:{text:'Số issue', font:{size:11, color:PAL.muted}}, rangemode:'tozero'}), margin:{l:48, r:8, t:6, b:52}, legend:{orientation:'h', y:-.22, x:0, font:{size:11, color:PAL.muted}}}));
  const rec = new Map();
  issues.forEach(i => i.codes.forEach(c => { const k = i.pl + '|' + c; if(!rec.has(k)) rec.set(k, {pl:i.pl, c, weeks:new Set(), last:'', lastWs:''}); const r = rec.get(k); r.weeks.add(i.ws); if(i.ws >= r.lastWs){ r.lastWs = i.ws; r.last = i.text; } }));
  const rr = [...rec.values()].filter(r => r.weeks.size >= 2).sort((a, b) => b.weeks.size - a.weeks.size);
  $('#wrRecur').innerHTML = '<thead><tr><th>Group</th><th>Mã</th><th class="num">Số tuần</th><th>Ghi chú gần nhất</th></tr></thead><tbody>' + (rr.length ? rr.map(r => `<tr><td>${esc(r.pl)}</td><td><span class="codeb ${r.c}">${r.c}</span></td><td class="num">${r.weeks.size}</td><td style="white-space:normal;min-width:220px">${esc(r.last)}</td></tr>`).join('') : '<tr><td colspan="4" class="v2-note">Chưa có vấn đề lặp lại.</td></tr>') + '</tbody>';
  const col = (title, list, cls) => `<div class="bcol"><h4><span>${title}</span><span class="badge ${cls}">${list.length}</span></h4>${list.slice(0, 30).map(a => `<div class="act"><div>${esc(a.text)}</div><div class="foot"><span>${esc(a.main_pl)}</span><span>· ${esc(a.owner || '')}</span><span>· hạn ${dm(a.due_date)}</span>${(a.skus || []).map(s => `<span class="skutag">${esc(s)}</span>`).join('')}<button class="btn small" type="button" data-id="${a.id}" data-st="${a.status === 'Done' ? 'Open' : 'Done'}">${a.status === 'Done' ? 'Mở lại' : 'Xong'}</button></div></div>`).join('') || '<span class="v2-note">Trống</span>'}</div>`;
  $('#wrBoard').innerHTML = col('Quá hạn', overdue, 'red') + col('Đang mở', open.filter(a => a.due_date >= today), 'amber') + col('Hoàn thành', WR.actions.filter(a => a.status === 'Done'), 'green');
  $$('#wrBoard [data-id]').forEach(b => b.onclick = async () => { const {error} = await sb.from('review_actions').update({status: b.dataset.st, done_at: b.dataset.st === 'Done' ? new Date().toISOString() : null}).eq('id', +b.dataset.id); if(error){ toast('Không cập nhật được: ' + error.message); return; } const a = WR.actions.find(x => String(x.id) === b.dataset.id); if(a) a.status = b.dataset.st; wrHub(); });
}

// =====================================================================
// ADS PERFORMANCE extras
// =====================================================================
let ADSdirty = true;
const AD = { weeks: 12 };
function adsBuild(){
  const host = $('#adsV2'); if(!host || host.dataset.built) return;
  host.dataset.built = '1';
  host.innerHTML = `<div class="section-title">Ads trend & khuyến nghị theo product line</div>
  <div class="card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Ads theo tuần</h3>
    <div class="cv-toggle" id="adWeeks"><button class="cv-btn" data-w="8" type="button">8 tuần</button><button class="cv-btn" data-w="12" type="button">12 tuần</button><button class="cv-btn" data-w="26" type="button">26 tuần</button><button class="cv-btn" data-w="52" type="button">52 tuần</button></div></div>
    <div class="hint">Theo bộ lọc PIC / Product Line ở trên và ô tìm kiếm chung. Panel 1: chi tiêu theo loại campaign. Panel 2: ACOS (Ads ÷ Ads GMV) và TACOS (Ads ÷ tổng GMV). Panel 3: glance views và CR.</div>
    <div id="adTrend" class="plot xl"></div></div>
  <div class="card"><h3 style="margin:0 0 3px">Khuyến nghị theo product line</h3><div class="hint" id="adRecHint"></div><div id="adRecs"></div></div>`;
  $('#adWeeks').onclick = e => { const b = e.target.closest('[data-w]'); if(!b) return; AD.weeks = +b.dataset.w; renderAdsV2(); };
}
async function renderAdsV2(){
  adsBuild(); if(!$('#adsV2')) return;
  $$('#adWeeks .cv-btn').forEach(b => b.classList.toggle('active', +b.dataset.w === AD.weeks));
  const rows = adsGetFilteredRows().filter(matchGS);
  const skus = rows.length === ROWS.length ? null : rows.map(r => r.sku);
  const mx = V2.state.maxDate || todayISO();
  const lastFullSun = addDaysIso(sundayOf(mx), dowOf(mx) === 6 ? 0 : -7);
  const from = addDaysIso(lastFullSun, -7 * (AD.weeks - 1));
  let tr;
  try { tr = await rpcAll('sales_trend', {p_from: from, p_to: mx, p_grain: 'week', p_skus: skus}); }
  catch(e){ $('#adTrend').innerHTML = missingSchema(e) ? schemaHint : '<div class="notice">Không tải được: ' + esc(e.message || e) + '</div>'; return; }
  const x = tr.map(r => r.period), A = tr.map(r => derive(addInto(emptyAgg(), r)));
  const partial = x.length && addDaysIso(x[x.length - 1], 6) > mx;
  draw('adTrend', [
    ...[['sp_spend','SP'],['sb_spend','SB'],['sd_spend','SD'],['dsp_spend','DSP']].map(([k, l], i) => ({type:'bar', x, y:A.map(a => a[k]), name:l, marker:{color:CAT5[i], line:{color:'#fff', width:1}}, xaxis:'x', yaxis:'y', hovertemplate:`${l}: %{y:$,.0f}<extra></extra>`})),
    {type:'scatter', mode:'lines+markers', x, y:A.map(a => a.acos), name:'ACOS', line:{color:CAT5[0], width:2}, marker:{size:5}, xaxis:'x', yaxis:'y2', hovertemplate:'ACOS %{y:.1%}<extra></extra>'},
    {type:'scatter', mode:'lines+markers', x, y:A.map(a => a.tacos), name:'TACOS', line:{color:CAT5[1], width:2}, marker:{size:5}, xaxis:'x', yaxis:'y2', hovertemplate:'TACOS %{y:.1%}<extra></extra>'},
    {type:'bar', x, y:A.map(a => a.glance_views), name:'Glance views', marker:{color:'#A3ACB8'}, xaxis:'x', yaxis:'y3', hovertemplate:'GV %{y:,.0f}<extra></extra>'},
    {type:'scatter', mode:'lines+markers', x, y:A.map(a => a.cr), name:'CR', line:{color:CAT5[2], width:2}, marker:{size:5}, xaxis:'x', yaxis:'y4', hovertemplate:'CR %{y:.2%}<extra></extra>'},
  ], lay({barmode:'stack', grid:{rows:4, columns:1, subplots:[['xy'],['xy2'],['xy3'],['xy4']], roworder:'top to bottom'}, xaxis:ax({anchor:'y4', type:'date', tickformat:'%d/%m'}),
    yaxis:ax({domain:[.62, 1], tickprefix:'$', tickformat:'~s', title:{text:'Ads $', font:{size:10.5, color:PAL.muted}}}), yaxis2:ax({domain:[.40, .57], tickformat:'.0%', title:{text:'ACOS/TACOS', font:{size:10.5, color:PAL.muted}}, rangemode:'tozero'}),
    yaxis3:ax({domain:[.19, .35], tickformat:'~s', title:{text:'GV', font:{size:10.5, color:PAL.muted}}}), yaxis4:ax({domain:[0, .14], tickformat:'.1%', title:{text:'CR', font:{size:10.5, color:PAL.muted}}, rangemode:'tozero'}),
    hovermode:'x unified', margin:{l:62, r:12, t:6, b:52}, legend:{orientation:'h', y:-.08, x:0, font:{size:11, color:PAL.muted}},
    shapes: partial ? [{type:'rect', xref:'x', yref:'paper', x0:addDaysIso(x[x.length - 1], -3), x1:addDaysIso(x[x.length - 1], 3), y0:0, y1:1, fillcolor:'rgba(255,112,0,.06)', line:{width:0}}] : []}));
  // recommendations: last full week vs previous week, per SKU, grouped by Main PL
  const ws = lastFullSun, pws = addDaysIso(ws, -7);
  let bys;
  try { bys = await rpcAll('sales_trend_by_sku', {p_from: pws, p_to: addDaysIso(ws, 6), p_grain: 'week', p_skus: skus}); } catch(e){ $('#adRecs').innerHTML = '<div class="notice">' + esc(e.message || e) + '</div>'; return; }
  const cur = new Map(), prev = new Map();
  bys.forEach(r => (r.period === ws ? cur : prev).set(r.sku, r));
  $('#adRecHint').innerHTML = `So sánh tuần ${dm(ws)}–${dm(addDaysIso(ws, 6))} với tuần trước (${dm(pws)}–${dm(addDaysIso(pws, 6))}). Rule ưu tiên: hết hàng vẫn chạy ads → glance view giảm cùng ads (check campaign) → glance view giảm dù ads giữ (ranking/listing) → CR giảm → ACOS cao → dưới target mà ads thấp. Dữ liệu cập nhật mỗi ngày.`;
  const byPl = new Map();
  rows.forEach(k => { const c = cur.get(k.sku), p = prev.get(k.sku); if(!c && !p) return;
    const cc = derive(addInto(emptyAgg(), c || {})), pp = derive(addInto(emptyAgg(), p || {}));
    const recs = recsFor(k, cc, pp, null).filter(r => r.p <= 3);
    const e = byPl.get(k.mainPL) || {pl:k.mainPL, c:emptyAgg(), p:emptyAgg(), items:[]}; addInto(e.c, cc); addInto(e.p, pp);
    recs.forEach(r => e.items.push({sku:k.sku, name:k.productName, r, impact: Math.abs((pp.gmv || 0) - (cc.gmv || 0)) + (cc.ads || 0)}));
    byPl.set(k.mainPL, e); });
  const pls = [...byPl.values()].map(e => { derive(e.c); derive(e.p); return e; }).filter(e => e.items.length || e.c.gmv > 0).sort((a, b) => b.c.gmv - a.c.gmv);
  const short = n => { const m = String(n || '').match(/(\d+(?:\.\d+)?\s?(?:lbs?|lb|kg|in|inch|"|pcs))/i); return m ? m[1] : String(n || '').slice(0, 26); };
  $('#adRecs').innerHTML = pls.map(e => `<details ${e.items.some(i => i.r.p === 1) ? 'open' : ''} style="border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-bottom:8px;background:#fff">
      <summary style="cursor:pointer;font-weight:800;color:var(--navy)">${esc(e.pl)} <span class="v2-note" style="font-weight:600">· GMV ${f$(e.c.gmv)} ${deltaHtml(e.c.gmv, e.p.gmv)} · Ads ${f$(e.c.ads)} · ACOS ${fP(e.c.acos, 0)} · TACOS ${fP(e.c.tacos)} · GV ${deltaHtml(e.c.glance_views, e.p.glance_views)} · ${e.items.length} khuyến nghị</span></summary>
      <ul style="margin:6px 0 4px;padding-left:18px;font-size:12.3px">${e.items.sort((a, b) => a.r.p - b.r.p || b.impact - a.impact).map(i => `<li style="margin-bottom:3px"><span class="rec ${i.r.p === 1 ? 'p1' : i.r.p === 2 ? 'p2' : 'p3'}">${i.r.p === 1 ? 'Cao' : i.r.p === 2 ? 'TB' : 'Thấp'}</span> <b>${esc(i.sku)}</b> <span class="v2-note">(${esc(short(i.name))})</span>: ${esc(i.r.text)}</li>`).join('') || '<li class="v2-note">Không có tín hiệu bất thường.</li>'}</ul>
      <button class="btn small" type="button" data-ai="${esc(e.pl)}">Hỏi AI cho ${esc(e.pl)}</button><div class="ai-box" hidden></div></details>`).join('') || '<span class="v2-note">Không có dữ liệu trong bộ lọc.</span>';
  $$('#adRecs [data-ai]').forEach(b => b.onclick = () => { const e = pls.find(x => x.pl === b.dataset.ai); askAI('main_pl', 'ads · ' + e.pl + ' · ' + ws, {focus: 'Amazon Ads của product line', week: ws, main_pl: e.pl, totals: {current_week: pick(e.c), previous_week: pick(e.p)}, findings: e.items.map(i => ({sku: i.sku, name: i.name, finding: i.r.text}))}, b.nextElementSibling); });
  ADSdirty = false;
}

// =====================================================================
// MARKET tab
// =====================================================================
let MKbuilt = false;
const MK = { cat:null, attr:null, data:null };
async function renderMK(){
  const v = $('#view-mk');
  if(!MKbuilt){
    v.innerHTML = `<div class="filterbar"><div class="fld"><label>Category</label><div class="cv-toggle" id="mkCats"></div></div><span class="result-count" id="mkSrc"></span></div>
      <div class="tiles" id="mkTiles"></div>
      <div class="card"><h3 style="margin:0 0 3px" id="mkMapTitle">Brand map theo thời gian</h3><div class="hint" id="mkMapHint"></div><div id="mkMap" class="plot xl"></div></div>
      <div class="grid2"><div class="card"><h3 style="margin:0 0 3px">Price ladder theo variation</h3><div class="hint">Mỗi hàng là một variation. Chấm đặt tại giá của brand, kích thước = doanh thu của brand trong variation đó. Vạch xám = khoảng giá thị trường.</div><div id="mkLadder" class="plot tall"></div></div>
        <div class="card"><h3 style="margin:0 0 3px">Giá vs số bán</h3><div class="hint" id="mkPsHint"></div><div id="mkPs" class="plot tall"></div><div class="readout" id="mkEl"></div></div></div>
      <div class="card"><h3 style="margin:0 0 3px">Market size theo variation</h3><div class="hint">Nguồn: biểu đồ market size by color/length/size trong file nghiên cứu.</div><div class="cv-toggle" id="mkAttr" style="margin:6px 0"></div><div id="mkVar" class="plot tall"></div></div>`;
    MKbuilt = true;
  }
  if(!MK.data){
    try {
      const [vr, bm, aw, vm] = await Promise.all([selectAll('market_variation'), selectAll('market_brand_monthly'), selectAll('market_asin_weekly'), selectAll('market_variation_monthly')]);
      MK.data = {vr, bm, aw, vm};
    } catch(e){ $('#mkTiles').innerHTML = missingSchema(e) ? schemaHint : '<div class="notice">Không tải được: ' + esc(e.message || e) + '</div>'; return; }
  }
  const D = MK.data;
  const cats = [...new Set([...D.vr, ...D.bm, ...D.aw, ...D.vm].map(r => r.category))].filter(Boolean).sort();
  if(!cats.length){ $('#mkTiles').innerHTML = '<div class="notice">Chưa có dữ liệu market. Chạy 05_market.sql.</div>'; return; }
  if(!MK.cat || !cats.includes(MK.cat)) MK.cat = cats.includes('Tricep Ropes') ? 'Tricep Ropes' : cats[0];
  chipRow($('#mkCats'), cats.map(c => ({l:c})), c => c.l === MK.cat, c => { MK.cat = c.l; MK.attr = null; renderMK(); });
  const aw = D.aw.filter(r => r.category === MK.cat), bm = D.bm.filter(r => r.category === MK.cat), vr = D.vr.filter(r => r.category === MK.cat), vm = D.vm.filter(r => r.category === MK.cat);
  $('#mkSrc').textContent = 'Nguồn: ' + [...new Set([...aw, ...bm, ...vr, ...vm].map(r => (r.source || '').split('#')[0]))].join(', ');
  // monthly brand revenue: from ASIN weekly (price × units) or the brand monthly table
  let monthly = [];
  if(aw.length){
    const g = new Map();
    aw.forEach(r => { if(!isNum(+r.price) || +r.price <= 0) return; const m = r.week_start.slice(0, 7) + '-01'; const k = m + '|' + r.brand; const e = g.get(k) || {month:m, brand:r.brand, rev:0, units:0}; e.rev += (+r.price) * (+r.units || 0); e.units += +r.units || 0; g.set(k, e); });
    monthly = [...g.values()].map(e => ({...e, price: e.units ? e.rev / e.units : NaN}));
  } else if(bm.length){ monthly = bm.map(r => ({month:r.month, brand:r.brand, rev:+r.revenue || 0, units:+r.units || NaN, price: isNum(+r.avg_price) && +r.avg_price > 0 ? +r.avg_price : NaN})); }
  let months = [...new Set(monthly.map(r => r.month))].sort();
  // drop a trailing month that is only partly covered by weekly data
  if(aw.length && months.length){ const lm = months[months.length - 1]; const wks = new Set(aw.filter(r => r.week_start.slice(0, 7) === lm.slice(0, 7)).map(r => r.week_start)).size; if(wks < 4){ monthly = monthly.filter(r => r.month !== lm); months = months.slice(0, -1); } }
  const totBy = new Map(); monthly.forEach(r => totBy.set(r.month, (totBy.get(r.month) || 0) + r.rev));
  monthly.forEach(r => r.share = div(r.rev, totBy.get(r.month)));
  const lastM = months[months.length - 1];
  const rankLast = monthly.filter(r => r.month === lastM).sort((a, b) => b.rev - a.rev);
  const y4a = b => /yes4all|y4a/i.test(b);
  const focus = [...new Set([...rankLast.filter(r => y4a(r.brand)).map(r => r.brand), ...rankLast.filter(r => !y4a(r.brand)).slice(0, 2).map(r => r.brand)])];
  const colorOf = b => y4a(b) ? PAL.s1 : b === focus.filter(x => !y4a(x))[0] ? PAL.s2 : b === focus.filter(x => !y4a(x))[1] ? PAL.s3 : PAL.other;
  const y4Last = rankLast.find(r => y4a(r.brand)), y4Prev = monthly.find(r => y4a(r.brand) && r.month === months[Math.max(0, months.length - 13)]);
  $('#mkTiles').innerHTML = [
    ['Quy mô ' + (lastM ? mLabel(lastM) : ''), f$(totBy.get(lastM)), months.length > 12 ? deltaHtml(totBy.get(lastM), totBy.get(months[months.length - 13])) + '<span>YoY</span>' : ''],
    ['Thị phần Yes4All (tập brand trong file)', y4Last ? fP(y4Last.share) : '—', y4Last && y4Prev ? deltaHtml(y4Last.share, y4Prev.share, false, true) + '<span>vs 12 tháng</span>' : '<span>chưa có trong nguồn</span>'],
    ['Xếp hạng Yes4All', y4Last ? '#' + (rankLast.findIndex(r => y4a(r.brand)) + 1) + ' / ' + rankLast.length : '—', ''],
    ['Brand dẫn đầu', rankLast[0] ? rankLast[0].brand : '—', rankLast[0] ? fP(rankLast[0].share) : ''],
  ].map(([k, v2, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v2)}</div><div class="d">${d}</div></div>`).join('');
  if(monthly.length){
    const hasPrice = monthly.some(r => isNum(r.price));
    $('#mkMapTitle').textContent = hasPrice ? 'Brand map: giá × thời gian × thị phần' : 'Brand map: thị phần theo thời gian';
    $('#mkMapHint').textContent = (hasPrice ? 'Trục dọc = giá bán trung bình (doanh thu ÷ units), trục ngang = tháng, kích thước = doanh thu. ' : 'Nguồn này chỉ có doanh thu theo brand, nên trục dọc là thị phần. ') + 'Yes4All màu cam, 2 đối thủ lớn nhất màu xanh, các brand khác màu xám. Kéo thanh trượt bên dưới để phóng to/thu nhỏ khoảng thời gian.';
    const brands = [...new Set(monthly.map(r => r.brand))].sort((a, b) => (focus.includes(b) - focus.includes(a)));
    const maxRev = Math.max(1, ...monthly.map(r => r.rev));
    let otherShown = false;
    const traces = brands.map(b => { const rs = monthly.filter(r => r.brand === b).sort((a, c) => a.month.localeCompare(c.month)); const hi = focus.includes(b); const leg = hi || !otherShown; if(!hi) otherShown = true;
      return {type:'scatter', mode:'lines+markers', name: hi ? b : 'Brand khác', legendgroup: hi ? b : 'other', showlegend: leg, x: rs.map(r => r.month), y: rs.map(r => hasPrice ? r.price : r.share),
        line:{color:colorOf(b), width: hi ? 1.6 : .8, shape:'spline'}, opacity: hi ? 1 : .5, marker:{size: rs.map(r => 7 + 40 * Math.sqrt(r.rev / maxRev)), color:colorOf(b), opacity: hi ? .78 : .38, line:{width:1.4, color:'#fff'}},
        customdata: rs.map(r => [r.share, r.rev, r.units]), hovertemplate:`<b>${esc(b)}</b> · %{x|%b-%y}<br>${hasPrice ? 'Giá TB: %{y:$.2f}<br>' : ''}Thị phần: %{customdata[0]:.1%}<br>Doanh thu: %{customdata[1]:$,.0f}<extra></extra>`}; });
    draw('mkMap', traces, lay({xaxis:ax({type:'date', tickformat:'%b-%y', rangeslider:{visible:true, thickness:.07, bgcolor:'#F4F6F9', bordercolor:PAL.line}, range: months.length > 13 ? [months[months.length - 13], addDaysIso(lastM, 27)] : undefined}),
      yaxis:ax(hasPrice ? {tickprefix:'$', title:{text:'Giá trung bình', font:{size:11, color:PAL.muted}}} : {tickformat:'.0%', title:{text:'Thị phần', font:{size:11, color:PAL.muted}}}), hovermode:'closest', margin:{l:60, r:110, t:8, b:30}, legend:{orientation:'h', y:1.1, x:0, font:{size:11, color:PAL.muted}},
      annotations: rankLast.filter(r => focus.includes(r.brand)).sort((a, b) => (hasPrice ? b.price - a.price : b.share - a.share)).map((r, i, arr) => ({x:lastM, y: hasPrice ? r.price : r.share, text:`<b>${esc(r.brand)}</b> ${fP(r.share, 0)}`, xanchor:'left', xshift:22, yshift:(arr.length - 1) * 7 - i * 14, showarrow:false, font:{size:10.5, color:PAL.ink}}))}));
  } else { $('#mkMap').innerHTML = '<div class="v2-note" style="padding:20px">Category này không có dữ liệu theo tháng trong file nghiên cứu.</div>'; }
  // ladder
  const prices = vr.filter(r => r.metric === 'price'), revs = vr.filter(r => r.metric === 'revenue');
  if(prices.length){
    const vars = [...new Set(prices.map(r => r.variation))];
    const brands = [...new Set(prices.map(r => r.brand))];
    const revOf = (b, v2) => { const r = revs.find(x => x.brand === b && x.variation === v2); return r ? +r.value : 0; };
    const vTot = new Map(vars.map(v2 => [v2, revs.filter(r => r.variation === v2).reduce((s, r) => s + (+r.value || 0), 0)]));
    const ladderFocus = [...new Set([...brands.filter(y4a), ...[...brands].sort((a, b) => revs.filter(r => r.brand === b).reduce((s, r) => s + +r.value, 0) - revs.filter(r => r.brand === a).reduce((s, r) => s + +r.value, 0)).filter(b => !y4a(b)).slice(0, 2)])];
    const lc = b => y4a(b) ? PAL.s1 : b === ladderFocus.filter(x => !y4a(x))[0] ? PAL.s2 : b === ladderFocus.filter(x => !y4a(x))[1] ? PAL.s3 : PAL.other;
    let oth = false;
    draw('mkLadder', brands.map(b => { const ps = prices.filter(r => r.brand === b); const hi = ladderFocus.includes(b); const leg = hi || !oth; if(!hi) oth = true;
      return {type:'scatter', mode:'markers', name: hi ? b : 'Brand khác', legendgroup: hi ? b : 'o', showlegend: leg, y: ps.map(r => r.variation), x: ps.map(r => +r.value),
        marker:{size: ps.map(r => 9 + 30 * Math.sqrt(div(revOf(b, r.variation), vTot.get(r.variation)) || 0)), color: lc(b), opacity: hi ? .85 : .4, line:{width:1.4, color:'#fff'}},
        customdata: ps.map(r => [div(revOf(b, r.variation), vTot.get(r.variation))]), hovertemplate:`<b>${esc(b)}</b> · %{y}<br>Giá: %{x:$.2f}<br>Thị phần trong variation: %{customdata[0]:.0%}<extra></extra>`}; }),
      lay({xaxis:ax({tickprefix:'$', title:{text:'Giá', font:{size:11, color:PAL.muted}}}), yaxis:ax({type:'category', categoryorder:'array', categoryarray: vars, automargin:true, autorange:'reversed'}), hovermode:'closest', margin:{l:10, r:16, t:8, b:54},
        shapes: vars.map(v2 => { const ps = prices.filter(r => r.variation === v2).map(r => +r.value); return {type:'line', xref:'x', yref:'y', x0:Math.min(...ps), x1:Math.max(...ps), y0:v2, y1:v2, line:{color:'#E4E7EC', width:6}, layer:'below'}; })}));
  } else { $('#mkLadder').innerHTML = '<div class="v2-note" style="padding:20px">Không có bảng giá theo variation cho category này.</div>'; }
  // price vs sales
  if(aw.length){
    const lastW = aw.reduce((m, r) => r.week_start > m ? r.week_start : m, '');
    const since = addDaysIso(lastW, -56);
    const g = new Map(); aw.filter(r => r.week_start > since && +r.price > 0).forEach(r => { const e = g.get(r.asin) || {asin:r.asin, brand:r.brand, title:r.title, p:0, u:0, n:0}; e.p += +r.price; e.u += +r.units || 0; e.n++; g.set(r.asin, e); });
    const pts = [...g.values()].map(e => ({...e, price: e.p / e.n, units: e.u / e.n})).filter(e => e.units > 0);
    $('#mkPsHint').textContent = `Mỗi chấm là một ASIN, trung bình 8 tuần gần nhất (tới ${dm(lastW)}). Trục log. Đường gạch = độ co giãn giá ước tính từ toàn bộ ASIN.`;
    const lx = pts.map(p => Math.log(p.price)), ly2 = pts.map(p => Math.log(p.units));
    const fit = pts.length >= 3 ? ols(lx, ly2) : null;
    const pmin = Math.min(...pts.map(p => p.price)), pmax = Math.max(...pts.map(p => p.price));
    const curve = Array.from({length: 24}, (_, i) => pmin * Math.pow(pmax / pmin, i / 23));
    const bset = [...new Set(pts.map(p => p.brand))]; let oth = false;
    draw('mkPs', [...bset.map(b => { const ps = pts.filter(p => p.brand === b); const hi = focus.includes(b); const leg = hi || !oth; if(!hi) oth = true;
      return {type:'scatter', mode:'markers', name: hi ? b : 'Brand khác', legendgroup: hi ? b : 'o', showlegend: leg, x: ps.map(p => p.price), y: ps.map(p => p.units), marker:{size: hi ? 10 : 8, color: colorOf(b), opacity: hi ? .85 : .45, line:{width:1.4, color:'#fff'}}, customdata: ps.map(p => [p.asin, (p.title || '').slice(0, 60)]), hovertemplate:`<b>${esc(b)}</b> %{customdata[0]}<br>%{customdata[1]}<br>Giá %{x:$.2f} · %{y:,.0f} units/tuần<extra></extra>`}; }),
      ...(fit ? [{type:'scatter', mode:'lines', name:'Xu hướng', x:curve, y:curve.map(p => Math.exp(fit.a + fit.b * Math.log(p))), line:{color:PAL.ink, width:1.4, dash:'dash'}, hoverinfo:'skip'}] : [])],
      lay({xaxis:ax({type:'log', tickprefix:'$', title:{text:'Giá (log)', font:{size:11, color:PAL.muted}}}), yaxis:ax({type:'log', tickformat:'~s', title:{text:'Units / tuần (log)', font:{size:11, color:PAL.muted}}}), hovermode:'closest', margin:{l:60, r:10, t:8, b:54}}));
    $('#mkEl').innerHTML = fit ? `<b>Độ co giãn ≈ ${fit.b.toFixed(2)}</b>: giá cao hơn 10% thì số bán thấp hơn khoảng ${Math.abs(fit.b * 10).toFixed(0)}% ở mặt bằng category (n = ${pts.length} ASIN). Đây là tương quan giữa các ASIN, chưa tách ảnh hưởng của review, ranking hay ads.` : '';
  } else { $('#mkPs').innerHTML = '<div class="v2-note" style="padding:20px">Không có dữ liệu giá/units theo ASIN cho category này.</div>'; $('#mkPsHint').textContent = ''; $('#mkEl').innerHTML = ''; }
  // variation monthly
  const attrs = [...new Set(vm.map(r => r.attribute))];
  if(attrs.length){
    if(!MK.attr || !attrs.includes(MK.attr)) MK.attr = attrs[0];
    chipRow($('#mkAttr'), attrs.map(a => ({l:a})), a => a.l === MK.attr, a => { MK.attr = a.l; renderMK(); });
    const rows = vm.filter(r => r.attribute === MK.attr); const modes = [...new Set(rows.map(r => r.mode))]; const rr = rows.filter(r => r.mode === modes[0]);
    const vars = [...new Set(rr.map(r => r.variation))];
    draw('mkVar', vars.map((v2, i) => { const s = rr.filter(r => r.variation === v2).sort((a, b) => a.month.localeCompare(b.month)); return {type:'scatter', mode:'lines', stackgroup:'one', name:v2, x:s.map(r => r.month), y:s.map(r => +r.value), line:{width:1, color: i < 5 ? CAT5[i] : PAL.other}, hovertemplate:`${esc(v2)}: %{y:,.0f}<extra></extra>`}; }),
      lay({xaxis:ax({type:'date', tickformat:'%b-%y'}), yaxis:ax({tickformat:'~s', title:{text: 'Market size (' + (modes[0] || 'giá trị') + ')', font:{size:11, color:PAL.muted}}}), hovermode:'x unified', margin:{l:56, r:10, t:8, b:54}}));
  } else { $('#mkAttr').innerHTML = ''; $('#mkVar').innerHTML = '<div class="v2-note" style="padding:20px">Không có dữ liệu market size theo variation cho category này.</div>'; }
}

// =====================================================================
// Tab routing
// =====================================================================
V2.activeTab = 'sales';
V2.onTab = function(tab){
  V2.activeTab = tab;
  if(!ROWS.length) return;
  if(tab === 'sp'){ if(SPdirty || !SPbuilt) renderSP(!SPbuilt); }
  else if(tab === 'wr'){ if(WRdirty || !WRbuilt) renderWR(); }
  else if(tab === 'ads'){ if(ADSdirty) renderAdsV2(); }
  else if(tab === 'mk'){ renderMK(); }
  setTimeout(() => $$('#view-' + tab + ' .js-plotly-plot').forEach(p => { try { Plotly.Plots.resize(p); } catch(_){ } }), 60);
};
V2.onMonthChange = function(){ SPdirty = true; WRdirty = true; ADSdirty = true; V2.onTab(V2.activeTab); };
V2.onAdsFilter = function(){ ADSdirty = true; if(V2.activeTab === 'ads') renderAdsV2(); };
})();
