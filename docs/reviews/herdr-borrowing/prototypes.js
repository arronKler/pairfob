/* Local, deterministic interaction models. No network or product RPCs. */
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const demoButton = (action, text, primary = false, disabled = false) => `<button data-action="${action}" class="${primary ? 'primary' : ''}" ${disabled ? 'disabled' : ''}>${text}</button>`;
const demoStatus = (text, type = '') => `<div class="demo-status ${type}" role="status">${escapeHTML(text)}</div>`;
const demoTitle = (label, title) => `<p class="demo-kicker">${label}</p><h3 class="demo-title">${title}</h3>`;
const demoField = (value, placeholder = '写下你的要求…') => `<textarea class="demo-field" id="demo-text" aria-label="演示消息" placeholder="${placeholder}">${escapeHTML(value)}</textarea>`;
const demoRow = (title, sub, status) => `<div class="demo-row"><div>${title}<small>${sub}</small></div><b>${status}</b></div>`;
let demoState = {};
let demoId = 'files';

const demos = {
  files: {
    hint: '点回答里的路径，试试文件与 diff。',
    init: () => ({open: false, diff: false}),
    render: s => s.open
      ? `${demoTitle('WORKSPACE / src', 'app.ts')}<div class="demo-code">${s.diff ? '<span class="deleted">− await exportReport();</span>\n<span class="added">+ if (exporting) return;\n+ exporting = true;\n+ await exportReport();</span>' : 'export async function run() {\n  if (exporting) return;\n  exporting = true;\n  await exportReport();\n}'}</div>${demoStatus('来自 MacBook · 当前工作区')}<div class="demo-controls">${demoButton('diff', s.diff ? '看文件' : '看 diff', true)}${demoButton('back', '← 回到对话')}</div><p class="demo-caption">文件内容为示例。真实读取由电脑检查路径。</p>`
      : `${demoTitle('CHAT / CODEX', '修复重复导出')}<div class="bubble">请避免用户重复点击导出。</div><div class="bubble agent"><strong>Codex</strong>已修改 <button class="file-link" data-action="open">src/app.ts ↗</button>，现在同一时间只会执行一次导出。</div><div class="demo-status muted">原对话 · 阅读位置 12 / 18</div><div class="bubble">接下来检查手机上的按钮状态。</div>`,
    action(s, a) { if(a === 'open') s.open = true; if(a === 'back') s.open = false; if(a === 'diff') s.diff = !s.diff; },
  },
  history: {
    hint: '打开 A → 换到 B → 模拟系统返回。',
    init: () => ({page: 'chat', forward: null}),
    render: s => `${demoTitle('NAVIGATION / 历史栈模拟', s.page === 'chat' ? '原来的对话' : s.page)}${s.page === 'chat'
      ? '<div class="bubble agent">报告已生成，打开看看。</div><div class="bubble">草稿：再补一张移动端截图…</div>'
      : '<div class="demo-code"># 移动端检查\n\n✓ 按钮没有被软键盘遮住\n✓ 返回后保留原来的草稿</div>'}
      ${demoStatus(s.page === 'chat' ? '当前栈：聊天' : `当前栈：聊天 → ${s.page}`)}
      <div class="demo-controls">${demoButton('open', '打开文件 A', true, s.page !== 'chat')}${demoButton('next', '换到文件 B', false, s.page === 'chat')}${demoButton('back', '模拟系统返回', false, s.page === 'chat')}${demoButton('forward', '模拟前进', false, s.page !== 'chat' || !s.forward)}</div><p class="demo-caption">这里使用原型内的历史栈，不影响本评审页的浏览器导航。</p>`,
    action(s, a) { if(a === 'open') { s.page = 'report-A.md'; s.forward = null; } if(a === 'next') s.page = 'report-B.md'; if(a === 'back') {s.forward = s.page; s.page = 'chat';} if(a === 'forward' && s.forward) s.page = s.forward; },
  },
  offline: {
    hint: '断开网络后继续输入，再恢复连接。',
    init: () => ({online: true, text: '请顺便检查窄屏布局', sent: 0}),
    render: s => `${demoTitle('COMPOSE / DRAFT', '文字留在这里')}${demoStatus(s.online ? '已连接 · 可发送' : '重连中 · 可继续编辑，暂不发送', s.online ? '' : 'warn')}<div class="bubble agent">我正在检查布局。你可以继续补充要求。</div>${demoField(s.text)}<div class="demo-controls">${demoButton('send', '发送', true, !s.online || !s.text.trim())}${demoButton('network', s.online ? '模拟断线' : '恢复连接')}</div>${demoStatus(`已发送 ${s.sent} 条 · 恢复连接不会自动发送`, 'muted')}`,
    action(s, a) { if(a === 'network') s.online = !s.online; if(a === 'send' && s.online && s.text.trim()) {s.sent++; s.text = '';} },
    input(s, el) { if(el.id === 'demo-text') {s.text = el.value; document.querySelector('[data-action="send"]').disabled = !s.online || !s.text.trim();} },
  },
  queue: {
    hint: '试试排队、立即发送，以及断线后的暂停。',
    init: () => ({online: true, working: true, text: '结束后跑移动端测试', pending: '', held: false, uncertain: false, sent: 0}),
    render: s => `${demoTitle('CHAT / NEXT TURN', '安排下一步')}${demoStatus(s.online ? (s.working ? '正在修改代码…' : '本轮已结束') : '连接断开 · 队列暂停', s.online ? '' : 'warn')}
      ${s.pending ? `<div class="bubble"><strong>${s.uncertain ? '送达结果不确定' : s.held ? '已暂停 · 需手动处理' : '下一轮发送'}</strong>${escapeHTML(s.pending)}<div class="demo-controls">${demoButton('now', '立即发送', true, !s.online || s.uncertain)}${demoButton('discard', '丢弃')}</div></div>` : demoField(s.text)}
      <div class="demo-controls">${demoButton('enqueue', '加入队列', true, !!s.pending || !s.online)}${demoButton('finish', '模拟本轮结束', false, !s.working || !s.online)}${demoButton('network', s.online ? '模拟断线' : '重新连接')}${demoButton('uncertain', '模拟发送结果未知', false, !s.pending || !s.online || s.uncertain)}</div>
      ${demoStatus(`模拟投递 ${s.sent} 次`, 'muted')}<p class="demo-caption">断线会暂停。立即发送只代表尝试送达，不保证 agent 立即中断。</p>`,
    action(s, a) {
      if(a === 'enqueue' && s.online && !s.pending && s.text.trim()) {s.pending = s.text; s.held = false; s.uncertain = false;}
      if(a === 'network') {s.online = !s.online; if(!s.online && s.pending) s.held = true;}
      if(a === 'finish' && s.online) {s.working = false; if(s.pending && !s.held && !s.uncertain) {s.sent++; s.pending = '';}}
      if(a === 'now' && s.online && s.pending && !s.uncertain) {s.sent++; s.pending = '';}
      if(a === 'discard') {s.pending = ''; s.uncertain = false;}
      if(a === 'uncertain' && s.pending && s.online) {s.uncertain = true; s.held = true;}
    },
    input(s, el) { if(el.id === 'demo-text') s.text = el.value; },
  },
  approval: {
    hint: '选择多项；再模拟问题过期，观察提交保护。',
    init: () => ({selected: ['单元测试'], expired: false, submitted: false, answer: ''}),
    render: s => `${demoTitle('NEEDS YOU / QUESTION 1 OF 2', '运行哪些检查？')}${s.expired ? demoStatus('问题已变化 · 当前卡片不可提交', 'warn') : demoStatus(s.submitted ? '已提交选项' : '需要你确认')}
      <div class="demo-options">${['单元测试','TypeScript 检查','手机浏览器回归'].map(x => `<label class="demo-option"><input type="checkbox" data-choice="${x}" ${s.selected.includes(x) ? 'checked' : ''} ${s.expired || s.submitted ? 'disabled' : ''}>${x}</label>`).join('')}</div>
      <input id="approval-text" class="demo-input" placeholder="补充说明（可选）" aria-label="审批补充说明" value="${escapeHTML(s.answer)}" ${s.expired || s.submitted ? 'disabled' : ''}>
      <div class="demo-controls">${demoButton('submit', `提交 ${s.selected.length} 项`, true, s.expired || s.submitted || !s.selected.length)}${demoButton('expire', '模拟问题过期', false, s.expired || s.submitted)}</div>
      ${s.submitted ? `<div class="demo-result">已选择：${s.selected.map(escapeHTML).join('、')}${s.answer ? '<br>补充：'+escapeHTML(s.answer) : ''}</div>` : ''}`,
    action(s, a) {if(a === 'expire') s.expired = true; if(a === 'submit' && !s.expired && s.selected.length) s.submitted = true;},
    input(s, el) {if(el.id === 'approval-text') s.answer = el.value;},
    change(s, el) {if(el.dataset.choice) {s.selected = el.checked ? [...s.selected,el.dataset.choice] : s.selected.filter(x=>x!==el.dataset.choice); return true;}},
  },
  background: {
    hint: '依次结束子任务，再观察整体完成状态。',
    init: () => ({finished: 0, confirmed: false}),
    render: s => `${demoTitle('SESSION / BACKGROUND', '布局已改好，检查仍在跑')}${demoStatus(s.confirmed ? '全部工作已确认完成' : s.finished < 2 ? `后台 ${2-s.finished} 项 · 暂不报整体完成` : '子任务已结束 · 等待主 agent 汇总')}
      ${demoRow('主 agent', '已给出阶段回复', s.confirmed ? '已完成' : '等待后续')}${demoRow('审查响应式布局', '子 agent · 1m 24s', s.finished > 0 ? '已完成 ✓' : '运行中 ◌')}${demoRow('移动端测试', '后台命令 · bun run test', s.finished > 1 ? '已完成 ✓' : '运行中 ◌')}
      <div class="demo-controls">${demoButton('complete', '结束一项后台任务', true, s.finished === 2)}${demoButton('confirm', '主 agent 确认完成', false, s.finished !== 2 || s.confirmed)}</div><p class="demo-caption">后台任务结束后仍等待主任务证据；时间到了不等于成功。</p>`,
    action(s, a) {if(a === 'complete' && s.finished < 2) s.finished++; if(a === 'confirm' && s.finished === 2) s.confirmed = true;},
  },
  completion: {
    hint: '在输入框键入 @、/ 或 $，再点候选。',
    init: () => ({text: '请检查 @app 的按钮状态', caret: 8}),
    render: s => `${demoTitle('COMPOSE / SUGGESTIONS', '少输入一点路径')}${demoField(s.text)}<div id="suggestions"></div><div class="demo-controls">${demoButton('file', '@ 文件')}${demoButton('command', '/ 项目命令')}${demoButton('skill', '$ skill')}</div><p class="demo-caption">候选是示例；实际候选须由当前电脑的可信来源提供。</p>`,
    action(s,a) {
      if(['file','command','skill'].includes(a)) {s.text = a === 'file' ? '请检查 @app 的按钮状态' : a === 'command' ? '/review' : '请用 $audit 检查'; s.caret = a === 'file' ? 8 : a === 'command' ? 7 : 9;}
      if(a === 'choose') {
        const token = completionToken(s);
        if(token) { const replacement = token.kind === '@' ? '@src/app.ts' : token.kind === '/' ? '/review-mobile' : '$audit-ui'; s.text = s.text.slice(0,token.start)+replacement+s.text.slice(token.end); s.caret = token.start+replacement.length; }
      }
    },
    input(s,el) {if(el.id === 'demo-text') {s.text = el.value; s.caret = el.selectionStart; renderSuggestions();}},
    after() {const el=document.querySelector('#demo-text'); el.setSelectionRange(demoState.caret,demoState.caret); renderSuggestions();},
  },
  metadata: {
    hint: '切换到未知窗口，观察百分比消失。',
    init: () => ({known: true, expanded: false}),
    render: s => `${demoTitle('SESSION / METADATA', '这一轮，用的是什么')}${demoRow('模型', '来自会话记录 · 示例值', '示例模型 A')}${demoRow('推理强度', '来自本轮配置', 'high')}<div class="metric">${s.known ? '68<small>% 上下文占用</small>' : '136k<small> 已知用量</small>'}</div>
      ${s.known ? '<div class="meter"><span></span></div>' : demoStatus('窗口大小未知 · 不估算百分比', 'muted')}
      <div class="demo-controls">${demoButton('details', s.expanded ? '收起数据' : '查看数据', true)}${demoButton('unknown', s.known ? '模拟缺失窗口' : '恢复可信数据')}</div>
      ${s.expanded ? `<div class="demo-code">本次请求：136,000 tokens\n窗口大小：${s.known ? '200,000 tokens' : '未报告'}\n来源：当前会话原生记录</div>` : ''}<p class="demo-caption">上下文占用不是账号订阅配额。这里的模型和数值仅供演示。</p>`,
    action(s,a) {if(a === 'details') s.expanded=!s.expanded; if(a === 'unknown') s.known=!s.known;},
  },
  notifications: {
    hint: '选通知策略，模拟任务；等待期间可撤销。',
    init: () => ({pref: 'long', input: true, waiting: '', result: '尚无通知事件'}),
    render: s => `${demoTitle('THIS DEVICE / ALERTS', '让重要消息更突出')}<label class="demo-option"><input id="notify-input" type="checkbox" ${s.input?'checked':''}>提醒我处理等待确认</label><label class="demo-caption" for="notify-pref">任务完成通知</label><select id="notify-pref" class="demo-select"><option value="off" ${s.pref==='off'?'selected':''}>关闭</option><option value="long" ${s.pref==='long'?'selected':''}>仅长任务（示例：≥ 1 分钟）</option><option value="always" ${s.pref==='always'?'selected':''}>所有任务</option></select>
      <div class="demo-controls">${demoButton('short', '完成 8 秒任务')}${demoButton('long', '完成 3 分钟任务')}${demoButton('input', '需要确认')}</div>
      ${demoStatus(s.result, s.waiting ? 'warn' : 'muted')}<div class="demo-controls">${demoButton('tick', '模拟等待期结束', true, !s.waiting)}${demoButton('cancel', '期间已处理 / 恢复工作', false, !s.waiting)}</div><p class="demo-caption">只模拟决策，不请求通知权限或发送真实通知。</p>`,
    action(s,a) {
      if(['short','long','input'].includes(a)) { const allowed = a === 'input' ? s.input : s.pref === 'always' || (s.pref === 'long' && a === 'long'); s.waiting=allowed?a:''; s.result=allowed?'进入短暂等待，可被更新状态取消':'按本设备偏好，不发送通知'; }
      if(a === 'tick' && s.waiting) {s.result='模拟通知已送出：'+(s.waiting==='input'?'等待你确认':'长短策略通过，任务已完成'); s.waiting='';}
      if(a === 'cancel' && s.waiting) {s.waiting=''; s.result='状态已改变，待发通知已取消';}
    },
    change(s,el) {if(el.id==='notify-pref') s.pref=el.value; if(el.id==='notify-input') s.input=el.checked; s.waiting=''; s.result='偏好已更新（仅演示）'; return true;},
  },
  secret: {
    hint: '填入虚构口令，模拟切后台，确认立即清空。',
    init: () => ({value: '', valid: true, result: ''}),
    render: s => `${demoTitle('SECURE INPUT / EPHEMERAL', '终端正在等待口令')}<div class="demo-code">[sudo] password for demo:</div><label class="demo-caption" for="secret-input">仅填虚构口令，不要使用真实密码</label><input type="password" id="secret-input" class="demo-input" autocomplete="off" value="${escapeHTML(s.value)}" ${s.valid?'':'disabled'} placeholder="演示口令">
      <div class="demo-controls">${demoButton('send', '发送并清空', true, !s.valid || !s.value)}${demoButton('hide', '模拟切后台')}${demoButton('expire', '模拟提示变化', false, !s.valid)}</div>${demoStatus(s.result || '不进入草稿、队列、评审保存或导出', s.valid?'muted':'warn')}`,
    action(s,a) {s.value=''; if(a==='send') s.result='模拟发送成功，内容已清空'; if(a==='hide') s.result='页面隐藏，内容已清空'; if(a==='expire') {s.valid=false; s.result='提示已变化，清空并禁止发送';}},
    input(s,el) {if(el.id==='secret-input') {s.value=el.value; document.querySelector('[data-action="send"]').disabled=!s.value || !s.valid;}},
  },
  ime: {
    hint: '逐步回放预期事件，观察发送字节的顺序。',
    init: () => ({step: 0}),
    render: s => {
      const steps=['开始组字：n → ni','替换候选：你','确认候选：你','按下 Enter'];
      return `${demoTitle('QA / EXPECTED EVENT TRACE', '先组字，再发送')}${steps.map((x,i)=>`<div class="event-line ${i<s.step?'on':''}">${i<s.step?'✓':'○'} ${x}</div>`).join('')}<div class="demo-code">本地预编辑：${s.step===1?'ni':s.step===2?'你':'—'}\n传输缓冲：${s.step<3?'空':s.step===3?'你':'你 + \\r'}</div><div class="demo-controls">${demoButton('step','下一步事件',true,s.step===4)}</div>${demoStatus(s.step===4?'预期：你只出现一次，确认候选未提前发送 Enter':'合成示意，不是真机测试结果','muted')}<p class="demo-caption">实际需采集不同输入法事件，并比较 PTY 字节。回放通过不代表原生设备通过。</p>`;
    },
    action(s,a) {if(a==='step' && s.step<4) s.step++;},
  },
  reliability: {
    hint: '先发起读取，再切会话，最后让旧响应返回。',
    init: () => ({owner: 'A', request: '', result: '等待模拟事件'}),
    render: s => `${demoTitle('QA / RESPONSE OWNERSHIP', `当前会话 ${s.owner}`)}${demoRow('可见历史', '这里只属于当前会话', s.owner)}${demoRow('在途响应', '捕获请求发起时的归属', s.request || '无')}
      <div class="demo-controls">${demoButton('request', '发起历史读取', true, !!s.request)}${demoButton('switch', '切换会话')}${demoButton('reply', '旧响应到达', false, !s.request)}</div>${demoStatus(s.result, 'muted')}
      <div class="demo-code">其他必查场景\n□ clear 后的旧 cursor\n□ 等长文件替换\n□ 半条 JSONL 与重复事件\n□ 旧连接 ACK / 慢客户端</div><p class="demo-caption">这些是拟验收项，没有执行真实后端测试。</p>`,
    action(s,a) {if(a==='request' && !s.request) {s.request=s.owner; s.result=`读取 ${s.owner} 的历史中…`;} if(a==='switch') {s.owner=s.owner==='A'?'B':'A'; s.result='会话已切换，旧请求仍可能晚到';} if(a==='reply' && s.request) {s.result=s.request===s.owner?'归属匹配：更新当前历史':'归属不同：丢弃旧响应，当前历史不变'; s.request='';}},
  },
  wake: {
    hint: '开启偏好、切后台，或模拟系统拒绝。',
    init: () => ({enabled: false, visible: true, denied: false}),
    render: s => `${demoTitle('THIS DEVICE / SCREEN', '观看会话时保持常亮')}<label class="demo-option"><input id="wake-enabled" type="checkbox" ${s.enabled?'checked':''}>保持屏幕常亮</label><div class="metric">${s.enabled&&s.visible&&!s.denied?'☀':'☾'}</div>${demoStatus(!s.enabled?'偏好已关闭':!s.visible?'页面在后台，锁已释放':s.denied?'系统未允许，常亮没有生效':'会话可见，模拟常亮已生效',s.denied?'warn':'')}
      <div class="demo-controls">${demoButton('visibility',s.visible?'模拟切后台':'回到前台')}${demoButton('deny',s.denied?'恢复系统许可':'模拟省电模式拒绝')}</div><p class="demo-caption">仅为状态模拟，不会真的保持这台设备常亮。</p>`,
    action(s,a) {if(a==='visibility') s.visible=!s.visible; if(a==='deny') s.denied=!s.denied;},
    change(s,el) {if(el.id==='wake-enabled') {s.enabled=el.checked; return true;}},
  },
  updates: {
    hint: '查看跨版本摘要，模拟升级成功或回滚。',
    init: () => ({stage: 0, failed: false}),
    render: s => `${demoTitle('UPDATES / FICTIONAL RELEASES', s.failed?'已恢复旧版本':s.stage===3?'升级完成':'这次更新带来了什么')}<div class="demo-status muted">演示版本 A → C · 非真实发布</div><div class="bubble agent"><strong>版本 C · 新增</strong>聊天中的文件路径可以直接打开。<br><br><strong>版本 B · 修复</strong>重连时保留正在输入的草稿。</div>${demoStatus(s.failed?'启动未通过验证 · 回滚完成':['等待你确认','下载候选版本','重启并验证','当前运行版本 C'][s.stage],s.failed?'warn':'')}
      <div class="demo-controls">${demoButton('next',['开始模拟升级','下载完成','验证成功','已完成'][s.stage],true,s.stage===3||s.failed)}${demoButton('fail','模拟验证失败',false,s.stage!==2||s.failed)}</div><div class="bubble">保留的草稿：继续检查文件预览…</div><p class="demo-caption">复用现有升级状态与回滚，增加可信版本摘要。</p>`,
    action(s,a) {if(a==='next' && s.stage<3 && !s.failed) s.stage++; if(a==='fail' && s.stage===2) s.failed=true;},
  },
};

