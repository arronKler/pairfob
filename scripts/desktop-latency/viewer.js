import { observeVideo } from './observer.js';
const el = id => document.getElementById(id);
const video = document.querySelector('video');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let active;
let latestTraces = [];

function close(s, message) {
  if (active !== s) return;
  active = null;
  clearTimeout(s.deadline);
  clearInterval(s.poll);
  if (s.channel.readyState === 'open') s.channel.send('stop');
  s.observer?.close();
  s.pc.close();
  video.srcObject = null;
  el('connect').disabled = el('mode').disabled = false;
  el('flip').disabled = el('batch').disabled = el('stop').disabled = true;
  el('state').value = message;
}

function updateControls(s) {
  const ready = s.color !== undefined && s.channel.readyState === 'open';
  el('flip').disabled = el('batch').disabled = !ready || s.pending !== undefined || s.batch;
}

function showTrace(row) {
  const ms = value => Number.isFinite(value) ? value.toFixed(1) : '–';
  const lag = row.videoRtp != null && row.sourceRtp != null
    ? ((row.videoRtp - row.sourceRtp) | 0) / 90 : undefined;
  el('trace').textContent = `第 ${row.id} 次 · 输入确认 RTT ${ms(row.ack)} ms · 主机调度 ${ms(row.schedule)} ms · 更新到采到变色 ${ms(row.capture)} ms · 硬编 ${ms(row.encode)} ms · 解码变色 ${ms(row.decoded)} ms · 两端变色帧时间戳差 ${ms(lag)} ms · 读像素 ${ms(row.readback)} ms`;
}

function complete(s, row, elapsed) {
  clearTimeout(s.deadline);
  row.elapsed = elapsed;
  s.pending = undefined;
  s.samples.push(elapsed);
  const sorted = [...s.samples].sort((a,b) => a-b);
  const q = p => sorted[Math.ceil(sorted.length*p)-1].toFixed(1);
  el('result').textContent = `播放器像素回显 · ${sorted.length} 次 · 最近 ${elapsed.toFixed(1)} ms · P50 ${q(.5)} ms · P95 ${q(.95)} ms`;
  showTrace(row);
  updateControls(s);
}

function flip(s) {
  if (active !== s || s.pending !== undefined || s.color === undefined ||
      s.channel.readyState !== 'open') return;
  s.pending = performance.now();
  s.traces.push({id: ++s.sequence, start: s.pending, light: !s.color});
  if (s.traces.length > 1000) s.traces.shift();
  el('export').disabled = false;
  updateControls(s);
  s.channel.send('flip');
  s.observer.flip();
  s.deadline = setTimeout(() => close(s, '3 秒内未检测到变色，本次失败。请重新连接。'), 3000);
}

async function stats(s) {
  const records = await s.pc.getStats();
  if (active !== s) return;
  for (const r of records.values()) {
    if (r.type !== 'inbound-rtp' || r.kind !== 'video') continue;
    const transport = records.get(r.transportId);
    const pair = transport && records.get(transport.selectedCandidatePairId);
    const type = id => records.get(id)?.candidateType || '未知';
    const path = pair ? `${records.get(pair.remoteCandidateId)?.protocol || ''} ${type(pair.localCandidateId)} ↔ ${type(pair.remoteCandidateId)}` : '待确认';
    const last = s.lastStats;
    s.lastStats = r;
    const emitted = last && r.jitterBufferEmittedCount - last.jitterBufferEmittedCount;
    const jitter = emitted > 0 ? ((r.jitterBufferDelay - last.jitterBufferDelay) * 1000 / emitted).toFixed(1) : '–';
    el('stats').textContent = `${r.frameWidth || '–'}×${r.frameHeight || '–'} · ${r.framesPerSecond ?? '–'} fps · 已解码 ${r.framesDecoded ?? '–'} 帧 · 丢帧 ${r.framesDropped ?? '–'} · 接收缓冲 ${jitter} ms · ICE ${path}`;
  }
}

