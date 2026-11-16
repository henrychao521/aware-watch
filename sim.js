// 察覺錶模擬器：介面與判斷規則照韌體 v0.7 重寫成 JavaScript（畫面 240×240，與真錶同座標）
// 洗手機率、姿勢夾角由「情境」產生，不是真實模型；規則（連續窗數、門檻、冷卻、信標靠近判斷）與韌體相同。
'use strict';
const cv = document.getElementById('watch'), g = cv.getContext('2d'); g.scale(2, 2);
const C = { bg: '#000', fg: '#fff', dim: '#8E8E93', cell: '#1C1C1E', cell2: '#333336', red: '#FA114F', green: '#9BE82A',
  cyan: '#00F0FF', orange: '#FF9F0A', blue: '#0A84FF', ok: '#30D158', body: '#E6E6E2', shade: '#B4B2AE', visor: '#0B0C10', blush: '#F25A90' };
const F = (px, w = 600) => `${w} ${px}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dimc = (hex, k = 0.32) => { const n = parseInt(hex.slice(1), 16); const f = c => Math.round(((n >> c) & 255) * k); return `rgb(${f(16)},${f(8)},${f(0)})`; };

// ---------- 模擬時間（可加速） ----------
let speed = 1, simMs = 0, lastReal = performance.now();
const now = () => simMs;
function clockStr(withSec) {
  const d = new Date(Date.now()); const p = n => String(n).padStart(2, '0');
  return withSec ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 事件紀錄 ----------
const logEl = $('log');
function logEv(type, tpl, a, b) {
  const line = `${clockStr(true)},${type},${tpl},${(+a).toFixed(1)},${(+b).toFixed(1)}`;
  logEl.textContent = line + '\n' + logEl.textContent.split('\n').slice(0, 80).join('\n');
}
logEl.textContent = '時間,事件,範本/地點,角度或秒數,轉動或機率\n';

// ---------- 情境：手腕動作 ----------
const ACTS = {
  rest:  { name: '靜止', gyr: 2, hw: 0.04, posture: null, hint: '手放著不動：洗手機率低、沒有姿勢。' },
  walk:  { name: '走路', gyr: 55, hw: 0.12, posture: null, hint: '走路擺手：轉動量大，偶爾洗手機率會跳高但很少連續兩窗。' },
  wash:  { name: '洗手', gyr: 120, hw: 0.95, posture: null, hint: '洗手搓揉：洗手機率高。登錄洗手台信標後，人要在洗手台旁才算。' },
  hair:  { name: '手摸頭髮', gyr: 22, hw: 0.06, posture: 'hair', hint: '手停在頭側小幅動作：可先在「教學」頁把它存成範本，之後相似就提醒。' },
  drink: { name: '喝水', gyr: 18, hw: 0.15, posture: 'drink', hint: '手到嘴邊但角度不同：和「手摸頭髮」範本夾角大，不會觸發。' },
};
let act = 'rest';
const actsEl = $('acts');
for (const k in ACTS) {
  const b = document.createElement('button'); b.textContent = ACTS[k].name; b.dataset.k = k;
  b.onclick = () => { act = k; [...actsEl.children].forEach(x => x.classList.toggle('on', x.dataset.k === k)); $('actHint').textContent = ACTS[k].hint; };
  actsEl.appendChild(b);
}
actsEl.children[0].click();
const ANG = { hair: { hair: 7, drink: 46 }, drink: { hair: 46, drink: 8 } };   // 範本姿勢 × 現在姿勢 → 夾角（度）

// ---------- 偵測狀態（規則同韌體） ----------
const cfg = { theta: 25, dwell: 5, cooldown: 30, hwThr: 0.9, hwLimit: 30, showCount: false };
const tpl = [null, null, null];          // {posture, name}
let hwProb = 0.04, hwAbove = 0, hwBelow = 0, hwActive = false, hwStart = 0, hwMax = 0, hwAlerted = false;
let lastAng = 180, lastTpl = -1, lastOk = false, okRun = 0, gyrMean = 2, lastAlert = -1e9;
let alerting = false, alertT0 = 0, alertTpl = -1, thanksUntil = 0;
let alertsToday = 0;
function hwDur() { return hwActive ? (now() - hwStart) / 1000 : 0; }
function startAlert(t, a, b) {
  alerting = true; alertT0 = now(); alertTpl = t; lastAlert = now(); alertsToday++;
  logEv('alert', t, a, b); if (navigator.vibrate) navigator.vibrate(300);
}
function busy() { return teach.phase || mazePlaying(); }
function onPostureWindow() {        // 每 0.5 秒
  const A = ACTS[act]; gyrMean = A.gyr * (0.8 + Math.random() * 0.4);
  let best = -1, bestAng = 180;
  tpl.forEach((t, i) => { if (!t) return; const a = A.posture ? ANG[t.posture][A.posture] : 80 + Math.random() * 20; if (a < bestAng) { bestAng = a; best = i; } });
  lastTpl = best; lastAng = best >= 0 ? bestAng + (Math.random() - 0.5) * 4 : 180;
  lastOk = best >= 0 && lastAng <= cfg.theta && gyrMean > 5 && gyrMean < 60;
  if (busy()) { okRun = 0; return; }
  okRun = lastOk ? okRun + 1 : 0;
  if (okRun >= cfg.dwell * 2 && !alerting && now() - lastAlert > cfg.cooldown * 1000) { okRun = 0; startAlert(best, lastAng, gyrMean); }
}
function onHwWindow() {             // 每 2.5 秒
  const A = ACTS[act];
  let target = A.hw; if (act === 'walk' && Math.random() < 0.15) target = 0.92;
  hwProb = clamp(target + (Math.random() - 0.5) * (act === 'wash' ? 0.08 : 0.1), 0, 1);
  const on = hwProb > cfg.hwThr && bcnSinkOk();
  hwAbove = on ? hwAbove + 1 : 0; hwBelow = on ? 0 : hwBelow + 1;
  if (!hwActive && hwAbove >= 2) { hwActive = true; hwStart = now() - 5000; hwMax = hwProb; hwAlerted = false; logEv('hw_start', -2, 0, hwProb * 100); }
  if (!hwActive) return;
  hwMax = Math.max(hwMax, hwProb);
  if (hwBelow >= 2) { logEv('hw_end', -2, hwDur(), hwMax * 100); hwActive = false; return; }
  if (!hwAlerted && !busy() && !alerting && hwDur() >= cfg.hwLimit && now() - lastAlert > cfg.cooldown * 1000) { hwAlerted = true; startAlert(-2, hwDur(), hwProb * 100); }
}

// ---------- 信標 ----------
const ROLE = ['洗手台', '門口', '爐子'], RCOL = [C.blue, C.green, C.orange];
const HOUSE = { w: 13, h: 9 };                     // 公尺
const BEACONS = [{ key: 'ib6E3B2A51-00010001', role: 0, x: 11.2, y: 0.9 }, { key: 'ib6E3B2A51-00010002', role: 1, x: 1.4, y: 7.6 },
                 { key: 'ib6E3B2A51-00010003', role: 2, x: 3.6, y: 0.9 }];
const PHONES = [{ key: 'm:5d:72:4b:95:03:3c', x: 6, y: 5 }, { key: 'm:78:ac:49:07:17:b5', x: 9, y: 7 }];
let person = { x: 6.5, y: 5.5 };
const reg = [];                                     // {key, role, ref, rssi, near, since}
function rssiAt(b) { const d = Math.max(0.15, Math.hypot(b.x - person.x, b.y - person.y)); return -59 - 20 * Math.log10(d) + (Math.random() - 0.5) * 4; }
function bcnTick() {                                // 每秒：平滑訊號＋靠近判斷（靠近 ≥ 參考−8，離開要再弱 5 dB）
  for (const r of reg) {
    const b = BEACONS.find(x => x.key === r.key); const s = rssiAt(b);
    r.rssi = r.rssi === undefined ? s : 0.6 * r.rssi + 0.4 * s;
    const thr = r.ref - 8, nearNow = r.near ? r.rssi >= thr - 5 : r.rssi >= thr;
    if (nearNow && !r.near) { r.near = true; r.since = now(); logEv('bcn_in', reg.indexOf(r), r.rssi, r.role); }
    else if (!nearNow && r.near) { r.near = false; logEv('bcn_out', reg.indexOf(r), (now() - r.since) / 1000, r.role); }
  }
  $('rssi').textContent = BEACONS.map(b => `${ROLE[b.role]} ${Math.round(rssiAt(b))} dBm`).join('、');
}
const bcnCount = role => reg.filter(r => r.role === role).length;
const bcnNear = role => reg.some(r => r.role === role && r.near);
const bcnSinkOk = () => bcnCount(0) === 0 || bcnNear(0);
const place = { step: 0, role: 0, t0: 0, cand: [], pick: 0, key: '', nearRssi: 0, sum: 0, n: 0, msg: '', msgUntil: 0 };
function placeSay(m) { place.msg = m; place.msgUntil = now() + 2000; }
function placeUpdate() {
  if (place.step === 1 && now() - place.t0 > 4000) {
    place.cand = BEACONS.map(b => ({ key: b.key, rssi: Math.round(rssiAt(b)) })).concat(PHONES.map(b => ({ key: b.key, rssi: Math.round(rssiAt(b)) })))
      .sort((a, b) => (b.rssi - (b.key[0] === 'm' ? 200 : 0)) - (a.rssi - (a.key[0] === 'm' ? 200 : 0)));
    place.step = 2; place.pick = 0;
  }
  if (place.step === 4) {
    const b = BEACONS.find(x => x.key === place.key); if (b) { place.sum += rssiAt(b); place.n++; }
    if (now() - place.t0 > 4000) { register(place.key, place.role, Math.round(place.sum / Math.max(1, place.n))); place.step = 0; placeSay('設定好了'); }
  }
}
function register(key, role, ref) {
  let r = reg.find(x => x.key === key);
  if (!r) { if (reg.length >= 6) { placeSay('最多 6 顆'); return; } r = { key }; reg.push(r); }
  Object.assign(r, { role, ref, rssi: undefined, near: false });
  logEv('bcn_add', reg.indexOf(r), ref, role);
}

// ---------- 教學 ----------
const teach = { phase: 0, slot: 0, t0: 0, got: 0 };
function teachUpdate() {
  if (teach.phase === 1 && now() - teach.t0 > 3000) { teach.phase = 2; teach.t0 = now(); teach.got = 0; }
  if (teach.phase === 2) {
    if (ACTS[act].posture) teach.got++;
    if (now() - teach.t0 > 10000) {
      const p = ACTS[act].posture;
      if (p && teach.got > 20) { tpl[teach.slot] = { posture: p, name: `動作${teach.slot + 1}` }; logEv('teach', teach.slot, 0, 0); }
      else logEv('teach_fail', teach.slot, 0, 0);
      teach.phase = 0;
    }
  }
}

// ---------- 寵物：機器人小圓 ----------
const pet = { full: 80, energy: 80, aff: 0, st: 'sit', t0: 0, dur: 3000, x: 120, tx: 120, left: false, msg: '', msgUntil: 0, hearts: [] };
let ball = null;                                    // {x, v, until}
function petSet(st, dur) { pet.st = st; pet.t0 = now(); pet.dur = dur; }
function petSay(m, ms = 1800) { pet.msg = m; pet.msgUntil = now() + ms; }
function petIdle() {
  const r = Math.random() * 100;
  if (r < 30) { pet.tx = Math.abs(pet.x - 120) > 6 ? 120 : 104 + Math.random() * 32; pet.left = pet.tx < pet.x; petSet('walk', 15000); }
  else if (r < 60) petSet('sit', 4000 + Math.random() * 5000);
  else if (r < 74) petSet('groom', 3200); else if (r < 84) petSet('stretch', 2400); else if (r < 92) petSet('yawn', 2400); else petSet('box', 5000);
}
function petUpdate(dt) {
  pet.full = Math.max(0, pet.full - dt * 100 / (12 * 3600)); 
  const el = now() - pet.t0;
  if (ball) {
    ball.v += tiltRight() * 500 * dt; ball.v *= Math.pow(0.6, dt); ball.x += ball.v * dt;
    if (ball.x < 44) { ball.x = 44; ball.v = Math.abs(ball.v) * 0.6; } if (ball.x > 196) { ball.x = 196; ball.v = -Math.abs(ball.v) * 0.6; }
    if (now() > ball.until && pet.st !== 'swat') { ball = null; pet.aff += 2; petSay('玩得好開心'); pet.tx = 120; petSet('walk', 15000); }
  }
  switch (pet.st) {
    case 'walk': { const d = pet.tx - pet.x, s = 26 * dt; if (Math.abs(d) <= s) { pet.x = pet.tx; petIdle(); } else pet.x += Math.sign(d) * s; break; }
    case 'chase': { if (!ball) { petIdle(); break; } const d = ball.x - pet.x; pet.left = d < 0; if (Math.abs(d) < 34) { petSet('swat', 560); break; } pet.x = clamp(pet.x + Math.sign(d) * 70 * dt, 76, 164); break; }
    case 'swat': if (el > pet.dur) { if (ball) ball.v = (pet.left ? -1 : 1) * (120 + Math.random() * 100); petSet('chase', 30000); } break;
    case 'eat': if (el > pet.dur) { pet.full = Math.min(100, pet.full + 35); pet.aff++; petSay('充飽了'); petIdle(); } break;
    case 'petted': if (el > pet.dur) petSet('rub', 1600); break;
    default: if (el > pet.dur) { if (ball) petSet('chase', 30000); else petIdle(); }
  }
  pet.hearts = pet.hearts.filter(h => now() - h.t0 < 1400); pet.hearts.forEach(h => { if (now() >= h.t0) h.y += h.vy * dt; });
}
function petTouch() { pet.aff++; petSet('petted', 1600); for (let i = 0; i < 3; i++) pet.hearts.push({ x: pet.x + (Math.random() - 0.5) * 68, y: 96 + Math.random() * 16, vy: -28 - Math.random() * 16, t0: now() + i * 150 }); }
function petFeed() { if (pet.full > 90) { petSet('full', 2200); petSay('電量滿了'); } else petSet('eat', 3200); }
function petPlay() { if (ball) { ball = null; pet.tx = 120; petSet('walk', 15000); return; } ball = { x: pet.x < 120 ? 180 : 60, v: 0, until: now() + 20000 }; petSet('chase', 30000); petSay('傾斜手腕讓球滾', 2500); }

function eye(x, y, e, t) {
  g.fillStyle = C.cyan; g.strokeStyle = C.cyan; g.lineCap = 'round';
  if (e === 'open') rr(x - 4, y - 6, 8, 12, 4, C.cyan);
  else if (e === 'blink') rr(x - 5, y - 1, 10, 3, 1, C.cyan);
  else if (e === 'happy') { g.lineWidth = 3; g.beginPath(); g.moveTo(x - 5, y + 2); g.lineTo(x, y - 3); g.lineTo(x + 5, y + 2); g.stroke(); }
  else if (e === 'line') { g.lineWidth = 3; g.beginPath(); g.moveTo(x - 5, y); g.lineTo(x + 5, y); g.stroke(); }
  else if (e === 'dizzy') { for (let k = 0; k < 14; k++) { const a = t / 90 + k * 0.55, r = 1 + k * 0.42; g.fillRect(x + r * Math.cos(a) - 1, y + r * Math.sin(a) - 1, 2, 2); } }
}
function bot(cx, floorY, st, el) {
  const t = now(), dir = pet.left ? -1 : 1, moving = st === 'walk' || st === 'chase';
  const hover = st === 'sleep' ? 4 + Math.sin(t / 900) : st === 'eat' ? 8 + Math.sin(t / 300) : 11 + (moving ? 2 : 3) * Math.sin(t / (moving ? 160 : 420));
  let ox = 0, oy = 0;
  if (st === 'rub') ox = 4 * Math.sin(t / 90); if (st === 'petted') oy = -3 * Math.abs(Math.sin(t / 120));
  if (st === 'dizzy') { const u = clamp(el / 600, 0, 1); oy = -104 * u * (1 - u); ox = 3 * Math.sin(t / 40); }
  const by = floorY - hover + oy, bx = cx + ox, lean = moving ? 3 * dir : 0, hx = bx + lean, hy = by - 53;
  g.fillStyle = '#18191b'; g.beginPath(); g.ellipse(cx, floorY + 3, 30 - hover, 5, 0, 0, 7); g.fill();
  if (st !== 'sleep') { g.fillStyle = dimc(C.cyan); g.beginPath(); g.arc(bx, by + 2, 3 + ((t / 120) & 1), 0, 7); g.fill(); }
  let aL = 1.9, aR = 1.2, armL = 14, armR = 14;
  if (st === 'stretch') { const u = clamp(el / 1200, 0, 1); aL = 1.9 - u * 3.2; aR = 1.2 + u * 3.2; }
  if (st === 'petted' || st === 'full') { aL = -2.4; aR = -0.7; } if (moving) { aL = 2.4; aR = 0.7; }
  if (st === 'swat') { const hit = (el / 140) & 1; if (dir > 0) { aR = -0.1; armR = hit ? 24 : 15; } else { aL = 3.2; armL = hit ? 24 : 15; } }
  g.strokeStyle = C.shade; g.lineWidth = 6; g.lineCap = 'round';
  for (const [sx, a, L] of [[bx - 19, aL, armL], [bx + 19, aR, armR]]) {
    const ex = sx + L * Math.cos(a), ey = by - 20 + L * Math.sin(a);
    g.beginPath(); g.moveTo(sx, by - 20); g.lineTo(ex, ey); g.stroke(); g.fillStyle = C.body; g.beginPath(); g.arc(ex, ey, 4, 0, 7); g.fill();
  }
  rr(bx - 19, by - 28, 38, 28, 13, C.shade); rr(bx - 19, by - 28, 38, 22, 11, C.body);
  const low = pet.full < 25, beat = Math.sin(t / (st === 'sleep' ? 900 : 300)) > 0;
  g.fillStyle = beat ? (low ? C.orange : C.cyan) : dimc(low ? C.orange : C.cyan); g.beginPath(); g.arc(bx, by - 15, 4, 0, 7); g.fill();
  const antH = st === 'box' || st === 'stretch' ? 18 : 12, ax = hx - lean, ay = hy - 23 - antH;
  g.strokeStyle = C.shade; g.lineWidth = 2.4; g.beginPath(); g.moveTo(hx, hy - 23); g.lineTo(ax, ay); g.stroke();
  g.fillStyle = st === 'sleep' ? dimc(C.green) : low ? C.orange : ((t / 700) % 4 < 1 ? C.body : C.green); g.beginPath(); g.arc(ax, ay, 4, 0, 7); g.fill();
  for (const sx of [-33, 33]) { g.fillStyle = C.shade; g.beginPath(); g.arc(hx + sx, hy, 5, 0, 7); g.fill(); }
  rr(hx - 32, hy - 23, 64, 46, 18, C.body); rr(hx - 25, hy - 15, 50, 30, 12, C.visor);
  let e = 'open', lx = moving ? 5 * dir : 3 * Math.sin(t / 2300);
  if (st === 'sleep') e = 'line'; else if (['petted', 'rub', 'full', 'eat'].includes(st)) e = 'happy'; else if (st === 'dizzy') e = 'dizzy';
  else if (st === 'yawn') e = 'line'; else if (t % 3700 < 140) e = 'blink';
  if (e !== 'open' && e !== 'blink') lx = 0;
  eye(hx + lx - 11, hy - 1, e, t); eye(hx + lx + 11, hy - 1, e, t);
  if (st === 'petted' || st === 'rub') { rr(hx - 22, hy + 6, 7, 3, 1, C.blush); rr(hx + 15, hy + 6, 7, 3, 1, C.blush); }
  if (e === 'happy') { g.strokeStyle = C.cyan; g.lineWidth = 2; g.beginPath(); g.arc(hx, hy + 3, 5, 0.5, Math.PI - 0.5); g.stroke(); }
  if (st === 'yawn') { g.fillStyle = C.cyan; g.beginPath(); g.arc(hx, hy + 7, 3 + ((el / 300) & 1), 0, 7); g.fill(); }
  if (st === 'dizzy') for (let k = 0; k < 3; k++) { const a = t / 200 + k * 2.1; g.fillStyle = C.orange; g.beginPath(); g.arc(hx + 30 * Math.cos(a), hy - 30 + 6 * Math.sin(a), 2, 0, 7); g.fill(); }
}
function heart(x, y, c) { const H = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...']; g.fillStyle = c; H.forEach((r, j) => [...r].forEach((ch, i) => { if (ch === 'X') g.fillRect(x + i * 2 - 7, y + j * 2, 2, 2); })); }

// ---------- 迷宮 ----------
let tilt = { x: 0, y: 0 };                          // g，右／上為正
const tiltRight = () => tilt.x, tiltUp = () => tilt.y;
const mz = { st: 'ready', lv: 1, N: 6, walls: null, bx: 0, by: 0, vx: 0, vy: 0, t0: 0, best: {} };
const mazePlaying = () => page === 2 && mz.st === 'play';
function mzGen() {
  const N = mz.N = Math.min(12, 5 + mz.lv); const H = [], V = [];      // H[y][x]：格子上方牆；V[y][x]：格子左方牆
  for (let y = 0; y <= N; y++) { H.push(Array(N).fill(true)); V.push(Array(N + 1).fill(true)); }
  const seen = new Set(['0,0']), st = [[0, 0]];
  while (st.length) {
    const [x, y] = st[st.length - 1]; const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy, dx, dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < N && b < N && !seen.has(a + ',' + b));
    if (!nb.length) { st.pop(); continue; }
    const [a, b, dx, dy] = nb[Math.floor(Math.random() * nb.length)];
    if (dx === 1) V[y][x + 1] = false; if (dx === -1) V[y][x] = false; if (dy === 1) H[y + 1][x] = false; if (dy === -1) H[y][x] = false;
    seen.add(a + ',' + b); st.push([a, b]);
  }
  mz.walls = { H, V }; const c = 168 / N; mz.bx = 36 + c / 2; mz.by = 36 + c / 2; mz.vx = mz.vy = 0;
}
function mzSegs() {
  const N = mz.N, c = 168 / N, s = [], { H, V } = mz.walls;
  for (let y = 0; y <= N; y++) for (let x = 0; x < N; x++) if (H[y][x]) s.push([36 + x * c, 36 + y * c, 36 + (x + 1) * c, 36 + y * c]);
  for (let y = 0; y < N; y++) for (let x = 0; x <= N; x++) if (V[y][x]) s.push([36 + x * c, 36 + y * c, 36 + x * c, 36 + (y + 1) * c]);
  return s;
}
function mzUpdate(dt) {
  if (mz.st !== 'play') return;
  const c = 168 / mz.N, r = c * 0.27, segs = mzSegs(), steps = 4;
  for (let k = 0; k < steps; k++) {
    const h = dt / steps;
    mz.vx += tiltRight() * 1100 * h; mz.vy -= tiltUp() * 1100 * h; const damp = Math.pow(0.35, h); mz.vx *= damp; mz.vy *= damp;
    const sp = Math.hypot(mz.vx, mz.vy); if (sp > 360) { mz.vx *= 360 / sp; mz.vy *= 360 / sp; }
    mz.bx += mz.vx * h; mz.by += mz.vy * h;
    for (const [x1, y1, x2, y2] of segs) {
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy; const u = clamp(((mz.bx - x1) * dx + (mz.by - y1) * dy) / L2, 0, 1);
      const px = x1 + u * dx, py = y1 + u * dy; let nx = mz.bx - px, ny = mz.by - py; const d = Math.hypot(nx, ny), lim = r + 1.6;
      if (d < lim && d > 1e-6) { nx /= d; ny /= d; mz.bx = px + nx * lim; mz.by = py + ny * lim; const vn = mz.vx * nx + mz.vy * ny; if (vn < 0) { mz.vx -= 1.35 * vn * nx; mz.vy -= 1.35 * vn * ny; } }
    }
  }
  const gx = 36 + (mz.N - 0.5) * c, gy = 36 + (mz.N - 0.5) * c;
  if (Math.hypot(mz.bx - gx, mz.by - gy) < c * 0.3) {
    const s = (now() - mz.t0) / 1000; const k = mz.N; if (!mz.best[k] || s < mz.best[k]) mz.best[k] = s;
    mz.st = 'win'; mz.winS = s; pet.aff++; logEv('maze_win', mz.lv, s, mz.N);
  }
}

// ---------- 繪圖工具 ----------
function rr(x, y, w, h, r, c) { g.fillStyle = c; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }
function txt(s, x, y, px, c, w = 600, al = 'center') { g.font = F(px, w); g.fillStyle = c; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(s, x, y); }
function pill(cx, cy, w, h, c) { rr(cx - w / 2, cy - h / 2, w, h, h / 2, c); }
function arc(cx, cy, r, w, a0, sweep, c) {   // 角度：0＝12 點、順時針
  if (sweep <= 0) return; g.strokeStyle = c; g.lineWidth = w; g.lineCap = 'round'; g.beginPath();
  g.arc(cx, cy, r, (a0 - 90) * Math.PI / 180, (a0 + Math.min(sweep, 359.9) - 90) * Math.PI / 180); g.stroke();
}
function ring(cx, cy, r, w, f, c) { arc(cx, cy, r, w, 0, 360, dimc(c)); arc(cx, cy, r, w, 0, clamp(f, 0, 1) * 360, c); }

// ---------- 頁面 ----------
const PAGES = ['時鐘', '小圓', '迷宮', '即時', '地點', '教學'];
let page = 0, slide = null;
function drawClock() {
  const d = new Date(); const wd = '日一二三四五六'[d.getDay()];
  txt(`週${wd} ${d.getMonth() + 1}月${d.getDate()}日`, 120, 50, 15, C.red);
  txt(clockStr(false), 116, 106, 68, C.fg, 700);
  ring(84, 172, 20, 5, 0.86, C.ok); txt('86', 84, 172, 15, C.fg);
  const watching = tpl.some(Boolean) || true;
  ring(156, 172, 20, 5, watching ? 1 : 0, C.cyan); txt(cfg.showCount ? String(alertsToday) : '開', 156, 172, 15, C.cyan);
  txt('長按記一筆', 120, 212, 15, '#424242');
}
function drawPet() {
  const t = now();
  txt(clockStr(false), 120, 24, 19, C.fg);
  arc(120, 120, 112, 6, 296, 52, dimc(C.orange)); arc(120, 120, 112, 6, 296 + 52 * (1 - pet.full / 100), 52 * pet.full / 100, C.orange);
  arc(120, 120, 112, 6, 12, 52, dimc(C.cyan)); arc(120, 120, 112, 6, 12, 52 * pet.energy / 100, C.cyan);
  if (t >= pet.msgUntil) { txt('電', 52, 52, 15, C.orange); txt('神', 188, 52, 15, C.cyan); }
  if (ball) { g.fillStyle = '#18191b'; g.beginPath(); g.ellipse(ball.x, 168, 9, 3, 0, 0, 7); g.fill(); g.fillStyle = C.red; g.beginPath(); g.arc(ball.x, 157, 9, 0, 7); g.fill();
    const a = ball.x / 9; g.strokeStyle = C.fg; g.lineWidth = 3; g.beginPath(); g.moveTo(ball.x - 8 * Math.cos(a), 157 - 8 * Math.sin(a)); g.lineTo(ball.x + 8 * Math.cos(a), 157 + 8 * Math.sin(a)); g.stroke(); }
  if (pet.st === 'eat') { rr(pet.x - 26, 164, 52, 8, 4, C.cell2); for (let k = 0; k < 3; k++) { const r = 6 + ((t / 30 + k * 10) % 30); g.strokeStyle = dimc(C.orange); g.lineWidth = 1; g.beginPath(); g.ellipse(pet.x, 164, r, r / 4 + 1, 0, 0, 7); g.stroke(); } }
  bot(pet.x, 166, pet.st, t - pet.t0);
  if (pet.full < 25 && pet.st !== 'eat' && t >= pet.msgUntil && (t / 600) % 3 >= 1) { g.strokeStyle = C.orange; g.lineWidth = 1.5; g.strokeRect(109, 42, 20, 12); g.fillStyle = C.orange; g.fillRect(129, 45, 3, 6); g.fillRect(111, 44, 3, 8); }
  pet.hearts.forEach(h => { if (t >= h.t0) heart(h.x, h.y, C.red); });
  if (t < pet.msgUntil) { g.font = F(15); const w = g.measureText(pet.msg).width + 20; pill(120, 66, w, 26, C.cell); txt(pet.msg, 120, 66, 15, C.fg); }
  pill(86, 188, 64, 26, C.cell); txt('充電', 86, 188, 15, C.orange); pill(154, 188, 64, 26, C.cell); txt(ball ? '收起' : '玩球', 154, 188, 15, C.green);
}
function drawMaze() {
  if (!mz.walls) mzGen();
  const N = mz.N, c = 168 / N;
  g.strokeStyle = '#d9d9de'; g.lineWidth = 3.2; g.lineCap = 'round';
  for (const [x1, y1, x2, y2] of mzSegs()) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  g.fillStyle = C.green; g.beginPath(); g.arc(36 + (N - 0.5) * c, 36 + (N - 0.5) * c, c * 0.3, 0, 7); g.fill();
  g.fillStyle = C.cyan; g.beginPath(); g.arc(mz.bx, mz.by, c * 0.27, 0, 7); g.fill();
  if (mz.st === 'ready') { pill(120, 120, 150, 54, 'rgba(28,28,30,.92)'); txt(`第 ${mz.lv} 關`, 120, 110, 19, C.fg); txt('點一下開始', 120, 132, 15, C.dim); }
  else if (mz.st === 'play') txt(((now() - mz.t0) / 1000).toFixed(1) + ' 秒', 120, 20, 15, C.fg);
  else { pill(120, 120, 170, 64, 'rgba(28,28,30,.92)'); txt(`過關 ${mz.winS.toFixed(1)} 秒`, 120, 108, 19, C.green); txt('點一下下一關', 120, 134, 15, C.dim); }
}
function drawLive() {
  const sim = lastTpl >= 0 ? clamp(1 - lastAng / 90, 0, 1) : 0, mot = clamp(gyrMean / 200, 0, 1);
  ring(120, 120, 104, 17, sim, C.red); ring(120, 120, 84, 17, hwProb, C.green); ring(120, 120, 64, 17, mot, C.cyan);
  txt(Math.round(sim * 100) + '%', 120, 96, 19, C.red); txt(Math.round(hwProb * 100) + '%', 120, 120, 19, C.green); txt(Math.round(gyrMean) + '°/s', 120, 144, 19, C.cyan);
}
const PL_Y = i => 78 + i * 44;
function drawPlace() {
  const t = now();
  if (place.step === 1) { txt('把錶靠近信標', 120, 92, 19, C.fg); txt(ROLE[place.role], 120, 122, 15, RCOL[place.role]); ring(120, 120, 112, 6, (t - place.t0) / 4000, RCOL[place.role]); return; }
  if (place.step === 2) {
    const c = place.cand[place.pick % place.cand.length];
    txt(ROLE[place.role], 120, 44, 15, RCOL[place.role]); pill(120, 96, 196, 52, C.cell);
    txt(c.key[0] === 'i' ? 'iBeacon ' + c.key.slice(2) : 'MAC ' + c.key.slice(2), 120, 88, 13, C.fg, 500);
    txt(`${c.rssi} dBm  ${place.pick % place.cand.length + 1}/${place.cand.length}`, 120, 108, 15, C.dim);
    pill(76, 160, 84, 40, C.ok); txt('登錄', 76, 160, 19, '#000'); pill(164, 160, 84, 40, C.cell2); txt('下一個', 164, 160, 19, C.fg); return;
  }
  if (place.step >= 3) {
    txt('站到平常', 120, 70, 19, C.fg); txt(`使用${ROLE[place.role]}的位置`, 120, 96, 19, C.fg);
    if (place.step === 4) { ring(120, 120, 112, 6, (t - place.t0) / 4000, RCOL[place.role]); txt('量測中…', 120, 150, 15, C.dim); }
    else { pill(76, 160, 84, 40, C.ok); txt('記錄', 76, 160, 19, '#000'); pill(164, 160, 84, 40, C.cell2); txt('略過', 164, 160, 19, C.fg); }
    return;
  }
  txt('地點', 120, 34, 19, C.fg);
  for (let r = 0; r < 3; r++) {
    const y = PL_Y(r), n = bcnCount(r), nr = bcnNear(r);
    pill(120, y, 184, 38, C.cell); g.fillStyle = !n ? '#424242' : nr ? RCOL[r] : dimc(RCOL[r]); g.beginPath(); g.arc(46, y, 6, 0, 7); g.fill();
    txt(ROLE[r], 62, y, 19, C.fg, 600, 'left'); txt(!n ? '點一下設定' : nr ? '在旁邊' : '不在', 194, y, 15, n ? (nr ? RCOL[r] : C.dim) : '#6b6b6b', 600, 'right');
  }
  if (t < place.msgUntil) { g.font = F(15); const w = g.measureText(place.msg).width + 20; pill(120, 208, w, 24, C.cell2); txt(place.msg, 120, 208, 15, C.fg); }
  else txt(bcnCount(0) ? '在洗手台旁才算洗手' : '長按一列＝刪除', 120, 208, 15, C.dim);
}
const TEACH_Y = i => 74 + i * 46;
function drawTeach() {
  const t = now();
  if (teach.phase === 1) { txt(String(3 - Math.floor((t - teach.t0) / 1000)), 120, 110, 68, C.orange, 700); txt('準備做出要提醒的動作', 120, 170, 15, C.dim); return; }
  if (teach.phase === 2) { ring(120, 120, 104, 12, (t - teach.t0) / 10000, C.red); txt('記錄中', 120, 104, 26, C.fg, 700); txt('持續做這個動作', 120, 136, 15, C.dim); return; }
  txt('教學', 120, 34, 19, C.green);
  for (let i = 0; i < 3; i++) {
    const y = TEACH_Y(i); pill(120, y, 184, 38, C.cell); g.fillStyle = C.cell2; g.beginPath(); g.arc(46, y, 10, 0, 7); g.fill(); txt(String(i + 1), 46, y, 13, C.dim);
    txt(tpl[i] ? tpl[i].name : '點一下開始教', 64, y, 15, tpl[i] ? C.fg : C.dim, 600, 'left'); if (tpl[i]) txt('已存', 194, y, 13, C.green, 600, 'right');
  }
  txt('長按一格＝刪除', 120, 214, 13, C.dim);
}
function drawAlert() {
  const t = now() - alertT0, pulse = t < 3000 ? 0.55 + 0.45 * Math.sin(t * 0.0126) : 0.35;
  arc(120, 120, 114, 8, 0, 360, dimc(C.orange, pulse));
  g.fillStyle = C.orange; g.beginPath(); g.arc(120, 46, 16, 0, 7); g.fill(); rr(118, 36, 4, 13, 2, C.fg); g.fillStyle = C.fg; g.beginPath(); g.arc(120, 54, 2, 0, 7); g.fill();
  txt('察覺一下', 120, 86, 26, C.fg, 700);
  txt(alertTpl >= 0 ? (tpl[alertTpl] ? tpl[alertTpl].name : '') : `洗手 ${Math.round(hwDur())} 秒`, 120, 114, 15, C.dim);
  pill(76, 160, 84, 44, C.ok); pill(164, 160, 84, 44, C.cell2); txt('是', 76, 160, 19, '#000'); txt('不是', 164, 160, 19, C.fg);
}
function drawThanks() { pet.st = pet.st; bot(120, 176, 'rub', 0); const rise = Math.max(0, 1500 - (thanksUntil - now())) / 60; heart(82, 96 - rise, C.red); heart(162, 88 - rise * 0.75, C.red); txt('收到了', 120, 48, 19, C.fg); }
function dots() {
  const n = PAGES.length; let y = 120 - ((n - 1) * 9 + 14) / 2;
  for (let i = 0; i < n; i++) { if (i === page) { rr(226, y, 5, 14, 2, C.fg); y += 18; } else { g.fillStyle = '#545458'; g.beginPath(); g.arc(228.5, y + 2, 2, 0, 7); g.fill(); y += 9; } }
}
function renderPage(p) {
  g.fillStyle = C.bg; g.fillRect(0, 0, 240, 240);
  [drawClock, drawPet, drawMaze, drawLive, drawPlace, drawTeach][p]();
  if (!(p === 5 && teach.phase)) dots();
}
function render() {
  g.save(); g.beginPath(); g.arc(120, 120, 120, 0, 7); g.clip();
  if (alerting) { g.fillStyle = C.bg; g.fillRect(0, 0, 240, 240); drawAlert(); }
  else if (now() < thanksUntil) { g.fillStyle = C.bg; g.fillRect(0, 0, 240, 240); drawThanks(); }
  else if (slide) {
    const k = clamp((performance.now() - slide.t0) / 240, 0, 1), e = 1 - Math.pow(1 - k, 3), off = e * 240 * slide.dir;
    g.save(); g.translate(0, -off); renderPage(slide.from); g.restore(); g.save(); g.translate(0, 240 * slide.dir - off); renderPage(page); g.restore();
    if (k >= 1) slide = null;
  } else renderPage(page);
  g.restore();
  $('pageName').textContent = alerting ? '提醒中' : `第 ${page + 1}／${PAGES.length} 頁：${PAGES[page]}`;
}

// ---------- 觸控 ----------
function gotoPage(p, dir = 1) { if (p === page) return; slide = { from: page, dir, t0: performance.now() }; page = p; place.step = 0; }
function onTap(x, y) {
  if (alerting) { if (y >= 120 && y <= 190) { const yes = x < 120; logEv(yes ? 'yes' : 'no', alertTpl, lastAng, gyrMean); alerting = false; pet.aff += 2; thanksUntil = now() + 1500; } return; }
  if (page === 1) {
    if (Math.abs(y - 188) <= 14) { if (Math.abs(x - 86) <= 34) return petFeed(); if (Math.abs(x - 154) <= 34) return petPlay(); }
    if (Math.abs(x - pet.x) < 46 && y > 56 && y < 172) return petTouch();
  }
  if (page === 2 && y <= 200) { if (mz.st === 'ready') { mz.st = 'play'; mz.t0 = now(); } else if (mz.st === 'win') { mz.lv++; mz.st = 'ready'; mzGen(); } return; }
  if (page === 4) {
    if (place.step === 1 || place.step === 4) return;
    if (place.step === 2) { if (Math.abs(y - 160) <= 22) { if (x < 120) { const c = place.cand[place.pick % place.cand.length]; place.key = c.key; place.nearRssi = c.rssi; place.step = 3; } else place.pick++; } return; }
    if (place.step === 3) { if (Math.abs(y - 160) <= 22) { if (x < 120) { place.sum = 0; place.n = 0; place.t0 = now(); place.step = 4; } else { register(place.key, place.role, place.nearRssi - 20); place.step = 0; placeSay('先用預設距離'); } } return; }
    for (let r = 0; r < 3; r++) if (Math.abs(y - PL_Y(r)) <= 19 && Math.abs(x - 120) <= 92) { place.role = r; place.step = 1; place.t0 = now(); return; }
  }
  if (page === 5 && !teach.phase) { for (let i = 0; i < 3; i++) if (Math.abs(y - TEACH_Y(i)) <= 21) { teach.slot = i; teach.phase = 1; teach.t0 = now(); return; } }
  if (y > 200 && !(page === 5 && teach.phase)) gotoPage((page + 1) % PAGES.length, 1);
}
function onLong(x, y) {
  if (alerting) return;
  if (page === 0) { logEv('missed', -1, lastAng, gyrMean); return; }
  if (page === 2) { mz.st = 'ready'; mzGen(); return; }
  if (page === 4) { if (place.step) { place.step = 0; return; } for (let r = 0; r < 3; r++) if (Math.abs(y - PL_Y(r)) <= 19 && bcnCount(r)) { for (let i = reg.length - 1; i >= 0; i--) if (reg[i].role === r) reg.splice(i, 1); placeSay('已刪除'); } return; }
  if (page === 5 && !teach.phase) for (let i = 0; i < 3; i++) if (Math.abs(y - TEACH_Y(i)) <= 21 && tpl[i]) tpl[i] = null;
}
function onSwipe(dy) { if (alerting || (page === 5 && teach.phase)) return; place.step = 0; if (dy < 0) gotoPage((page + 1) % PAGES.length, 1); else gotoPage((page + PAGES.length - 1) % PAGES.length, -1); }
let down = null;
cv.addEventListener('pointerdown', e => { const r = cv.getBoundingClientRect(); down = { x: (e.clientX - r.left) * 240 / r.width, y: (e.clientY - r.top) * 240 / r.height, t: performance.now(), long: false };
  down.timer = setTimeout(() => { if (down) { down.long = true; onLong(down.x, down.y); } }, 600); cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup', e => {
  if (!down) return; clearTimeout(down.timer); const r = cv.getBoundingClientRect(); const y = (e.clientY - r.top) * 240 / r.height, x = (e.clientX - r.left) * 240 / r.width;
  if (!down.long) { if (Math.abs(y - down.y) > 20 && Math.abs(y - down.y) > Math.abs(x - down.x)) onSwipe(y - down.y); else onTap(down.x, down.y); }
  down = null;
});
cv.addEventListener('pointermove', e => { if (!down) return; const r = cv.getBoundingClientRect(); if (Math.abs((e.clientY - r.top) * 240 / r.height - down.y) > 20) clearTimeout(down.timer); });
document.addEventListener('keydown', e => { if (e.key === 'ArrowDown') onSwipe(-1); if (e.key === 'ArrowUp') onSwipe(1); });
$('bBoot').onclick = () => { if (!alerting) gotoPage((page + 1) % PAGES.length, 1); };
$('bShake').onclick = () => { if (!['sleep', 'eat'].includes(pet.st)) petSet('dizzy', 1800); };
$('bFast').onclick = () => { speed = speed === 1 ? 10 : 1; $('bFast').textContent = `時間 ×${speed}`; $('bFast').classList.toggle('on', speed > 1); };
$('limit').oninput = () => { cfg.hwLimit = +$('limit').value; $('limitV').textContent = cfg.hwLimit + ' 秒'; }; $('limit').oninput();
$('showCount').onchange = () => { cfg.showCount = $('showCount').checked; };

// ---------- 傾斜輸入 ----------
function setTilt() { tilt.x = Math.sin(+$('tx').value * Math.PI / 180); tilt.y = Math.sin(+$('ty').value * Math.PI / 180); }
$('tx').oninput = $('ty').oninput = setTilt; $('bLevel').onclick = () => { $('tx').value = 0; $('ty').value = 0; setTilt(); };
$('bGyro').onclick = async () => {
  try { if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch (_) {}
  window.addEventListener('deviceorientation', e => { if (e.gamma == null) return; $('tx').value = clamp(e.gamma, -60, 60); $('ty').value = clamp(-e.beta, -60, 60); setTilt(); });
  $('bGyro').classList.add('on');
};

// ---------- 平面圖 ----------
const plan = $('plan'), pg = plan.getContext('2d'), PS = 80;     // 1 公尺＝80 px（畫布 1040×720）
function drawPlan() {
  pg.fillStyle = '#f6f4ef'; pg.fillRect(0, 0, 1040, 720);
  pg.strokeStyle = '#3e4643'; pg.lineWidth = 8; pg.strokeRect(4, 4, 1032, 712);
  pg.lineWidth = 6; const L = (a, b, c, d) => { pg.beginPath(); pg.moveTo(a * PS, b * PS); pg.lineTo(c * PS, d * PS); pg.stroke(); };
  L(0, 3, 2.4, 3); L(4.6, 0, 4.6, 3); L(9, 0, 9, 3); L(9, 3, 10.2, 3); L(11.6, 3, 13, 3); L(8.6, 5.4, 13, 5.4); L(8.6, 5.4, 8.6, 6.8); L(0, 6.4, 2.8, 6.4);
  pg.fillStyle = '#5f6a65'; pg.font = 'bold 26px "Noto Sans TC","PingFang TC",sans-serif';
  [['廚房', 0.4, 2.5], ['浴室', 9.3, 2.5], ['客廳', 5, 4.6], ['臥室', 9.2, 6.1], ['玄關', 0.4, 6.9]].forEach(([t, x, y]) => pg.fillText(t, x * PS, y * PS));
  for (const b of BEACONS) {
    const near = reg.find(r => r.key === b.key)?.near, col = RCOL[b.role];
    pg.fillStyle = col + '22'; pg.beginPath(); pg.arc(b.x * PS, b.y * PS, 1.5 * PS, 0, 7); pg.fill();
    pg.strokeStyle = col; pg.setLineDash([10, 8]); pg.lineWidth = 3; pg.stroke(); pg.setLineDash([]);
    pg.fillStyle = col; pg.fillRect(b.x * PS - 14, b.y * PS - 14, 28, 28); pg.fillStyle = '#fff'; pg.beginPath(); pg.arc(b.x * PS, b.y * PS, 5, 0, 7); pg.fill();
    if (near) { pg.strokeStyle = col; pg.lineWidth = 6; pg.beginPath(); pg.arc(b.x * PS, b.y * PS, 26, 0, 7); pg.stroke(); }
  }
  const px = person.x * PS, py = person.y * PS;
  pg.fillStyle = '#008A7C55'; pg.beginPath(); pg.arc(px, py + 8, 20, 0, 7); pg.fill(); pg.strokeStyle = '#008A7C'; pg.lineWidth = 3; pg.stroke();
  pg.fillStyle = '#008A7C'; pg.beginPath(); pg.arc(px, py - 14, 13, 0, 7); pg.fill();
  pg.fillStyle = '#111'; pg.beginPath(); pg.arc(px + 22, py + 14, 7, 0, 7); pg.fill(); pg.fillStyle = '#30D158'; pg.beginPath(); pg.arc(px + 22, py + 14, 3.5, 0, 7); pg.fill();
}
let dragging = false;
const planPos = e => { const r = plan.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width * HOUSE.w, 0.3, HOUSE.w - 0.3), y: clamp((e.clientY - r.top) / r.height * HOUSE.h, 0.3, HOUSE.h - 0.3) }; };
plan.addEventListener('pointerdown', e => { dragging = true; person = planPos(e); plan.setPointerCapture(e.pointerId); });
plan.addEventListener('pointermove', e => { if (dragging) person = planPos(e); });
plan.addEventListener('pointerup', () => { dragging = false; });

// ---------- 主迴圈 ----------
let accP = 0, accH = 0, accB = 0;
function loop(ts) {
  const real = Math.min(100, ts - lastReal); lastReal = ts; const dt = real * speed; simMs += dt;
  accP += dt; accH += dt; accB += dt;
  while (accP >= 500) { accP -= 500; onPostureWindow(); }
  while (accH >= 2500) { accH -= 2500; onHwWindow(); }
  while (accB >= 1000) { accB -= 1000; bcnTick(); }
  if (alerting && now() - alertT0 > 20000) { logEv('timeout', alertTpl, 0, 0); alerting = false; }
  teachUpdate(); placeUpdate(); petUpdate(dt / 1000); if (page === 2) mzUpdate(Math.min(dt, 50) / 1000);
  render(); drawPlan();
  requestAnimationFrame(loop);
}
mzGen(); setTilt(); requestAnimationFrame(loop);