function completionToken(s) {
  const prefix=s.text.slice(0,s.caret);
  const match=prefix.match(/(?:^|\s)([@/$])([^\s]*)$/u);
  if(!match) return null;
  const start=prefix.length-match[1].length-match[2].length;
  let end=s.caret;
  while(end<s.text.length && !/\s/u.test(s.text[end])) end++;
  return {kind:match[1],start,end};
}
function renderSuggestions() {
  const target=document.querySelector('#suggestions');
  if(!target) return;
  const token=completionToken(demoState);
  const label=token?.kind==='@'?'src/app.ts · 当前工作区':token?.kind==='/'?'/review-mobile · 项目命令':'$audit-ui · 已验证 skill';
  target.innerHTML=token?`<div class="demo-row"><span>${label}</span>${demoButton('choose','插入',true)}</div>`:'<p class="demo-caption">把光标放到 @、/ 或 $ token 内查看候选。</p>';
}
function renderDemo() {
  document.querySelector('#demo').innerHTML=demos[demoId].render(demoState);
  document.querySelector('#demo-hint').textContent=demos[demoId].hint;
  demos[demoId].after?.();
}
function startDemo(id) {
  demoId=id;
  demoState=demos[id].init();
  renderDemo();
}
document.querySelector('#demo').addEventListener('click', e => {
  const button=e.target.closest('[data-action]');
  if(!button || button.disabled) return;
  const action=button.dataset.action;
  demos[demoId].action(demoState,action);
  renderDemo();
  document.querySelector(`#demo [data-action="${action}"]:not(:disabled)`)?.focus({preventScroll:true});
});
document.querySelector('#demo').addEventListener('input', e => demos[demoId].input?.(demoState,e.target));
document.querySelector('#demo').addEventListener('change', e => {
  const id=e.target.id;
  if(demos[demoId].change?.(demoState,e.target)) {renderDemo(); if(id) document.getElementById(id)?.focus({preventScroll:true});}
});
document.querySelector('#demo').addEventListener('keyup', e => {
  if(demoId==='completion' && e.target.id==='demo-text') {demoState.caret=e.target.selectionStart; renderSuggestions();}
});
document.querySelector('#demo').addEventListener('click', e => {
  if(demoId==='completion' && e.target.id==='demo-text') {demoState.caret=e.target.selectionStart; renderSuggestions();}
});
document.addEventListener('visibilitychange', () => {
  if(document.hidden && demoId==='secret') {demoState.value=''; demoState.result='页面隐藏，内容已清空'; renderDemo();}
});