async function connect() {
  if (active) return;
  if (!location.hash.slice(1)) throw Error('链接缺少配对令牌，请复制包含 # 后全部字符的完整链接');
  if (typeof RTCPeerConnection !== 'function') throw Error('浏览器未开放 WebRTC，请用系统浏览器打开 HTTPS 链接');
  const pc = new RTCPeerConnection({iceServers: []});
  const s = {pc, channel: pc.createDataChannel('probe'), samples: [], traces: [], sequence: 0};
  active = s;
  latestTraces = s.traces;
  el('export').disabled = true;
  el('trace').textContent = '';
  el('connect').disabled = el('mode').disabled = true;
  el('stop').disabled = false;
  el('result').textContent = el('stats').textContent = '';
  function stage(message, limit) {
    if (active !== s || s.color !== undefined) return;
    el('state').value = message;
    clearTimeout(s.deadline);
    s.deadline = setTimeout(() => close(s, message + ' 超时'), limit);
  }
  stage('1/4 正在收集直连地址', 12000);
  try {
    const {receiver} = pc.addTransceiver('video', {direction: 'recvonly'});
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    pc.ontrack = e => {video.srcObject = new MediaStream([e.track]);};
    s.channel.onopen = () => {if (active === s) {stage('4/4 直连成功，等待 Mac 视频首帧', 20000); updateControls(s);}};
    s.channel.onmessage = e => {
      if (active !== s) return;
      if (String(e.data).startsWith('error:')) return close(s, e.data);
      const [kind, id, stamp, queue, capture, encode] = String(e.data).split(' ');
      const row = s.traces.findLast(row => row.id === Number(id));
      if (!row) return;
      if (kind === 'ack') row.ack = performance.now() - row.start;
      if (kind === 'frame') Object.assign(row, {sourceRtp: +stamp, schedule: queue/1000,
        capture: capture/1000, encode: encode/1000, frameNotice: performance.now()-row.start});
      if (s.traces.at(-1) === row) showTrace(row);
    };
    s.channel.onclose = () => close(s, '连接已结束');
    pc.onconnectionstatechange = () => {
      if (['failed','disconnected'].includes(pc.connectionState)) close(s, `WebRTC ${pc.connectionState}（ICE ${pc.iceConnectionState}）`);
    };
    await pc.setLocalDescription(await pc.createOffer());
    const limit = performance.now() + 4000;
    while (active === s && pc.iceGatheringState !== 'complete' && performance.now() < limit) await wait(50);
    if (active !== s) return;
    stage('2/4 正在向 Mac 验证链接', 15000);
    const response = await fetch('/offer', {method: 'POST', headers: {
      Authorization: 'Bearer ' + location.hash.slice(1), 'Content-Type':'application/json'
    }, body: JSON.stringify({offer:pc.localDescription,fps:Number(el('mode').value)})});
    if (!response.ok) throw Error((await response.text()).trim());
    if (active !== s) return;
    stage('3/4 正在建立 WebRTC 直连（ICE / DTLS）', 25000);
    await pc.setRemoteDescription(await response.json());
    s.observer = observeVideo(video, s, {
      ready() {
        clearTimeout(s.deadline);
        el('state').value = '已收到测试窗画面';
        updateControls(s);
      },
      trace: showTrace,
      complete: (row, elapsed) => complete(s, row, elapsed)
    });
    s.poll = setInterval(() => stats(s).catch(() => {}), 1000);
  } catch (e) {close(s, String(e));}
}

el('connect').onclick = () => connect().catch(e => {el('state').value = String(e);});
el('stop').onclick = () => active && close(active, '已断开');
el('flip').addEventListener('pointerdown', e => {if (e.button === 0 && active) flip(active);});
el('flip').onclick = e => {if (e.detail === 0 && active) flip(active);};
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && !el('flip').disabled && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    flip(active);
  }
});
el('batch').onclick = async () => {
  const s = active;
  if (!s || s.batch) return;
  s.batch = true;
  updateControls(s);
  for (let i=0; i<30 && active===s; i++) {
    flip(s);
    while (active===s && s.pending!==undefined) await wait(10);
    await wait(120+Math.random()*160);
  }
  s.batch = false;
  if (active===s) updateControls(s);
};
window.addEventListener('pagehide', () => active && close(active, '已断开'));

el('export').onclick = () => {
  const blob = new Blob([JSON.stringify(latestTraces, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'desktop-latency-samples.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
