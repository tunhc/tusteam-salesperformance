// =====================================================================
// Yes4All Sales Dashboard — v3 modules (loaded after v2.js)
//   · AI chat box (bottom-right): name/team gate, every question stored
//   · Product Performance BI charts
//   · Market: price → CM3 calculator with history of price vs units
//   · Projects: one-block quick entry, parsed into a status table
// =====================================================================
(function(){
'use strict';
const V3 = window.V3 = {};
const H = () => window.V2.h;

// ------------------------------------------------------------------ CSS
const css = document.createElement('style');
css.textContent = `
.chat-fab{position:fixed;right:20px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:250;background:var(--navy);color:#fff;border:0;border-radius:999px;padding:12px 18px;font:700 13px Poppins,Arial,sans-serif;box-shadow:0 10px 26px rgba(0,40,89,.35);cursor:pointer;display:flex;gap:8px;align-items:center}
[hidden]{display:none !important}
.chat-fab .dot{width:9px;height:9px;border-radius:50%;background:var(--orange)}
.chat-panel{position:fixed;right:20px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:251;width:410px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 120px);background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 48px rgba(0,40,89,.28);display:flex;flex-direction:column;overflow:hidden}
.chat-panel header{background:var(--navy);color:#fff;padding:11px 14px;display:flex;align-items:center;gap:8px;box-shadow:none}
.chat-panel header b{font-size:13.5px}.chat-panel header .who{font-size:11px;color:#B9C6D6;margin-left:auto}
.chat-panel header button{border:0;background:rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px}
.chat-body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:9px;background:#F6F7F8}
.chat-msg{max-width:88%;padding:8px 11px;border-radius:12px;font-size:12.6px;line-height:1.5;word-wrap:break-word}
.chat-msg.user{align-self:flex-end;background:var(--orange);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}
.chat-msg.ai{align-self:flex-start;background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
.chat-msg.ai table{border-collapse:collapse;margin:6px 0;font-size:11.5px}.chat-msg.ai th,.chat-msg.ai td{border:1px solid var(--line);padding:3px 6px;position:static;background:#fff;color:var(--ink);white-space:nowrap;text-transform:none;letter-spacing:0;font-size:11.5px}
.chat-msg.ai th{background:#F1F3F6;font-weight:700}
.chat-msg.ai ul{margin:4px 0;padding-left:18px}.chat-msg.ai code{background:#F1F3F6;border-radius:4px;padding:0 4px;font-size:11px}
.chat-msg details{margin-top:6px;font-size:11px;color:var(--muted)}.chat-msg details pre{white-space:pre-wrap;background:#F6F7F8;border-radius:6px;padding:6px;font-size:10.5px;max-height:160px;overflow:auto}
.chat-suggest{display:flex;flex-wrap:wrap;gap:6px}.chat-suggest button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 10px;font-size:11.5px;cursor:pointer;font-family:inherit;text-align:left}
.chat-suggest button:hover{border-color:var(--orange)}
.chat-input{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:#fff}
.chat-input textarea{flex:1;resize:none;height:44px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:12.6px Poppins,Arial,sans-serif}
.chat-input button{border:0;background:var(--orange);color:#fff;border-radius:10px;padding:0 14px;font-weight:700;cursor:pointer}
.chat-gate{padding:18px;display:flex;flex-direction:column;gap:10px;font-size:12.5px}
.chat-gate input,.chat-gate select{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:13px Poppins,Arial,sans-serif;width:100%}
.typing{align-self:flex-start;color:var(--muted);font-size:12px;font-style:italic}
.wf-note{font-size:11.5px;color:var(--muted)}
.calc-grid{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,8fr);gap:14px}
@media (max-width:1000px){.calc-grid{grid-template-columns:minmax(0,1fr)}}
.calc-in{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.calc-in .fld{display:flex;flex-direction:column;gap:3px}.calc-in label{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.calc-in input,.calc-in select{border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:12.5px Poppins,Arial,sans-serif;width:100%}
.cost-tbl td{padding:4px 8px;font-size:12px}.cost-tbl td.n{text-align:right;font-variant-numeric:tabular-nums}
.proj-quick textarea{width:100%;min-height:110px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:12.8px Poppins,Arial,sans-serif;resize:vertical}
.pparse{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.pparse span{background:#F1F3F6;border-radius:8px;padding:4px 9px;font-size:11.8px}.pparse span b{color:var(--navy)}
.pst{font-size:10.5px;font-weight:800;border-radius:20px;padding:2px 9px;white-space:nowrap}
.pst.Done{background:var(--green-bg);color:var(--green)}.pst.Issue{background:var(--red-bg);color:var(--red)}.pst.Pending{background:var(--amber-bg);color:var(--amber)}.pst.Planned{background:#EEF1F5;color:var(--muted)}.pst.In-progress{background:#E6EEFB;color:#1F5FBF}`;
document.head.appendChild(css);

// =====================================================================
// AI chat box
// =====================================================================
const CHAT_KEY = 'y4a_chat_session_v1';
const loadSession = () => { try { return JSON.parse(localStorage.getItem(CHAT_KEY) || 'null'); } catch(e){ return null; } };
const saveSession = s => { try { s ? localStorage.setItem(CHAT_KEY, JSON.stringify(s)) : localStorage.removeItem(CHAT_KEY); } catch(e){} };
const SUGGEST = ['Tháng 9 năm ngoái Dumbbell Neoprene bán được bao nhiêu units?', 'Chỉ số nào đang có vấn đề cho Standard Dumbbells tuần này?', 'Top 5 SKU giảm GMV mạnh nhất 7 ngày qua so với 7 ngày trước', 'SKU nào sắp hết hàng trong 2 tuần tới?', 'Nên chạy deal hay tăng ads cho Tricep Ropes?'];
function md(text){
  const esc = H().esc;
  const lines = String(text || '').split('\n'); const out = []; let i = 0;
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  while(i < lines.length){
    const l = lines[i];
    if(/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:\-|]+\|\s*$/.test(lines[i + 1])){
      const row = s => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2; const body = [];
      while(i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div style="overflow-x:auto"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if(/^\s*[-*•]\s+/.test(l)){ const items = []; while(i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, '')); out.push('<ul>' + items.map(t => `<li>${inline(t)}</li>`).join('') + '</ul>'); continue; }
    if(/^#{1,4}\s+/.test(l)){ out.push(`<div style="font-weight:800;color:var(--navy);margin-top:4px">${inline(l.replace(/^#{1,4}\s+/, ''))}</div>`); i++; continue; }
    out.push(l.trim() ? `<div>${inline(l)}</div>` : '<div style="height:6px"></div>'); i++;
  }
  return out.join('');
}
function buildChat(){
  const fab = document.createElement('button'); fab.className = 'chat-fab'; fab.type = 'button'; fab.innerHTML = '<span class="dot"></span>Hỏi AI'; fab.setAttribute('aria-label', 'Mở chat với AI');
  const panel = document.createElement('div'); panel.className = 'chat-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat với AI');
  document.body.append(fab, panel);
  fab.onclick = () => { panel.hidden = !panel.hidden; if(!panel.hidden) renderPanel(); };
  function renderPanel(){
    const s = loadSession();
    if(!s){
      const teams = ['Team Cẩm Tú', 'Team Đồng Dinh', 'Spreetail', 'Khác'];
      panel.innerHTML = `<header><b>Trợ lý dữ liệu & Amazon</b><button type="button" data-close>✕</button></header>
        <div class="chat-gate"><div>Nhập tên và team trước khi bắt đầu. Mọi câu hỏi được lưu lại để team tra cứu sau.</div>
          <label class="lbl2" for="cgName">Tên</label><input id="cgName" list="cgNames" placeholder="VD: Thư Lâm"><datalist id="cgNames">${(window.V2.PIC_LIST || []).map(n => `<option value="${H().esc(n)}">`).join('')}</datalist>
          <label class="lbl2" for="cgTeam">Team</label><select id="cgTeam">${teams.map(t => `<option>${t}</option>`).join('')}</select>
          <button class="btn primary" type="button" id="cgStart">Bắt đầu</button><div class="wf-note" id="cgErr"></div></div>`;
      panel.querySelector('[data-close]').onclick = () => { panel.hidden = true; };
      panel.querySelector('#cgStart').onclick = async () => {
        const name = panel.querySelector('#cgName').value.trim(), team = panel.querySelector('#cgTeam').value;
        if(!name){ panel.querySelector('#cgErr').textContent = 'Nhập tên để bắt đầu.'; return; }
        const {data, error} = await sb.from('chat_sessions').insert({user_name: name, team}).select().single();
        if(error){ panel.querySelector('#cgErr').textContent = H().missingSchema(error) ? 'Cần chạy supabase_schema_v3.sql trước.' : 'Không tạo được phiên: ' + error.message; return; }
        saveSession({id: data.id, name, team}); renderPanel();
      };
      return;
    }
    panel.innerHTML = `<header><b>Trợ lý dữ liệu & Amazon</b><span class="who">${H().esc(s.name)} · ${H().esc(s.team || '')}</span><button type="button" data-new title="Phiên mới / đổi người">Đổi</button><button type="button" data-close>✕</button></header>
      <div class="chat-body" id="chatBody"></div>
      <div class="chat-input"><textarea id="chatIn" placeholder="Hỏi số liệu hoặc xin tư vấn Amazon… (Enter để gửi)"></textarea><button type="button" id="chatSend">Gửi</button></div>`;
    panel.querySelector('[data-close]').onclick = () => { panel.hidden = true; };
    panel.querySelector('[data-new]').onclick = () => { saveSession(null); renderPanel(); };
    const body = panel.querySelector('#chatBody'), inp = panel.querySelector('#chatIn');
    const add = (role, html) => { const d = document.createElement('div'); d.className = 'chat-msg ' + (role === 'user' ? 'user' : 'ai'); if(role === 'user') d.textContent = html; else d.innerHTML = html; body.appendChild(d); body.scrollTop = body.scrollHeight; return d; };
    const aiHtml = (text, sql) => md(text) + (sql && sql.length ? `<details><summary>SQL đã chạy (${sql.length})</summary>${sql.map(q => `<pre>${H().esc(q)}</pre>`).join('')}</details>` : '');
    (async () => {
      const {data} = await sb.from('chat_messages').select('role, content, sql_used').eq('session_id', s.id).order('id', {ascending:true});
      (data || []).forEach(m => add(m.role, m.role === 'user' ? m.content : aiHtml(m.content, m.sql_used)));
      if(!(data || []).length){
        add('ai', md(`Chào **${s.name}**. Mình tra được dữ liệu sales (2023 → nay), target, tồn kho, incoming, weekly review, action tracker và market. Ví dụ:`));
        const sug = document.createElement('div'); sug.className = 'chat-suggest'; sug.innerHTML = SUGGEST.map(q => `<button type="button">${H().esc(q)}</button>`).join(''); body.appendChild(sug);
        sug.querySelectorAll('button').forEach(b => b.onclick = () => { inp.value = b.textContent; send(); });
      }
    })();
    async function send(){
      const msg = inp.value.trim(); if(!msg) return;
      inp.value = ''; add('user', msg);
      const t = document.createElement('div'); t.className = 'typing'; t.textContent = 'AI đang tra dữ liệu…'; body.appendChild(t); body.scrollTop = body.scrollHeight;
      try {
        const {data, error} = await sb.functions.invoke('ai-chat', {body: {session_id: s.id, message: msg}});
        if(error){ let m2 = error.message; try { const j = await error.context.json(); m2 = j.error || m2; } catch(_){} throw new Error(m2); }
        if(data && data.error) throw new Error(data.error);
        t.remove(); add('ai', aiHtml(data.answer, data.sql));
      } catch(e){ t.remove(); add('ai', `<b>Chưa trả lời được:</b> ${H().esc(e.message || e)}<div class="wf-note">Cần deploy Edge Function <code>ai-chat</code> và thêm secret <code>ANTHROPIC_API_KEY</code> (xem README). Câu hỏi của bạn đã được lưu.</div>`); }
    }
    panel.querySelector('#chatSend').onclick = send;
    inp.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
    setTimeout(() => inp.focus(), 50);
  }
}

// =====================================================================
// Product Performance: BI charts
// =====================================================================
let perfToken = 0;
V3.renderPerfCharts = async function(rows){
  const h = H(); const host = document.getElementById('perfV3'); if(!host || typeof Plotly === 'undefined') return;
  if(!host.dataset.built){
    host.dataset.built = '1';
    host.innerHTML = `<div class="tiles" id="pvTiles"></div>
      <div class="grid2"><div class="card" style="margin:0"><h3 style="margin:0 0 3px">CM3 vs GMV</h3><div class="hint">Mỗi chấm là một SKU (tháng đang chọn, tới ngày có data). Kích thước = MKT fee, màu = CM3 %. Dưới đường 0 = đang lỗ sau marketing.</div><div id="pvCm3" class="plot tall"></div></div>
        <div class="card" style="margin:0"><h3 style="margin:0 0 3px">Tăng trưởng GMV so với cùng kỳ năm trước</h3><div class="hint">25 SKU thay đổi GMV lớn nhất (theo $). Vạch giữa là 0%: bên phải tăng, bên trái giảm.</div><div id="pvYoy" class="plot tall"></div></div></div>
      <div class="grid2" style="margin-top:14px"><div class="card" style="margin:0"><h3 style="margin:0 0 3px">%MKT/GMV vs CM3 % · tìm SKU “đốt tiền”</h3><div class="hint">Góc dưới-phải (vùng đỏ nhạt) = chi MKT cao hơn trung vị nhưng CM3 % thấp hơn trung vị.</div><div id="pvBurn" class="plot tall"></div></div>
        <div class="card" style="margin:0"><h3 style="margin:0 0 3px">SKU chi MKT cao, CM3 thấp</h3><div class="hint">Xếp theo MKT fee. Đề xuất xem lại bid/deal hoặc giá.</div><div class="tablewrap" style="max-height:420px"><table id="pvBurnTbl"></table></div></div></div>`;
  }
  const token = ++perfToken;
  const to = DATA.asOfDate || todayISO(), from = to.slice(0, 8) + '01';
  let ly = [];
  try { ly = await h.rpcAll('sales_by_sku', {p_from: h.addMonths(from, -12), p_to: h.addMonths(to, -12)}); } catch(e){}
  if(token !== perfToken) return;
  const lyBy = new Map(ly.map(r => [r.sku, r]));
  const pts = rows.filter(r => r.actualGMV > 0 || (lyBy.get(r.sku) && +lyBy.get(r.sku).gmv > 0)).map(r => {
    const cm3 = h.isNum(r.cm3Base) ? r.actualUnits * r.cm3Base - (r.cm3Lane === 'SPT' ? 0 : r.adsActual * .985 + r.promoActual) : NaN;
    const lg = +(lyBy.get(r.sku) || {}).gmv || 0;
    return {sku:r.sku, name:r.productName || '', pl:r.mainPL, gmv:r.actualGMV, mkt:r.mktActual, cm3, cm3Pct: r.actualGMV ? cm3 / r.actualGMV : NaN, mktPct: r.actualGMV ? r.mktActual / r.actualGMV : NaN, ly:lg, yoy: lg ? r.actualGMV / lg - 1 : NaN, d: r.actualGMV - lg};
  });
  const tot = pts.reduce((a, p) => ({gmv:a.gmv + p.gmv, mkt:a.mkt + p.mkt, ly:a.ly + p.ly, cm3:a.cm3 + (h.isNum(p.cm3) ? p.cm3 : 0), cg:a.cg + (h.isNum(p.cm3) ? p.gmv : 0)}), {gmv:0, mkt:0, ly:0, cm3:0, cg:0});
  const grow = pts.filter(p => p.ly > 0 && p.d > 0).length, decl = pts.filter(p => p.ly > 0 && p.d < 0).length;
  document.getElementById('pvTiles').innerHTML = [['GMV MTD', h.f$(tot.gmv), h.deltaHtml(tot.gmv, tot.ly) + '<span>vs LY</span>'], ['MKT fee', h.f$(tot.mkt), '<span>' + h.fP(h.div(tot.mkt, tot.gmv)) + ' GMV</span>'], ['CM3 ước tính', h.f$(tot.cm3), '<span>' + h.fP(h.div(tot.cm3, tot.cg)) + ' GMV có cost</span>'], ['SKU tăng / giảm YoY', grow + ' / ' + decl, '<span>có data năm trước</span>']]
    .map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  // 1) CM3 vs GMV
  const c = pts.filter(p => h.isNum(p.cm3) && p.gmv >= 50); const mxM = Math.max(1, ...c.map(p => p.mkt)); const mxA = Math.min(.5, Math.max(.05, ...c.map(p => Math.abs(p.cm3Pct)).filter(h.isNum)));
  const top = [...c].sort((a, b) => b.gmv - a.gmv).slice(0, 6).map(p => p.sku);
  h.draw('pvCm3', [{type:'scatter', mode:'markers+text', x:c.map(p => p.gmv), y:c.map(p => p.cm3), text:c.map(p => top.includes(p.sku) ? p.sku : ''), textposition:'top center', textfont:{size:10, color:h.PAL.muted},
    marker:{size:c.map(p => 8 + 30 * Math.sqrt(Math.max(0, p.mkt) / mxM)), color:c.map(p => p.cm3Pct), colorscale:h.divScale, cmin:-mxA, cmax:mxA, cmid:0, opacity:.85, line:{width:1.4, color:'#fff'}, colorbar:{title:{text:'CM3 %', font:{size:10.5}}, tickformat:'.0%', thickness:10, len:.7, outlinewidth:0}},
    customdata:c.map(p => [p.sku, p.name.slice(0, 55), p.mkt, p.cm3Pct, p.pl]), hovertemplate:'<b>%{customdata[0]}</b> %{customdata[1]}<br>%{customdata[4]}<br>GMV %{x:$,.0f} · CM3 %{y:$,.0f} (%{customdata[3]:.1%})<br>MKT fee %{customdata[2]:$,.0f}<extra></extra>'}],
    h.lay({xaxis:h.ax({type:'log', tickprefix:'$', title:{text:'GMV (log)', font:{size:11}}}), yaxis:h.ax({tickprefix:'$', tickformat:'~s', title:{text:'CM3 $', font:{size:11}}}), shapes:[{type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:0, y1:0, line:{color:h.PAL.crit, width:1.3, dash:'dot'}}], margin:{l:60, r:8, t:8, b:46}, hovermode:'closest'}));
  // 2) YoY diverging bars
  const stopped = pts.filter(p => p.ly > 50 && p.gmv <= 0);
  const y = pts.filter(p => p.ly > 50 && p.gmv > 0 && h.isNum(p.yoy)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 25).sort((a, b) => a.yoy - b.yoy);
  const yh = document.querySelector('#pvYoy').previousElementSibling; if(yh) yh.innerHTML = `25 SKU thay đổi GMV lớn nhất (theo $), chỉ tính SKU còn bán kỳ này. Vạch giữa là 0%: phải tăng, trái giảm.${stopped.length ? ` <b>${stopped.length} SKU không còn doanh số</b> so với cùng kỳ (GMV năm trước ${h.f$(stopped.reduce((t, p) => t + p.ly, 0))}): ${stopped.sort((a, b) => b.ly - a.ly).slice(0, 8).map(p => h.esc(p.sku)).join(', ')}${stopped.length > 8 ? '…' : ''}.` : ''}`;
  h.draw('pvYoy', [{type:'bar', orientation:'h', y:y.map(p => p.sku), x:y.map(p => Math.max(-1, Math.min(2, p.yoy))), marker:{color:y.map(p => p.yoy >= 0 ? '#2a78d6' : '#D64545')},
    text:y.map(p => (p.yoy >= 0 ? '+' : '') + (p.yoy * 100).toFixed(0) + '%'), textposition:'outside', textfont:{size:10, color:h.PAL.muted}, cliponaxis:false,
    customdata:y.map(p => [p.name.slice(0, 55), p.gmv, p.ly, p.d]), hovertemplate:'<b>%{y}</b> %{customdata[0]}<br>GMV %{customdata[1]:$,.0f} vs LY %{customdata[2]:$,.0f}<br>Δ %{customdata[3]:$,.0f}<extra></extra>'}],
    h.lay({xaxis:h.ax({tickformat:'.0%', zeroline:true, zerolinecolor:'#C9CED6', zerolinewidth:2, range:[-1.15, 2.25], title:{text:'YoY % (cắt ở −100% / +200%)', font:{size:11}}}), yaxis:h.ax({automargin:true, tickfont:{size:10}}), margin:{l:8, r:30, t:8, b:44}, showlegend:false, height:Math.max(380, y.length * 18 + 70),
      shapes:[{type:'rect', xref:'x', yref:'paper', x0:-1.15, x1:0, y0:0, y1:1, fillcolor:'rgba(214,69,69,.04)', line:{width:0}, layer:'below'}, {type:'rect', xref:'x', yref:'paper', x0:0, x1:2.25, y0:0, y1:1, fillcolor:'rgba(42,120,214,.04)', line:{width:0}, layer:'below'}]}));
  // 3) burn map
  const b = pts.filter(p => h.isNum(p.cm3Pct) && h.isNum(p.mktPct) && p.gmv >= 100);
  const med = arr => { const s = [...arr].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] || 0; };
  const mM = med(b.map(p => p.mktPct)), mC = med(b.map(p => p.cm3Pct));
  const burn = b.filter(p => p.mktPct > mM && p.cm3Pct < mC);
  const mxG = Math.max(1, ...b.map(p => p.gmv));
  h.draw('pvBurn', [{type:'scatter', mode:'markers', x:b.map(p => p.mktPct), y:b.map(p => p.cm3Pct), marker:{size:b.map(p => 7 + 26 * Math.sqrt(p.gmv / mxG)), color:b.map(p => burn.includes(p) ? '#D64545' : '#2a78d6'), opacity:.75, line:{width:1.3, color:'#fff'}},
    customdata:b.map(p => [p.sku, p.name.slice(0, 55), p.gmv, p.mkt]), hovertemplate:'<b>%{customdata[0]}</b> %{customdata[1]}<br>%MKT/GMV %{x:.1%} · CM3 %{y:.1%}<br>GMV %{customdata[2]:$,.0f} · MKT %{customdata[3]:$,.0f}<extra></extra>'}],
    h.lay({xaxis:h.ax({tickformat:'.0%', title:{text:'%MKT/GMV', font:{size:11}}}), yaxis:h.ax({tickformat:'.0%', title:{text:'CM3 %', font:{size:11}}}), showlegend:false, margin:{l:56, r:8, t:8, b:46}, hovermode:'closest',
      shapes:[{type:'rect', xref:'x', yref:'y', x0:mM, x1:Math.max(mM + .01, ...b.map(p => p.mktPct)) * 1.05, y0:Math.min(mC - .01, ...b.map(p => p.cm3Pct)) * 1.1 - .02, y1:mC, fillcolor:'rgba(214,69,69,.07)', line:{width:0}, layer:'below'},
        {type:'line', xref:'x', yref:'paper', x0:mM, x1:mM, y0:0, y1:1, line:{color:'#D5D9DF', width:1.2}}, {type:'line', xref:'paper', yref:'y', x0:0, x1:1, y0:mC, y1:mC, line:{color:'#D5D9DF', width:1.2}}]}));
  document.getElementById('pvBurnTbl').innerHTML = '<thead><tr><th>SKU</th><th>Tên</th><th class="num">GMV</th><th class="num">MKT fee</th><th class="num">%MKT/GMV</th><th class="num">CM3 %</th></tr></thead><tbody>' +
    (burn.sort((a, b2) => b2.mkt - a.mkt).map(p => `<tr><td><b>${h.esc(p.sku)}</b></td><td class="name-cell" title="${h.esc(p.name)}">${h.esc(p.name.slice(0, 40))}</td><td class="num">${h.f$(p.gmv)}</td><td class="num">${h.f$(p.mkt)}</td><td class="num" style="color:var(--red);font-weight:700">${h.fP(p.mktPct)}</td><td class="num" style="color:${p.cm3Pct < 0 ? 'var(--red)' : 'var(--amber)'};font-weight:700">${h.fP(p.cm3Pct)}</td></tr>`).join('') || '<tr><td colspan="6" class="v2-note">Không có SKU nào trong vùng này.</td></tr>') + '</tbody>';
};

// =====================================================================
// Market: price → CM3 calculator
// =====================================================================
const R_LB = {DI:0.00617589, SPT:0.00617589, DS:0.11579795}, R_CBM = {DI:6.207626, SPT:6.207626, DS:116.392987};
const CU_LB = 0.00634563, CU_CBM = 6.378239, ARD = {DI:135, DS:168, SPT:35}, FRATE = 0.115 / 365;
// Same cascade as the V9.8 HTML (ported in ingest_v2.py / prepare_cm3_mart.py), per unit.
function cm3Calc(k, lane, price, revenue, adsR, promoR){
  const c = {fob:-k.fob, tariff:-k.fob * k.duty, inb:-Math.max(k.weight_lb * R_LB[lane], k.cbm * R_CBM[lane]), cirro:0, vt:0, perf:0, stor:0, pp:0, promo:0, ads:0, amex:0};
  let nmv;
  if(lane === 'SPT'){ nmv = revenue; }
  else { nmv = price * (1 - .75 * promoR); c.promo = -price * promoR; c.ads = -price * adsR; c.amex = price * adsR * .015; }
  if(lane === 'DI'){ c.vt = -revenue * .01; c.perf = -revenue * .005; }
  else if(lane === 'DS'){ c.cirro = -Math.max(k.weight_lb * CU_LB, k.cbm * CU_CBM); c.vt = -revenue * .1375; c.perf = -revenue * .005; c.stor = -k.cbm * 20.10; c.pp = -(1.5 + Math.max(k.weight_lb - 20, 0) * .1); }
  const ar = ARD[lane], io = lane === 'DS' ? 60 : 0;
  const fin = (c.fob * (ar - 120) + c.tariff * (ar - 68) + (c.inb + c.cirro) * (ar - io) + (c.pp + c.ads) * (ar - 103)) * FRATE;
  const pre = revenue + Object.values(c).reduce((a, b) => a + b, 0) + fin;
  let tu = 0;
  if((lane === 'DI' || lane === 'DS') && nmv > 0){ const csa = lane === 'DI' ? .505 : .40; const netPpm = (nmv - revenue + Math.abs(c.vt) + Math.abs(c.perf) + price * .25 * promoR) / nmv; tu = Math.max(0, csa - netPpm) * nmv; }
  return {c, fin, tu, revenue, cm3: pre - tu};
}
const CALC = {sku:null, k:null, hist:null};
V3.renderCalc = async function(host){
  const h = H(); if(!host) return;
  if(!host.dataset.built){
    host.dataset.built = '1';
    host.innerHTML = `<div class="card"><h3 style="margin:0 0 3px">Máy tính giá → CM3</h3><div class="hint">Chọn SKU, nhập giá bán muốn thử. Chi phí theo cost stack CM3 by Lane V9.8; Ads % và Promo % mặc định lấy theo 90 ngày gần nhất của SKU. Chart bên phải: giá bán và số bán theo tuần trong 2 năm qua, đường gạch là xu hướng (log-log), vạch cam là giá đang thử.</div>
      <div class="calc-grid" style="margin-top:8px"><div>
        <div class="calc-in">
          <div class="fld" style="grid-column:1/-1"><label for="ccSku">SKU</label><input id="ccSku" list="ccSkus" placeholder="Gõ SKU hoặc tên"><datalist id="ccSkus"></datalist></div>
          <div class="fld"><label for="ccPrice">Giá bán (ASP) $</label><input id="ccPrice" type="number" step="0.01" min="0"></div>
          <div class="fld"><label for="ccLane">Lane</label><select id="ccLane"><option>DI</option><option>DS</option><option>SPT</option></select></div>
          <div class="fld"><label for="ccAds">Ads % GMV</label><input id="ccAds" type="number" step="0.1" min="0"></div>
          <div class="fld"><label for="ccPromo">Promo % GMV</label><input id="ccPromo" type="number" step="0.1" min="0"></div>
          <div class="fld"><label for="ccRev">Sell-in / unit $</label><input id="ccRev" type="number" step="0.01" min="0"></div>
          <div class="fld"><label for="ccScale">Sell-in theo giá</label><select id="ccScale"><option value="1">Tỷ lệ theo giá (đổi list price)</option><option value="0">Giữ nguyên (chỉ giảm giá/deal)</option></select></div>
        </div>
        <div class="tiles" id="ccTiles" style="margin-top:10px"></div>
        <table class="cost-tbl" id="ccCosts" style="width:100%"></table>
        <div class="wf-note" id="ccNote"></div></div>
        <div><div id="ccHist" class="plot tall"></div><div class="readout" id="ccRead"></div></div></div></div>`;
    document.getElementById('ccSkus').innerHTML = ROWS.filter(r => h.isNum(r.cm3Base)).map(r => `<option value="${h.esc(r.sku)}">${h.esc(r.sku)} · ${h.esc((r.productName || '').slice(0, 60))}</option>`).join('');
    const pick = () => { const v = document.getElementById('ccSku').value.trim().toUpperCase().split(' ')[0]; if(v && v !== CALC.sku && h.skuInfo(v)) loadSku(v); };
    document.getElementById('ccSku').addEventListener('change', pick); document.getElementById('ccSku').addEventListener('keydown', e => { if(e.key === 'Enter') pick(); });
    ['ccPrice','ccLane','ccAds','ccPromo','ccRev'].forEach(id => document.getElementById(id).addEventListener('input', compute));
    document.getElementById('ccScale').addEventListener('change', () => { setRevDefault(); compute(); });
    document.getElementById('ccLane').addEventListener('change', () => { setRevDefault(); compute(); });
    document.getElementById('ccPrice').addEventListener('change', () => { if(document.getElementById('ccScale').value === '1') setRevDefault(); compute(); });
  }
  const want = (window.GS && GS.sku && h.skuInfo(GS.sku)) ? GS.sku : (CALC.sku || (ROWS.filter(r => h.isNum(r.cm3Base)).sort((a, b) => (b.actualGMV || 0) - (a.actualGMV || 0))[0] || {}).sku);
  if(want && want !== CALC.sku) loadSku(want);
};
function setRevDefault(){
  const k = CALC.k; if(!k) return; const lane = document.getElementById('ccLane').value;
  const base = lane === 'DI' ? k.rev_di : lane === 'DS' ? k.rev_ds : k.rev_spt;
  const price = +document.getElementById('ccPrice').value || k.asp_canon;
  const scale = document.getElementById('ccScale').value === '1' && k.asp_canon > 0 ? price / k.asp_canon : 1;
  document.getElementById('ccRev').value = (base * scale).toFixed(2);
}
async function loadSku(sku){
  const h = H(); CALC.sku = sku; document.getElementById('ccSku').value = sku;
  const {data, error} = await sb.rpc('cm3_inputs', {p_sku: sku});
  if(error || !data || !data.length){ CALC.k = null; document.getElementById('ccNote').innerHTML = error && h.missingSchema(error) ? 'Cần chạy supabase_schema_v3.sql và 08_cm3_cost_stack.sql.' : 'SKU này chưa có cost stack trong file CM3 V9.8.'; document.getElementById('ccCosts').innerHTML = ''; document.getElementById('ccTiles').innerHTML = ''; return; }
  const k = data[0]; ['fob','duty','weight_lb','cbm','asp_canon','rev_di','rev_ds','rev_spt'].forEach(f => k[f] = +k[f] || 0); CALC.k = k;
  const mx = window.V2.state.maxDate || todayISO();
  const [r90] = await Promise.all([h.rpcAll('sales_trend', {p_from: addDaysIso(mx, -89), p_to: mx, p_grain: 'month', p_skus: [sku]})]);
  const a = r90.reduce((t, r) => ({gmv:t.gmv + (+r.gmv || 0), ads:t.ads + (+r.ads || 0), promo:t.promo + (+r.promo || 0), units:t.units + (+r.units || 0)}), {gmv:0, ads:0, promo:0, units:0});
  const info = h.skuInfo(sku) || {};
  const asp = a.units ? a.gmv / a.units : k.asp_canon;
  document.getElementById('ccPrice').value = (asp || k.asp_canon).toFixed(2);
  document.getElementById('ccLane').value = ['DI','DS','SPT'].includes(k.lane) ? k.lane : 'DI';
  document.getElementById('ccAds').value = a.gmv ? (a.ads / a.gmv * 100).toFixed(1) : '7.0';
  document.getElementById('ccPromo').value = a.gmv ? (a.promo / a.gmv * 100).toFixed(1) : '0.0';
  setRevDefault();
  document.getElementById('ccNote').innerHTML = `${h.esc(info.productName || '')} · cost stack ${h.esc(k.source || '')}. 90 ngày gần nhất: ASP ${h.f$2(asp)}, ${h.fN(a.units)} units, TACOS ${h.fP(h.div(a.ads, a.gmv))}, Promo ${h.fP(h.div(a.promo, a.gmv))}.`;
  CALC.hist = await h.rpcAll('sales_trend_by_sku', {p_from: addDaysIso(mx, -728), p_to: mx, p_grain: 'week', p_skus: [sku]});
  compute();
}
function compute(){
  const h = H(), k = CALC.k; if(!k) return;
  const price = +document.getElementById('ccPrice').value || 0, lane = document.getElementById('ccLane').value;
  const adsR = (+document.getElementById('ccAds').value || 0) / 100, promoR = (+document.getElementById('ccPromo').value || 0) / 100, rev = +document.getElementById('ccRev').value || 0;
  const r = cm3Calc(k, lane, price, rev, adsR, promoR);
  // demand at this price from weekly history (log-log fit)
  const pts = (CALC.hist || []).filter(w => +w.units > 0 && +w.gmv > 0).map(w => ({p:+w.gmv / +w.units, u:+w.units, d:w.period}));
  let est = NaN, fit = null;
  if(pts.length >= 6){ fit = h.ols(pts.map(p => Math.log(p.p)), pts.map(p => Math.log(p.u))); if(price > 0) est = Math.exp(fit.a + fit.b * Math.log(price)); }
  const mktUnit = lane === 'SPT' ? 0 : price * (adsR + promoR);
  const monthUnits = h.isNum(est) ? est * 30 / 7 : NaN;
  document.getElementById('ccTiles').innerHTML = [['CM3 / unit', h.f$2(r.cm3), `<span>${h.fP(price ? r.cm3 / price : NaN)} giá bán</span>`], ['MKT fee / unit', h.f$2(mktUnit), `<span>Ads ${h.fP(adsR)} + Promo ${h.fP(promoR)}</span>`],
    ['Units / tháng (ước tính)', h.fN(monthUnits), '<span>theo xu hướng giá–số bán</span>'], ['CM3 / tháng (ước tính)', h.f$(monthUnits * r.cm3), `<span>GMV ≈ ${h.f$(monthUnits * price)}</span>`]]
    .map(([a, b, d]) => `<div class="tile"><div class="k">${a}</div><div class="v">${b}</div><div class="d">${d}</div></div>`).join('');
  const L = {fob:'FOB', tariff:'Thuế nhập khẩu', inb:'Inbound logistics', cirro:'Cirro unload', vt:'VT / Co-op', perf:'Performance 0.5%', stor:'Storage', pp:'Pick & pack', promo:'Promo', ads:'Ads', amex:'Amex hoàn ads'};
  const rowsC = [['Doanh thu sell-in', r.revenue], ...Object.entries(r.c).filter(([, v]) => Math.abs(v) > 1e-4).map(([q, v]) => [L[q] || q, v]), ['Chi phí vốn (financing)', r.fin], ['True-up', -r.tu]];
  document.getElementById('ccCosts').innerHTML = '<tbody>' + rowsC.map(([l, v]) => `<tr><td>${l}</td><td class="n" style="color:${v < 0 ? 'var(--red)' : 'var(--ink)'}">${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}</td><td class="n wf-note">${price ? (v / price * 100).toFixed(1) + '%' : ''}</td></tr>`).join('') +
    `<tr style="border-top:2px solid var(--line);font-weight:800"><td>CM3 / unit</td><td class="n" style="color:${r.cm3 < 0 ? 'var(--red)' : 'var(--green)'}">${r.cm3 < 0 ? '−' : ''}$${Math.abs(r.cm3).toFixed(2)}</td><td class="n">${price ? (r.cm3 / price * 100).toFixed(1) + '%' : ''}</td></tr></tbody>`;
  // history chart
  const now = Date.now();
  const age = pts.map(p => (now - new Date(p.d + 'T00:00:00')) / 864e5);
  const data = [{type:'scatter', mode:'markers', x:pts.map(p => p.p), y:pts.map(p => p.u), name:'Tuần đã bán', marker:{size:9, color:age, colorscale:[[0, '#002859'], [1, '#C9D6EA']], cmin:0, cmax:730, line:{width:1, color:'#fff'}, colorbar:{title:{text:'Ngày trước', font:{size:10}}, thickness:8, len:.6, outlinewidth:0}},
    customdata:pts.map(p => p.d), hovertemplate:'Tuần %{customdata}<br>ASP %{x:$.2f} · %{y:,.0f} units<extra></extra>'}];
  if(fit){ const ps = pts.map(p => p.p); const lo = Math.min(...ps, price || Infinity) * .95, hi = Math.max(...ps, price || 0) * 1.05; const xs = Array.from({length:30}, (_, i) => lo * Math.pow(hi / lo, i / 29)); data.push({type:'scatter', mode:'lines', x:xs, y:xs.map(x => Math.exp(fit.a + fit.b * Math.log(x))), name:'Xu hướng', line:{color:h.PAL.ink, width:1.4, dash:'dash'}, hoverinfo:'skip'}); }
  h.draw('ccHist', data, h.lay({xaxis:h.ax({type:'log', tickprefix:'$', title:{text:'Giá bán trung bình tuần (log)', font:{size:11}}}), yaxis:h.ax({type:'log', tickformat:'~s', title:{text:'Units / tuần (log)', font:{size:11}}}), showlegend:false, margin:{l:56, r:8, t:8, b:46}, hovermode:'closest',
    shapes: price ? [{type:'line', xref:'x', yref:'paper', x0:price, x1:price, y0:0, y1:1, line:{color:'#FF7000', width:2}}] : [], annotations: price && h.isNum(est) ? [{x:Math.log10(price), y:Math.log10(est), xref:'x', yref:'y', text:`${h.f$2(price)} → ~${h.fN(est)} units/tuần`, showarrow:true, arrowcolor:'#FF7000', ax:40, ay:-30, font:{size:11, color:'#7A3A00'}, bgcolor:'#FFF3EA'}] : []}));
  document.getElementById('ccRead').innerHTML = fit ? `<b>Độ co giãn ≈ ${fit.b.toFixed(2)}</b> (từ ${pts.length} tuần): giá tăng 10% thì số bán thay đổi khoảng ${(fit.b * 10).toFixed(0)}%. Ước tính chỉ dựa trên lịch sử giá–số bán của SKU này, chưa tách ảnh hưởng của mùa vụ, deal và ads.` : 'Chưa đủ tuần có bán hàng để ước tính xu hướng giá–số bán.';
}

// =====================================================================
// Projects: quick entry
// =====================================================================
const PJ = {rows:[], open:new Set(), filter:''};
const TEMPLATE = `Topic: Soft Kettlebell launch
Nhóm: Standard Kettlebells
Trạng thái: Đang làm
Ngày: ${new Date().toLocaleDateString('en-GB').slice(0, 5)}
Nội dung: Hàng đã nhập kho FBA, chờ listing live; đặt lịch chạy coupon tuần sau`;
const KEYS = { topic:/^(topic|chủ đề|chu de|dự án|du an|project|sản phẩm mới|npd)$/i, group:/^(nhóm|nhom|group|product group|pl|product line|main pl|line)$/i, status:/^(trạng thái|trang thai|status|tt)$/i, date:/^(ngày|ngay|date|update|ngày update)$/i, content:/^(nội dung|noi dung|content|note|ghi chú|ghi chu|update|chi tiết|chi tiet)$/i, author:/^(người|nguoi|pic|author|by|người cập nhật)$/i };
const STATUS = [['Done', /(xong|hoàn thành|hoan thanh|done|completed|đã live|da live|live rồi|closed)/i], ['Issue', /(vướng|vuong|issue|blocked|block|lỗi|loi|delay|trễ|tre|rủi ro|risk)/i], ['Pending', /(chờ|cho duyet|pending|waiting|hold|tạm dừng)/i], ['Planned', /(kế hoạch|ke hoach|plan|sắp|sap|chưa bắt đầu)/i], ['In progress', /(đang|dang|in progress|doing|wip|triển khai|trien khai)/i]];
function normStatus(t){ for(const [s, rx] of STATUS) if(rx.test(t || '')) return s; return null; }
function parseProject(text){
  const out = {topic:'', group:'', status:'', date:'', content:'', author:''}; const rest = [];
  String(text || '').split(/\n|\s\|\s/).map(l => l.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^([^:：]{1,24})\s*[:：]\s*(.*)$/);
    const k = m && Object.keys(KEYS).find(key => KEYS[key].test(m[1].trim()));
    if(k) out[k] = (out[k] ? out[k] + ' ' : '') + m[2].trim(); else rest.push(line);
  });
  const all = text || '';
  if(!out.topic && rest.length){ const first = rest.shift(); const mm = first.match(/^(.{3,60}?)\s+[-–:]\s+(.*)$/); if(mm){ out.topic = mm[1]; rest.unshift(mm[2]); } else out.topic = first.slice(0, 80); }
  if(!out.content) out.content = rest.join('\n');
  if(!out.status) out.status = normStatus(all) || 'In progress'; else out.status = normStatus(out.status) || out.status;
  const dm = (out.date || all).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const now = new Date();
  if(dm){ const y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : now.getFullYear(); out.date = y + '-' + String(+dm[2]).padStart(2, '0') + '-' + String(+dm[1]).padStart(2, '0'); } else out.date = todayISO();
  if(!out.group){ const names = [...new Set(ROWS.flatMap(r => [r.mainPL, r.subPL]).filter(n => n && n !== 'Unclassified'))].sort((a, b) => b.length - a.length); const hit = names.find(n => all.toLowerCase().includes(n.toLowerCase())); out.group = hit || ''; }
  if(!out.author){ try { const s = JSON.parse(localStorage.getItem('y4a_chat_session_v1') || 'null'); if(s) out.author = s.name; } catch(e){} }
  return out;
}
async function renderProjects(){
  const h = H(); const host = document.getElementById('projV3'); if(!host) return;
  if(!host.dataset.built){
    host.dataset.built = '1';
    host.innerHTML = `<div class="card proj-quick"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h3 style="margin:0">Cập nhật nhanh dự án / sản phẩm mới</h3><button class="btn small" type="button" id="pjTpl">Chèn mẫu</button></div>
      <div class="hint">Gõ một khối như tin nhắn chat. Có thể dùng mẫu “Topic / Nhóm / Trạng thái / Ngày / Nội dung”, hoặc gõ tự do (VD: <i>Soft KB launch - đang chờ listing live, 05/10 chạy coupon</i>); hệ thống tự tách topic, nhóm sản phẩm, trạng thái, ngày. Ctrl+Enter để lưu.</div>
      <textarea id="pjText" placeholder="${h.esc(TEMPLATE)}"></textarea>
      <div class="pparse" id="pjParsed"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="button" id="pjSave">Lưu cập nhật</button><span class="wf-note">Trạng thái nhận diện: Done · In progress · Issue · Pending · Planned</span></div></div>
      <div class="card"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Trạng thái dự án</h3>
        <div class="cv-toggle" id="pjFilter"><button class="cv-btn active" data-s="" type="button">Tất cả</button>${['In progress','Issue','Pending','Planned','Done'].map(s => `<button class="cv-btn" data-s="${s}" type="button">${s}</button>`).join('')}</div></div>
        <div class="hint">Mỗi topic lấy cập nhật mới nhất. Bấm ▸ để xem lịch sử.</div><div class="tablewrap"><table id="pjTable"></table></div></div>`;
    const ta = document.getElementById('pjText');
    const preview = () => { const p = parseProject(ta.value); document.getElementById('pjParsed').innerHTML = ta.value.trim() ? [['Topic', p.topic], ['Nhóm', p.group || '—'], ['Trạng thái', p.status], ['Ngày', p.date.split('-').reverse().join('/')], ['Người', p.author || '—'], ['Nội dung', (p.content || '—').slice(0, 120)]].map(([k, v]) => `<span><b>${k}:</b> ${h.esc(v)}</span>`).join('') : ''; };
    ta.addEventListener('input', preview);
    ta.addEventListener('keydown', e => { if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); document.getElementById('pjSave').click(); } });
    document.getElementById('pjTpl').onclick = () => { ta.value = TEMPLATE; preview(); ta.focus(); };
    document.getElementById('pjSave').onclick = async () => {
      const raw = ta.value.trim(); if(!raw){ h.toast('Gõ nội dung cập nhật trước'); return; }
      const p = parseProject(raw); if(!p.topic){ h.toast('Chưa nhận ra topic'); return; }
      const {error} = await sb.from('project_updates').insert({topic:p.topic, product_group:p.group || null, status:p.status, content:p.content, update_date:p.date, author:p.author || null, raw_text:raw});
      if(error){ h.toast(h.missingSchema(error) ? 'Cần chạy supabase_schema_v3.sql trước' : 'Không lưu được: ' + error.message); return; }
      ta.value = ''; preview(); h.toast('Đã lưu cập nhật'); await loadProjects(); drawProjects();
    };
    document.getElementById('pjFilter').onclick = e => { const b = e.target.closest('[data-s]'); if(!b) return; PJ.filter = b.dataset.s; document.querySelectorAll('#pjFilter .cv-btn').forEach(x => x.classList.toggle('active', x === b)); drawProjects(); };
  }
  await loadProjects(); drawProjects();
}
async function loadProjects(){ try { PJ.rows = await H().selectAll('project_updates', q => q.order('update_date', {ascending:false})); } catch(e){ PJ.rows = []; PJ.err = e; } }
function drawProjects(){
  const h = H(); const t = document.getElementById('pjTable'); if(!t) return;
  if(PJ.err && h.missingSchema(PJ.err)){ t.innerHTML = '<tr><td class="v2-note">Cần chạy supabase_schema_v3.sql để bật Projects mới.</td></tr>'; return; }
  const by = new Map(); PJ.rows.forEach(r => { const a = by.get(r.topic) || []; a.push(r); by.set(r.topic, a); });
  const topics = [...by.entries()].map(([topic, list]) => { list.sort((a, b) => (b.update_date + b.created_at).localeCompare(a.update_date + a.created_at)); return {topic, list, last:list[0]}; })
    .filter(x => !PJ.filter || x.last.status === PJ.filter).sort((a, b) => (b.last.update_date || '').localeCompare(a.last.update_date || ''));
  const cls = s => String(s || '').replace(/\s/g, '-');
  t.innerHTML = '<thead><tr><th>Topic</th><th>Nhóm</th><th>Trạng thái</th><th>Cập nhật mới nhất</th><th>Ngày</th><th>Người</th><th class="num">Số lần</th></tr></thead><tbody>' +
    (topics.map(x => { const open = PJ.open.has(x.topic); return `<tr class="clickable" data-t="${h.esc(x.topic)}"><td style="white-space:normal;min-width:160px"><span style="display:inline-block;width:14px">${open ? '▾' : '▸'}</span><b>${h.esc(x.topic)}</b></td><td>${h.esc(x.last.product_group || '')}</td><td><span class="pst ${cls(x.last.status)}">${h.esc(x.last.status || '')}</span></td><td style="white-space:normal;min-width:260px">${h.esc(x.last.content || '')}</td><td>${h.dm(x.last.update_date)}</td><td>${h.esc(x.last.author || '')}</td><td class="num">${x.list.length}</td></tr>` +
      (open ? x.list.slice(1).map(r => `<tr class="sub"><td></td><td>${h.esc(r.product_group || '')}</td><td><span class="pst ${cls(r.status)}">${h.esc(r.status || '')}</span></td><td style="white-space:normal">${h.esc(r.content || '')}</td><td>${h.dm(r.update_date)}</td><td>${h.esc(r.author || '')}</td><td></td></tr>`).join('') : ''); }).join('') || '<tr><td colspan="7" class="v2-note">Chưa có cập nhật nào.</td></tr>') + '</tbody>';
  t.querySelectorAll('tr.clickable').forEach(tr => tr.onclick = () => { const k = tr.dataset.t; PJ.open.has(k) ? PJ.open.delete(k) : PJ.open.add(k); drawProjects(); });
}

// ------------------------------------------------------------------ routing
V3.onTab = function(tab){ if(tab === 'projects') renderProjects(); };
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildChat); else buildChat();
V3.parseProject = parseProject;
})();
