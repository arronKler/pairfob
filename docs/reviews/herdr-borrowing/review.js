/* Review decisions only are persisted. Demonstrations are never saved. */
const STORAGE_KEY = 'pairfob:herdr-design-review:v1';
const decisions = {pending:'未评审',accept:'采纳',adjust:'调整',defer:'暂缓'};
let reviews = {};
let activeId = proposals.some(p=>p.id===location.hash.slice(1)) ? location.hash.slice(1) : 'files';
let storageAvailable = true;
let toastTimer;
try {
  const saved=JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  if(saved && typeof saved==='object' && !Array.isArray(saved)) {
    for(const p of proposals) {
      const r=saved[p.id];
      if(r && typeof r==='object') reviews[p.id]={decision:Object.hasOwn(decisions,r.decision)?r.decision:'pending',note:typeof r.note==='string'?r.note.slice(0,6000):''};
    }
  }
} catch {storageAvailable=false;}

function reviewFor(id) {return reviews[id] || {decision:'pending',note:''};}
function saveReviews() {
  try {localStorage.setItem(STORAGE_KEY,JSON.stringify(reviews)); storageAvailable=true;}
  catch {storageAvailable=false;}
  const status=document.querySelector('#save-state');
  if(status) status.textContent=storageAvailable?'已保存到本机':'仅保留在当前页面，请导出';
  updateCounts();
}
function updateCounts() {
  const count=proposals.filter(p=>reviewFor(p.id).decision!=='pending').length;
  document.querySelector('#review-count').textContent=`${count}/14`;
}
function renderCatalog() {
  const list=document.querySelector('#proposal-list');
  const scrollLeft=list.scrollLeft;
  const focusedId=list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const query=document.querySelector('#search').value.trim().toLowerCase();
  const category=document.querySelector('#category').value;
  const status=document.querySelector('#decision-filter').value;
  const filtered=proposals.filter(p=>(category==='全部主题'||p.category===category)
    && (status==='all'||reviewFor(p.id).decision===status)
    && `${p.title} ${p.short} ${p.scenario} ${p.priority} ${p.layer}`.toLowerCase().includes(query));
  document.querySelector('#catalog-count').textContent=`${filtered.length} / 14 项`;
  document.querySelector('#proposal-list').innerHTML=filtered.length?filtered.map(p=>{
    const r=reviewFor(p.id);
    return `<button class="proposal-nav ${p.id===activeId?'active':''}" data-id="${p.id}" ${p.id===activeId?'aria-current="true"':''}><span class="nav-num">${p.number}</span><span class="nav-copy"><strong>${p.short}</strong><small>${p.category} · ${p.priority}</small></span><span class="nav-status" aria-label="${decisions[r.decision]}">${r.decision==='accept'?'✓':r.decision==='adjust'?'↗':r.decision==='defer'?'—':''}</span></button>`;
  }).join(''):'<p class="empty">没有匹配的方案。<br>试试其他主题或状态。</p>';
  list.scrollLeft=scrollLeft;
  if(focusedId) list.querySelector(`[data-id="${focusedId}"]`)?.focus({preventScroll:true});
}
function renderDetail() {
  const p=proposals.find(x=>x.id===activeId);
  const r=reviewFor(activeId);
  document.querySelector('#detail').innerHTML=`
    <div class="detail-meta"><span>方案 ${p.number} / 14</span><span class="badge priority">${p.priority}</span><span>${p.layer}</span></div>
    <h2 class="detail-title">${p.title}</h2><p class="tagline">${p.tagline}</p>
    <div class="scenario"><span class="label">一个使用场景</span><p>${p.scenario}</p></div>
    <div class="comparison"><section><h3 class="section-label">已有基础 · 审阅快照</h3><p>${p.current}</p></section><section class="proposal-text"><h3 class="section-label">建议变成这样</h3><p>${p.proposal}</p><div class="benefit">↗ ${p.benefit}</div></section></div>
    <div class="specs"><details open><summary>需要守住的边界</summary><ul>${p.boundaries.map(x=>`<li>${x}</li>`).join('')}</ul></details><details><summary>验收条件 · ${p.acceptance.length} 项</summary><ul>${p.acceptance.map(x=>`<li>${x}</li>`).join('')}</ul></details><details><summary>实施范围 · 相对工作量 ${p.effort}</summary><p class="scope">${p.scope}</p></details></div>
    <div class="sources">${p.sources.map(([label,path])=>`<a href="${SOURCE+path}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`).join('')}</div>
    <section class="review-box"><header><h3>这项方案，你怎么看？</h3><span id="save-state">${storageAvailable?'仅本机保存':'存储不可用，请导出'}</span></header><div class="decisions">${['accept','adjust','defer'].map(key=>`<button data-decision="${key}" aria-pressed="${r.decision===key}">${decisions[key]}</button>`).join('')}</div><label for="review-note">评审意见 · 希望调整的范围或交互</label><textarea id="review-note" maxlength="6000" placeholder="例如：先做聊天路径，终端链接放到下一轮。">${escapeHTML(r.note)}</textarea><button class="clear-review" id="clear-review">恢复为未评审</button></section>
    <div class="detail-pager"><button id="previous" ${p===proposals[0]?'disabled':''}>← 上一项</button><button id="next" ${p===proposals.at(-1)?'disabled':''}>下一项 →</button></div>`;
}
function selectProposal(id) {
  if(!proposals.some(p=>p.id===id)) return;
  activeId=id;
  history.replaceState(null,'',`#${id}`);
  renderCatalog();
  renderDetail();
  startDemo(id);
}
function showToast(text) {
  const el=document.querySelector('#toast');
  el.textContent=text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),2300);
}
function reviewPayload() {
  return {
    title:'Pairfob · herdr-web-ui 借鉴方案评审',
    schema:1,
    exportedAt:new Date().toISOString(),
    referenceCommit:'623d5c88d43132a6cad185503794c2bb1caa4b96',
    notice:'设计评审，不代表已实现。仅导出评审意见，不包含演示输入。',
    proposals:proposals.map(p=>({id:p.id,title:p.title,priority:p.priority,category:p.category,...reviewFor(p.id),decisionLabel:decisions[reviewFor(p.id).decision],sources:p.sources.map(([label,path])=>({label,url:SOURCE+path}))})),
  };
}
function exportReview() {
  const blob=new Blob([JSON.stringify(reviewPayload(),null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`pairfob-review-${new Date().toISOString().slice(0,10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast('评审 JSON 已生成');
}
function openSummary() {
  const counts=Object.keys(decisions).map(key=>`<span>${decisions[key]} <b>${proposals.filter(p=>reviewFor(p.id).decision===key).length}</b></span>`).join('');
  document.querySelector('#summary-body').innerHTML=`<div class="summary-stats">${counts}</div>`+proposals.map(p=>{
    const r=reviewFor(p.id);
    return `<article class="summary-item"><header><button data-review-id="${p.id}">${p.number} · ${p.title}</button><span class="badge">${decisions[r.decision]}</span></header><small>${p.priority} · ${p.layer}</small>${r.note?`<p>${escapeHTML(r.note)}</p>`:''}</article>`;
  }).join('');
  document.querySelector('#storage-status').textContent=storageAvailable?'意见保存在当前浏览器，建议导出留存。':'浏览器存储不可用，请导出后再关闭页面。';
  document.querySelector('#summary').showModal();
}
document.querySelector('#proposal-list').addEventListener('click',e=>{
  const button=e.target.closest('[data-id]');
  if(button) selectProposal(button.dataset.id);
});
document.querySelector('#detail').addEventListener('click',e=>{
  const decision=e.target.closest('[data-decision]');
  if(decision) {
    reviews[activeId]={...reviewFor(activeId),decision:decision.dataset.decision};
    saveReviews();
    document.querySelectorAll('[data-decision]').forEach(b=>b.setAttribute('aria-pressed',String(b===decision)));
    renderCatalog();
  }
  if(e.target.closest('#clear-review')) {
    reviews[activeId]={...reviewFor(activeId),decision:'pending'};
    saveReviews(); renderDetail(); renderCatalog();
  }
  if(e.target.closest('#previous') || e.target.closest('#next')) {
    const offset=e.target.closest('#next')?1:-1;
    const p=proposals[proposals.findIndex(x=>x.id===activeId)+offset];
    if(p) {selectProposal(p.id); document.querySelector('#detail').focus({preventScroll:true});}
  }
});
document.querySelector('#detail').addEventListener('input',e=>{
  if(e.target.id==='review-note') {reviews[activeId]={...reviewFor(activeId),note:e.target.value}; saveReviews();}
});
document.querySelector('#search').addEventListener('input',renderCatalog);
document.querySelector('#category').addEventListener('change',renderCatalog);
document.querySelector('#decision-filter').addEventListener('change',renderCatalog);
document.querySelector('#demo-reset').addEventListener('click',()=>startDemo(activeId));
document.querySelector('#phone-view').addEventListener('click',()=>setPreviewWidth(false));
document.querySelector('#wide-view').addEventListener('click',()=>setPreviewWidth(true));
function setPreviewWidth(wide) {
  document.querySelector('.review-layout').classList.toggle('wide-preview',wide);
  document.querySelector('#prototype').classList.toggle('wide',wide);
  document.querySelector('#wide-view').setAttribute('aria-pressed',String(wide));
  document.querySelector('#phone-view').setAttribute('aria-pressed',String(!wide));
}
document.querySelector('#summary-open').addEventListener('click',openSummary);
document.querySelector('#summary-close').addEventListener('click',()=>document.querySelector('#summary').close());
document.querySelector('#summary').addEventListener('click',e=>{
  const button=e.target.closest('[data-review-id]');
  if(button) {document.querySelector('#summary').close(); selectProposal(button.dataset.reviewId); document.querySelector('#detail').focus();}
});
document.querySelector('#export').addEventListener('click',exportReview);
document.querySelector('#summary-export').addEventListener('click',exportReview);
window.addEventListener('hashchange',()=>selectProposal(location.hash.slice(1)));
renderCatalog();
renderDetail();
startDemo(activeId);
updateCounts();
