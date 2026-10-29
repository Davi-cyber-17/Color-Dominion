/* =====================================================================
   Color Dominion — HTML + CSS + JS puro
   - Modo Local : 1 a 4 humanos na mesma tela (tela dividida) + bots
   - Modo Online: salas (código de 5 letras) via WebRTC/PeerJS, até 16
   O anfitrião da sala roda a simulação; os demais enviam só a direção.
   ===================================================================== */
'use strict';

// ==== SIM START ======================================================
const MAX_PLAYERS = 16;
const DX = [0, 1, 0, -1];           // 0 cima, 1 direita, 2 baixo, 3 esquerda
const DY = [-1, 0, 1, 0];
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class Sim {
  constructor(cfg) {
    const N = (this.N = cfg.n);
    this.tickMs = cfg.tickMs;
    this.owner = new Uint8Array(N * N);       // dono de cada célula (0 = ninguém)
    this.trailOwner = new Uint8Array(N * N);  // dono do rastro em cada célula
    this.vis = new Uint8Array(N * N);
    this.stack = new Int32Array(N * N);
    this.counts = new Int32Array(MAX_PLAYERS + 1);
    this.changes = [];
    this.keepChanges = false;
    this.players = [null];
    this.deathLog = [];
    this.fx = [];
    this.tickNo = 0;
    this.running = false;
    this.ver = 1;
    this.now = 0;
    this.lastTick = 0;
    this.nextTick = 0;
    this.readyUntil = 0;
    cfg.entries.forEach((e, i) => {
      this.players.push({
        id: i + 1, name: e.name, color: i % 16, bot: !!e.bot, auto: !!e.auto,
        x: 0, y: 0, px: 0, py: 0, tx: 0, ty: 0, dir: 1, queue: [],
        alive: false, out: false, trail: [], ts: null, kills: 0,
        respawnAt: 0, want: false, plan: [], hx: 0, hy: 0, peak: 0, best: 0,
      });
    });
    for (let id = 1; id < this.players.length; id++) this.spawn(this.players[id]);
  }

  setOwner(i, o) {
    const old = this.owner[i];
    if (old === o) return;
    this.counts[old]--;
    this.counts[o]++;
    this.owner[i] = o;
    this.ver++;
    this.changes.push(i);
  }

  queueDir(id, d) {
    const p = this.players[id];
    if (!p || !p.alive) return;
    const last = p.queue.length ? p.queue[p.queue.length - 1] : p.dir;
    if (d === last || d === ((last + 2) & 3)) return;
    if (p.queue.length < 3) p.queue.push(d);
  }

  respawn(id) {
    const p = this.players[id];
    if (p && !p.alive) p.want = true;
  }

  spawn(p) {
    const N = this.N, own = this.owner, tr = this.trailOwner, ps = this.players;
    for (let attempt = 0; attempt < 400; attempt++) {
      const r = attempt < 300 && N >= 40 ? 2 : 1;
      const m = attempt < 200 ? 4 : 0;
      const lo = r + 3, hi = N - r - 4;
      if (hi <= lo) break;
      const x = rnd(lo, hi), y = rnd(lo, hi);
      let ok = true;
      for (let yy = y - r - m; yy <= y + r + m && ok; yy++) {
        for (let xx = x - r - m; xx <= x + r + m; xx++) {
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          const c = yy * N + xx;
          if (own[c] || tr[c]) { ok = false; break; }
        }
      }
      if (!ok) continue;
      for (const q of ps) {
        if (q && q !== p && q.alive && Math.abs(q.x - x) + Math.abs(q.y - y) < 8) { ok = false; break; }
      }
      if (!ok) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.setOwner((y + dy) * N + x + dx, p.id);
      p.x = p.px = p.hx = x; p.y = p.py = p.hy = y;
      p.alive = true; p.out = false; p.trail = []; p.ts = null; p.kills = 0;
      p.queue = []; p.plan = []; p.want = false; p.respawnAt = 0;
      const cx = N / 2 - x, cy = N / 2 - y;
      p.dir = Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 1 : 3) : (cy > 0 ? 2 : 0);
      return true;
    }
    return false;
  }

  /* ---------------- um passo da simulação ---------------- */
  step(now) {
    this.now = now;
    this.tickNo++;
    const N = this.N, ps = this.players, tr = this.trailOwner, own = this.owner;
    const act = [];

    for (let id = 1; id < ps.length; id++) {
      const p = ps[id];
      if (!p.alive) {
        if ((p.respawnAt && now >= p.respawnAt) || p.want) {
          if (this.spawn(p)) { p.want = false; p.respawnAt = 0; }
          else if (p.respawnAt) p.respawnAt = now + 700;
        }
        continue;
      }
      if (p.bot) this.ai(p);
      while (p.queue.length) {
        const d = p.queue.shift();
        if (d !== p.dir && d !== ((p.dir + 2) & 3)) { p.dir = d; break; }
      }
      p.px = p.x; p.py = p.y;
      p.tx = p.x + DX[p.dir]; p.ty = p.y + DY[p.dir];
      act.push(p);
    }

    // --- quem morre neste passo ---
    const dead = new Map();
    const mark = (v, k) => { if (!dead.has(v)) dead.set(v, k); };
    for (const p of act) {
      if (p.tx < 0 || p.ty < 0 || p.tx >= N || p.ty >= N) { mark(p.id, 0); continue; }
      const t = tr[p.ty * N + p.tx];
      if (t === p.id) mark(p.id, 0);          // bateu no próprio rastro
      else if (t) mark(t, p.id);              // cortou o rastro de outro
    }
    for (let i = 0; i < act.length; i++) {
      for (let j = i + 1; j < act.length; j++) {
        const a = act[i], b = act[j];
        const same = a.tx === b.tx && a.ty === b.ty;
        const swap = a.tx === b.x && a.ty === b.y && b.tx === a.x && b.ty === a.y;
        if (!same && !swap) continue;
        const ca = this.counts[a.id], cb = this.counts[b.id];  // cabeça a cabeça: o maior território vence
        if (ca > cb) mark(b.id, a.id);
        else if (cb > ca) mark(a.id, b.id);
        else { mark(a.id, b.id); mark(b.id, a.id); }
      }
    }
    for (const [v, k] of dead) this.kill(v, k);

    // --- movimento dos sobreviventes ---
    for (const p of act) {
      if (!p.alive) continue;
      p.x = p.tx; p.y = p.ty;
      const c = p.y * N + p.x;
      if (own[c] === p.id) {
        if (p.trail.length) this.capture(p);
        p.out = false;
      } else {
        if (!p.trail.length) p.ts = [p.px, p.py];
        p.trail.push(c);
        tr[c] = p.id;
        p.out = true;
      }
    }

    if (!this.keepChanges) this.changes.length = 0;
    this.lastTick = now;
  }

  kill(vid, kid) {
    const v = this.players[vid];
    if (!v || !v.alive) return;
    v.alive = false;
    this.deathLog.push({ x: v.x, y: v.y, color: v.color });
    if (this.deathLog.length > 60) this.deathLog.shift();
    const own = this.owner, tr = this.trailOwner, n = own.length;
    for (let i = 0; i < n; i++) if (own[i] === vid) this.setOwner(i, 0);
    for (const c of v.trail) if (tr[c] === vid) tr[c] = 0;
    v.trail = []; v.ts = null; v.out = false; v.queue.length = 0; v.plan.length = 0;
    if (kid && kid !== vid) { const k = this.players[kid]; if (k) k.kills++; }
    if (v.bot || v.auto) v.respawnAt = this.now + 2500;
  }

  // fecha o laço: o rastro vira território e tudo que ficou cercado também
  capture(p) {
    const N = this.N, own = this.owner, tr = this.trailOwner, id = p.id;
    for (const c of p.trail) { if (tr[c] === id) tr[c] = 0; this.setOwner(c, id); }
    p.trail = []; p.ts = null;

    const vis = this.vis, st = this.stack;
    vis.fill(0);
    let sp = 0;
    const push = (i) => { if (!vis[i] && own[i] !== id) { vis[i] = 1; st[sp++] = i; } };
    for (let x = 0; x < N; x++) { push(x); push((N - 1) * N + x); }
    for (let y = 0; y < N; y++) { push(y * N); push(y * N + N - 1); }
    while (sp) {
      const i = st[--sp], x = i % N, y = (i / N) | 0;
      if (x > 0) push(i - 1);
      if (x < N - 1) push(i + 1);
      if (y > 0) push(i - N);
      if (y < N - 1) push(i + N);
    }
    const victims = new Set();
    const n = N * N;
    for (let i = 0; i < n; i++) {
      if (!vis[i] && own[i] !== id) {
        const t = tr[i];
        if (t && t !== id) victims.add(t);   // rastro/cabeça de alguém ficou cercado
        this.setOwner(i, id);
      }
    }
    for (const v of victims) this.kill(v, id);
    for (let q = 1; q < this.players.length; q++) {
      const o = this.players[q];
      if (o.alive && o.id !== id && this.counts[q] === 0) this.kill(q, id);
    }
  }

  /* ---------------- bots ---------------- */
  ai(p) {
    const N = this.N, own = this.owner, tr = this.trailOwner, id = p.id;
    const safe = (d) => {
      const x = p.x + DX[d], y = p.y + DY[d];
      return x >= 0 && y >= 0 && x < N && y < N && tr[y * N + x] !== id;
    };
    const inside = own[p.y * N + p.x] === id;
    if (inside && p.plan.length && p.plan[0].ret) p.plan.length = 0;   // voltou pra casa
    if (inside && !p.plan.length) this.planLoop(p);
    // perigo: outro jogador perto da cabeça enquanto estou fora de casa -> volta
    if (!inside && p.plan.length) {
      for (const q of this.players) {
        if (q && q !== p && q.alive && Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= 5 && own[q.y * N + q.x] !== id) {
          p.plan.length = 0; this.nearestOwn(p); break;
        }
      }
    }
    if (!inside && !p.plan.length && (this.tickNo + p.id) % 3 === 0) this.nearestOwn(p);

    let d = p.dir;
    if (p.plan.length) {
      const st = p.plan[0];
      d = st.d;
      if (d === ((p.dir + 2) & 3) || !safe(d)) { p.plan.length = 0; d = this.pickDir(p, safe, inside); }
      else if (!st.ret && --st.n <= 0) p.plan.shift();
    } else d = this.pickDir(p, safe, inside);
    if (!safe(d)) d = this.pickDir(p, safe, inside);
    p.queue.length = 0;
    if (d !== p.dir) p.queue.push(d);
  }

  pickDir(p, safe, inside) {
    const opts = [];
    for (let d = 0; d < 4; d++) {
      if (d === ((p.dir + 2) & 3)) continue;
      if (safe(d)) opts.push(d);
    }
    if (!opts.length) return p.dir;
    if (inside) return opts[rnd(0, opts.length - 1)];
    let best = opts[0], bs = 1e9;
    for (const d of opts) {
      const s = Math.abs(p.x + DX[d] - p.hx) + Math.abs(p.y + DY[d] - p.hy) + Math.random() * 0.8;
      if (s < bs) { bs = s; best = d; }
    }
    return best;
  }

  nearestOwn(p) {
    const N = this.N, own = this.owner, id = p.id;
    for (let r = 1; r <= 30; r++) {
      let best = null, bd = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        const y = p.y + dy;
        if (y < 0 || y >= N) continue;
        const step = Math.abs(dy) === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += step) {
          const x = p.x + dx;
          if (x < 0 || x >= N) continue;
          if (own[y * N + x] === id) {
            const dd = Math.abs(dx) + Math.abs(dy);
            if (dd < bd) { bd = dd; best = [x, y]; }
          }
        }
      }
      if (best) { p.hx = best[0]; p.hy = best[1]; return; }
    }
  }

  // plano: sai do território, anda, vira, e volta pelo outro lado (retângulo)
  planLoop(p) {
    const N = this.N, own = this.owner, id = p.id;
    p.hx = p.x; p.hy = p.y;
    const cand = [];
    for (let d = 0; d < 4; d++) {
      if (d === ((p.dir + 2) & 3)) continue;
      let k = 0, x = p.x, y = p.y, bad = false;
      for (;;) {
        x += DX[d]; y += DY[d]; k++;
        if (x < 2 || y < 2 || x > N - 3 || y > N - 3) { bad = true; break; }
        if (own[y * N + x] !== id) break;
      }
      if (bad) continue;
      const room = DX[d] > 0 ? N - 3 - p.x : DX[d] < 0 ? p.x - 2 : DY[d] > 0 ? N - 3 - p.y : p.y - 2;
      if (room <= k + 1) continue;
      cand.push({ d, k, room });
    }
    if (!cand.length) { p.plan = []; return; }
    const c = cand[rnd(0, cand.length - 1)];
    const n1 = Math.min(c.k + rnd(2, 5), c.room);
    const ex = p.x + DX[c.d] * n1, ey = p.y + DY[c.d] * n1;
    const perps = [(c.d + 1) & 3, (c.d + 3) & 3].filter((d) => {
      const room = DX[d] > 0 ? N - 3 - ex : DX[d] < 0 ? ex - 2 : DY[d] > 0 ? N - 3 - ey : ey - 2;
      return room >= 3;
    });
    if (!perps.length) { p.plan = [{ d: c.d, n: n1 }]; return; }
    const pd = perps[rnd(0, perps.length - 1)];
    const room2 = DX[pd] > 0 ? N - 3 - ex : DX[pd] < 0 ? ex - 2 : DY[pd] > 0 ? N - 3 - ey : ey - 2;
    p.plan = [
      { d: c.d, n: n1 },
      { d: pd, n: Math.min(rnd(2, 5), room2) },
      { d: (c.d + 2) & 3, n: 1, ret: true },
    ];
  }

  /* ---------------- rede: estado enviado aos clientes ---------------- */
  makeTick() {
    const P = [];
    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      P.push([id, p.x, p.y, p.dir, p.alive ? 1 : 0, p.out ? 1 : 0, p.kills]);
    }
    const set = new Set(this.changes);
    const groups = new Map();
    for (const i of set) {
      const o = this.owner[i];
      let a = groups.get(o);
      if (!a) { a = []; groups.set(o, a); }
      a.push(i);
    }
    const c = [];
    for (const [o, a] of groups) { c.push(o, a.length); for (const i of a) c.push(i); }
    this.changes = [];
    return { t: 'tick', n: this.tickNo, p: P, c };
  }
}

function makeClientWorld(m, now) {
  const N = m.n;
  const w = {
    N, tickMs: m.tickMs, owner: new Uint8Array(N * N), counts: new Int32Array(MAX_PLAYERS + 1),
    players: [null], lastTick: now, deathLog: [], fx: [], tickNo: 0, readyUntil: now + 1500, ver: 1,
  };
  m.players.forEach((pl) => w.players.push({
    id: pl.id, name: pl.name, color: pl.color, bot: pl.bot, x: 0, y: 0, px: 0, py: 0, dir: 1,
    alive: false, out: false, trail: [], ts: null, kills: 0, peak: 0, best: 0,
  }));
  return w;
}

function applyTick(w, msg, now) {
  const N = w.N, c = msg.c;
  if (c.length) w.ver++;
  for (let i = 0; i < c.length;) {
    const o = c[i++], n = c[i++];
    for (let k = 0; k < n; k++) {
      const idx = c[i++], old = w.owner[idx];
      if (old !== o) { w.counts[old]--; w.counts[o]++; w.owner[idx] = o; }
    }
  }
  for (const r of msg.p) {
    const p = w.players[r[0]];
    if (!p) continue;
    const wasAlive = p.alive, ox = p.x, oy = p.y;
    p.px = p.x; p.py = p.y;
    p.x = r[1]; p.y = r[2]; p.dir = r[3]; p.alive = !!r[4]; p.out = !!r[5]; p.kills = r[6];
    if (p.alive && !wasAlive) { p.px = p.x; p.py = p.y; p.trail = []; p.ts = null; }
    else if (!p.alive) {
      if (wasAlive) w.deathLog.push({ x: ox, y: oy, color: p.color });
      p.trail = []; p.ts = null;
    } else if (p.out) {
      const idx = p.y * N + p.x;
      if (!p.trail.length) { p.ts = [ox, oy]; p.trail.push(idx); }
      else if (p.trail[p.trail.length - 1] !== idx) p.trail.push(idx);
    } else { p.trail = []; p.ts = null; }
  }
  w.tickNo = msg.n;
  w.lastTick = now;
}
// ==== SIM END ========================================================

/* =====================================================================
   CORES, NOMES E AUXILIARES VISUAIS
   ===================================================================== */
const PALETTE = [
  '#ffd400', '#00e5ff', '#ff2bd6', '#39ff6a', '#3d7bff', '#ff3b5c', '#b26bff', '#ff8a1f',
  '#19f5c2', '#d4ff2e', '#ff8fb8', '#aab8cc', '#c97b4a', '#6f6bff', '#f4f7ff', '#ffb3a0',
];
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(hex, to, t) {
  const a = hexRgb(hex), b = hexRgb(to);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
const COLORS = PALETTE.map((h) => ({
  main: h, side: mix(h, '#000000', 0.55), trail: mix(h, '#ffffff', 0.55), text: h,
}));
const BOT_NAMES = [
  "Joker's Grin", 'Vixen', 'Tan Stallion', 'Cujo', 'Hyper', 'Saber-RED', 'Street Squirrel', 'Call Back Queen',
  'ManMaker', 'CoB@lt', 'Blaze', 'Nebula', 'Pixelado', 'Tigrão', 'Faísca', 'Zeca', 'Mirage', 'Bruxa', 'Trovão', 'Neon',
];
const TICK_MS = 130;
const PEER_OPTS = {
  debug: 0,
  config: {
    iceCandidatePoolSize: 4,
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};
const gridSize = (total) => clamp(50 + total * 4, 56, 116);
const KEYSETS = [
  { KeyW: 0, KeyD: 1, KeyS: 2, KeyA: 3 },
  { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 },
  { KeyI: 0, KeyL: 1, KeyK: 2, KeyJ: 3 },
  { Numpad8: 0, Numpad6: 1, Numpad5: 2, Numpad2: 2, Numpad4: 3 },
];
const KEY_HINTS = [
  'Setas ou WASD (no celular: joystick ou deslizar)',
  'J1: WASD  ·  J2: Setas',
  'J1: WASD  ·  J2: Setas  ·  J3: I J K L',
  'J1: WASD · J2: Setas · J3: I J K L · J4: Numpad 8/4/5/6',
];

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* =====================================================================
   APLICAÇÃO (DOM, entrada, rede, desenho)
   ===================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;

  const app = {
    playing: false, mode: 'menu', sim: null, world: null, views: [], controls: [], keymaps: [],
    net: null, timer: 0, best: 0, paused: false,
  };
  try { app.best = parseFloat(localStorage.getItem('paperio_best')) || 0; } catch (e) { /* ignore */ }
  const saveBest = () => { try { localStorage.setItem('paperio_best', String(app.best)); } catch (e) { /* ignore */ } };
  const isCoarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  let touchSeen = isCoarse;   // o joystick aparece no primeiro toque (também em notebooks/tablets híbridos)
  const updateJoy = () => $('joy').classList.toggle('hidden', !(touchSeen && app.views.length === 1));

  /* ---------------- telas ---------------- */
  const SCREENS = ['screenMenu', 'screenLocal', 'screenOnline', 'screenLobby'];
  function show(id) { SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id)); }
  let toastT = 0;
  function toast(t) {
    const el = $('toast');
    el.textContent = t; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2800);
  }
  function getName() {
    const n = $('inName').value.trim().slice(0, 14) || 'Player';
    try { localStorage.setItem('paperio_name', n); } catch (e) { /* ignore */ }
    return n;
  }
  try { const sn = localStorage.getItem('paperio_name'); if (sn) $('inName').value = sn; } catch (e) { /* ignore */ }

  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
    $('onlineMsg').textContent = '';
    show(b.dataset.back);
  }));
  $('btnLocal').onclick = () => { show('screenLocal'); updLocal(); };
  $('btnOnline').onclick = () => { $('onlineMsg').textContent = ''; show('screenOnline'); };

  /* ---------------- configuração local ---------------- */
  let localHumans = 1;
  function updLocal() {
    const r = $('rngBots');
    r.max = 16 - localHumans;
    if (+r.value > +r.max) r.value = r.max;
    $('botsVal').textContent = r.value;
    $('totalVal').textContent = localHumans + +r.value;
    $('keysHint').textContent = KEY_HINTS[localHumans - 1];
    document.querySelectorAll('#segHumans button').forEach((b) => b.classList.toggle('on', +b.dataset.v === localHumans));
  }
  document.querySelectorAll('#segHumans button').forEach((b) => b.addEventListener('click', () => { localHumans = +b.dataset.v; updLocal(); }));
  $('rngBots').addEventListener('input', updLocal);

  $('btnLocalStart').onclick = () => {
    const name = getName();
    const bots = +$('rngBots').value;
    const names = shuffled(BOT_NAMES);
    const entries = [];
    for (let i = 0; i < localHumans; i++) {
      entries.push({ name: i === 0 ? name : `Jogador ${i + 1}`, bot: false, auto: localHumans > 1 });
    }
    for (let i = 0; i < bots; i++) entries.push({ name: names[i % names.length], bot: true });
    const sim = new Sim({ n: gridSize(entries.length), tickMs: TICK_MS, entries });
    app.sim = sim;
    const ctl = [];
    for (let i = 0; i < localHumans; i++) ctl.push({ id: i + 1 });
    beginGame(sim, ctl, 'local');
    startSimTimer();
  };

  /* ---------------- início/fim de partida ---------------- */
  function beginGame(world, controls, mode) {
    app.world = world;
    app.mode = mode;
    app.paused = false;
    app.controls = controls.map((c) => ({ id: c.id, last: -1 }));
    app.keymaps = controls.length === 1
      ? [Object.assign({}, KEYSETS[0], KEYSETS[1])]
      : KEYSETS.slice(0, controls.length);
    app.views = controls.map((c) => ({ focus: c.id, rect: { x: 0, y: 0, w: 1, h: 1 }, cs: 0, cx: 0, cy: 0, tx: 0, ty: 0, init: false }));
    show(null);
    document.body.classList.add('playing');
    $('deadBox').classList.add('hidden');
    $('pauseBox').classList.add('hidden');
    $('btnPause').classList.remove('hidden');
    updateJoy();
    world.readyUntil = performance.now() + 1500;
    world.lastTick = performance.now();
    app.playing = true;
    keepAwake();
    resize();
  }

  function stopGame() {
    clearInterval(app.timer);
    app.timer = 0;
    if (app.best) saveBest();
    app.sim = null; app.world = null; app.playing = false; app.mode = 'menu'; app.views = [];
    closeNet();
    document.body.classList.remove('playing');
    ['deadBox', 'pauseBox', 'btnPause', 'joy'].forEach((id) => $(id).classList.add('hidden'));
  }
  function goMenu() { stopGame(); show('screenMenu'); }

  function startSimTimer() {
    clearInterval(app.timer);
    const s = app.sim;
    s.running = true;
    s.nextTick = performance.now() + 1500;
    app.timer = setInterval(pump, 15);
  }
  function pump() {
    const s = app.sim;
    if (!s || !s.running) return;
    const now = performance.now();
    if (now < s.nextTick) return;
    let k = 0;
    while (now >= s.nextTick && k < 4) {
      s.step(s.nextTick);
      s.nextTick += s.tickMs;
      k++;
      if (app.mode === 'host') netBroadcast(s.makeTick());
    }
    if (now >= s.nextTick) s.nextTick = now + s.tickMs;
  }

  /* ---------------- entrada ---------------- */
  function sendDir(ci, d) {
    const c = app.controls[ci];
    if (!c || !app.playing) return;
    if (app.mode === 'client') {
      const n = app.net;
      if (n && n.conn && n.conn.open) n.conn.send({ t: 'dir', d });
    } else if (app.sim && app.sim.running) {
      app.sim.queueDir(c.id, d);
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!app.playing) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Escape') { togglePause(); e.preventDefault(); return; }
    for (let i = 0; i < app.keymaps.length; i++) {
      const d = app.keymaps[i][e.code];
      if (d !== undefined) {
        e.preventDefault();
        if (!e.repeat) sendDir(i, d);
        return;
      }
    }
  });

  // deslizar na tela (toque)
  let sw = null;
  const viewAt = (x, y) => {
    for (let i = 0; i < app.views.length; i++) {
      const r = app.views[i].rect;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
    }
    return 0;
  };
  const dirFrom = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !app.playing) return;
    if (!touchSeen) { touchSeen = true; updateJoy(); }
    sw = { id: e.pointerId, x: e.clientX, y: e.clientY, vi: viewAt(e.clientX, e.clientY) };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    if (Math.hypot(dx, dy) > 22) { sendDir(sw.vi, dirFrom(dx, dy)); sw.x = e.clientX; sw.y = e.clientY; }
  });
  const swEnd = (e) => { if (sw && e.pointerId === sw.id) sw = null; };
  canvas.addEventListener('pointerup', swEnd);
  canvas.addEventListener('pointercancel', swEnd);

  // joystick virtual
  const joy = $('joy'), knob = $('knob');
  let joyId = null, joyLast = -1;
  function joyMove(e) {
    const r = joy.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const max = r.width * 0.3, m = Math.hypot(dx, dy);
    if (m > max) { dx *= max / m; dy *= max / m; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    if (m > r.width * 0.12) {
      const d = dirFrom(dx, dy);
      if (d !== joyLast) { joyLast = d; sendDir(0, d); }
    }
  }
  joy.addEventListener('pointerdown', (e) => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); e.preventDefault(); });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyMove(e); });
  const joyEnd = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null; joyLast = -1;
    knob.style.transform = 'translate(-50%, -50%)';
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);

  /* ---------------- pausa / saída ---------------- */
  function togglePause() {
    if (!app.playing) return;
    const box = $('pauseBox');
    const open = box.classList.contains('hidden');
    box.classList.toggle('hidden', !open);
    if (app.mode === 'local' && app.sim) {
      app.sim.running = !open;
      if (!open) app.sim.nextTick = performance.now() + 400;
    }
    $('btnResume').textContent = 'Continuar';
  }
  $('btnPause').onclick = togglePause;
  $('btnResume').onclick = togglePause;
  $('btnQuit').onclick = goMenu;
  $('btnDeadMenu').onclick = goMenu;
  $('btnAgain').onclick = () => {
    const c = app.controls[0];
    if (!c) return;
    if (app.mode === 'client') { const n = app.net; if (n && n.conn && n.conn.open) n.conn.send({ t: 'respawn' }); }
    else if (app.sim) app.sim.respawn(c.id);
    $('deadBox').classList.add('hidden');
  };

  /* =====================================================================
     REDE (PeerJS / WebRTC) — salas
     ===================================================================== */
  const netMsg = (t, bad) => { const el = $('onlineMsg'); el.textContent = t; el.className = 'msg' + (bad ? ' bad' : ''); };
  const randomCode = () => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  };
  function closeNet() {
    const n = app.net;
    app.net = null;
    if (!n) return;
    clearInterval(n.pinger);
    try { if (n.conn) n.conn.close(); } catch (e) { /* ignore */ }
    try { (n.members || []).forEach((m) => { if (m.conn) m.conn.close(); }); } catch (e) { /* ignore */ }
    try { n.peer.destroy(); } catch (e) { /* ignore */ }
  }
  function netBroadcast(msg) {
    const n = app.net;
    if (!n || n.role !== 'host') return;
    for (const m of n.members) if (m.conn && m.conn.open) { try { m.conn.send(msg); } catch (e) { /* ignore */ } }
  }

  /* ---- lobby ---- */
  function renderLobby(names, isHost, code) {
    $('roomCode').textContent = code;
    $('lobbyCount').textContent = `${names.length} / 16 jogadores`;
    const ul = $('lobbyList');
    ul.innerHTML = '';
    names.forEach((nm, i) => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = PALETTE[i % 16];
      const sp = document.createElement('span'); sp.className = 'nm'; sp.textContent = nm;
      li.appendChild(dot); li.appendChild(sp);
      if (i === 0) { const b = document.createElement('span'); b.className = 'bd'; b.textContent = 'Anfitrião'; li.appendChild(b); }
      ul.appendChild(li);
    });
    $('hostCtl').classList.toggle('hidden', !isHost);
    $('waitMsg').classList.toggle('hidden', isHost);
    if (isHost) {
      const r = $('rngLobbyBots');
      r.max = 16 - names.length;
      if (+r.value > +r.max) r.value = r.max;
      $('lobbyBotsVal').textContent = r.value;
    }
  }
  $('rngLobbyBots').addEventListener('input', () => { $('lobbyBotsVal').textContent = $('rngLobbyBots').value; });
  $('btnCopy').onclick = () => {
    const code = $('roomCode').textContent;
    const done = () => toast('Código copiado: ' + code);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, () => toast('Código: ' + code));
    else toast('Código: ' + code);
  };
  function inviteUrl(code) {
    const base = location.protocol === 'file:' ? location.href.split('?')[0] : location.origin + location.pathname;
    return base + '?sala=' + code;
  }
  $('btnLink').onclick = () => {
    const url = inviteUrl($('roomCode').textContent);
    const done = () => toast('Link copiado! Envie para seus amigos.');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => toast(url));
    else if (navigator.share) navigator.share({ title: 'Paper.io', url }).catch(() => {});
    else toast(url);
  };
  $('btnLeave').onclick = () => { closeNet(); show('screenOnline'); };

  function broadcastLobby() {
    const n = app.net;
    if (!n || n.role !== 'host' || n.started) return;
    const names = n.members.map((m) => m.name);
    renderLobby(names, true, n.code);
    const msg = { t: 'lobby', code: n.code, members: names };
    for (const m of n.members) if (m.conn && m.conn.open) { try { m.conn.send(msg); } catch (e) { /* ignore */ } }
  }

  /* ---- anfitrião ---- */
  let peerLoading = null;
  function loadPeer() {
    if (typeof Peer !== 'undefined') return Promise.resolve();
    if (peerLoading) return peerLoading;
    peerLoading = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      sc.async = true;
      sc.onload = () => res();
      sc.onerror = () => { peerLoading = null; sc.remove(); rej(new Error('peerjs')); };
      document.head.appendChild(sc);
    });
    return peerLoading;
  }
  const NET_OFF = 'Biblioteca de rede indisponível. Verifique sua internet.';
  $('btnCreate').onclick = () => {
    netMsg('Criando sala…');
    loadPeer().then(createRoom, () => netMsg(NET_OFF, true));
  };
  function createRoom() {
    let tries = 0;
    const attempt = () => {
      const code = randomCode();
      const peer = new Peer('paperio-' + code, PEER_OPTS);
      const net = { role: 'host', peer, code, members: [{ name: getName(), conn: null, simId: 1 }], started: false, opened: false };
      peer.on('open', () => {
        net.opened = true;
        app.net = net;
        show('screenLobby');
        broadcastLobby();
      });
      peer.on('connection', (conn) => hostConn(net, conn));
      peer.on('disconnected', () => { if (net.opened && app.net === net) { try { peer.reconnect(); } catch (e) { /* ignore */ } } });
      peer.on('error', (err) => {
        if (!net.opened) {
          try { peer.destroy(); } catch (e) { /* ignore */ }
          if (err.type === 'unavailable-id' && ++tries < 6) attempt();
          else netMsg('Não foi possível criar a sala (' + err.type + ').', true);
        } else if (app.net === net) toast('Erro de rede: ' + err.type);
      });
    };
    attempt();
  }

  function hostConn(net, conn) {
    let member = null;
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'hello') {
        if (member) return;
        if (net.started) { conn.send({ t: 'err', m: 'A partida já começou.' }); setTimeout(() => conn.close(), 500); return; }
        if (net.members.length >= MAX_PLAYERS) { conn.send({ t: 'err', m: 'Sala cheia (16/16).' }); setTimeout(() => conn.close(), 500); return; }
        member = { name: String(d.name || 'Jogador').slice(0, 14), conn, simId: 0 };
        net.members.push(member);
        broadcastLobby();
      } else if (d.t === 'ping') {
        try { conn.send({ t: 'pong', ts: d.ts }); } catch (e) { /* ignore */ }
      } else if (member && net.started && app.sim) {
        if (d.t === 'dir' && member.simId && Number.isInteger(d.d) && d.d >= 0 && d.d < 4) app.sim.queueDir(member.simId, d.d);
        else if (d.t === 'respawn' && member.simId) app.sim.respawn(member.simId);
      }
    });
    const gone = () => {
      if (!member) return;
      const m = member;
      member = null;
      const i = net.members.indexOf(m);
      if (i < 0) return;
      if (net.started) {
        const p = app.sim && app.sim.players[m.simId];
        if (p) p.bot = true;          // um bot assume o lugar de quem saiu
        m.conn = null;
      } else {
        net.members.splice(i, 1);
        broadcastLobby();
      }
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  $('btnStart').onclick = () => {
    const net = app.net;
    if (!net || net.role !== 'host' || net.started) return;
    const humans = net.members.filter((m, i) => i === 0 || m.conn);
    const bots = Math.min(+$('rngLobbyBots').value, MAX_PLAYERS - humans.length);
    const names = shuffled(BOT_NAMES);
    const entries = humans.map((m) => ({ name: m.name, bot: false }));
    for (let i = 0; i < bots; i++) entries.push({ name: names[i % names.length], bot: true });
    const sim = new Sim({ n: gridSize(entries.length), tickMs: TICK_MS, entries });
    sim.keepChanges = true;
    humans.forEach((m, i) => { m.simId = i + 1; });
    net.started = true;
    app.sim = sim;
    const info = sim.players.slice(1).map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot }));
    humans.forEach((m) => {
      if (m.conn) m.conn.send({ t: 'start', n: sim.N, tickMs: sim.tickMs, you: m.simId, players: info });
    });
    netBroadcast(sim.makeTick());
    beginGame(sim, [{ id: 1 }], 'host');
    startSimTimer();
  };

  /* ---- cliente ---- */
  $('btnJoin').onclick = () => {
    const code = $('inCode').value.trim().toUpperCase();
    if (code.length < 4) { netMsg('Digite o código da sala.', true); return; }
    netMsg('Conectando…');
    loadPeer().then(() => joinRoom(code), () => netMsg(NET_OFF, true));
  };
  function joinRoom(code) {
    const peer = new Peer(undefined, PEER_OPTS);
    const net = { role: 'client', peer, conn: null, code, opened: false, world: null, lobbyShown: false };
    app.net = net;
    const fail = (m) => {
      if (app.net !== net) return;
      closeNet();
      netMsg(m, true);
      show('screenOnline');
    };
    peer.on('open', () => {
      const conn = peer.connect('paperio-' + code, { reliable: true, serialization: 'json' });
      net.conn = conn;
      const to = setTimeout(() => { if (!net.opened) fail('Sala não encontrada ou sem resposta.'); }, 12000);
      conn.on('open', () => {
        net.opened = true; clearTimeout(to);
        conn.send({ t: 'hello', name: getName() });
        net.pinger = setInterval(() => { if (conn.open) { try { conn.send({ t: 'ping', ts: performance.now() }); } catch (e) { /* ignore */ } } }, 2000);
      });
      conn.on('data', (d) => clientData(net, d, fail));
      conn.on('close', () => {
        if (app.net !== net) return;
        if (!net.opened) fail('Sala não encontrada.');
        else { toast('A sala foi encerrada.'); goMenu(); }
      });
      conn.on('error', () => fail('Erro de conexão.'));
    });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') fail('Sala não encontrada.');
      else if (app.net === net && !net.opened) fail('Erro de rede: ' + e.type);
    });
  }

  function clientData(net, d, fail) {
    if (!d || typeof d !== 'object' || app.net !== net) return;
    if (d.t === 'lobby') {
      renderLobby(d.members, false, d.code);
      if (!net.lobbyShown) { net.lobbyShown = true; show('screenLobby'); }
    } else if (d.t === 'err') {
      fail(d.m || 'Não foi possível entrar.');
    } else if (d.t === 'start') {
      net.world = makeClientWorld(d, performance.now());
      beginGame(net.world, [{ id: d.you }], 'client');
    } else if (d.t === 'tick') {
      if (net.world) applyTick(net.world, d, performance.now());
    } else if (d.t === 'pong') {
      const rtt = Math.round(performance.now() - d.ts);
      net.ping = net.ping == null ? rtt : Math.round(net.ping * 0.6 + rtt * 0.4);
    }
  }

  /* =====================================================================
     DESENHO
     ===================================================================== */
  // qualidade adaptativa: resolução do canvas e efeitos caem sozinhos se o aparelho estiver lento
  const Q = { scale: 1, low: false, maxDpr: isCoarse ? 1.5 : 2 };
  const MAX_PIXELS = 3e6;
  const INS = { t: 0, r: 0, b: 0, l: 0 };   // áreas seguras (notch)
  const safeEl = document.createElement('div');
  safeEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(safeEl);
  function readInsets() {
    const c = getComputedStyle(safeEl);
    INS.t = parseFloat(c.paddingTop) || 0; INS.r = parseFloat(c.paddingRight) || 0;
    INS.b = parseFloat(c.paddingBottom) || 0; INS.l = parseFloat(c.paddingLeft) || 0;
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
    dpr = Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, W * H)));
    dpr = Math.max(0.6, dpr * Q.scale);
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    readInsets();
    layoutViews();
  }
  let rzPending = false;
  const scheduleResize = () => {
    if (rzPending) return;
    rzPending = true;
    requestAnimationFrame(() => { rzPending = false; resize(); });
  };
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', () => { scheduleResize(); setTimeout(scheduleResize, 300); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  // bloqueia gestos do navegador (zoom/rolagem) durante o jogo
  document.addEventListener('touchmove', (e) => {
    if (app.playing && !(e.target.closest && e.target.closest('.overlay'))) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  let wakeLock = null;
  async function keepAwake() {
    try { if (navigator.wakeLock && app.playing) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  $('btnFull').onclick = () => {
    const el = document.documentElement;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else toast('Tela cheia não é suportada neste navegador.');
    } catch (e) { /* ignore */ }
  };

  function layoutViews() {
    const n = app.views.length;
    const set = (i, x, y, w, h) => { app.views[i].rect = { x, y, w, h }; };
    if (n === 1) set(0, 0, 0, W, H);
    else if (n === 2) {
      if (W >= H) { set(0, 0, 0, W / 2, H); set(1, W / 2, 0, W / 2, H); }
      else { set(0, 0, 0, W, H / 2); set(1, 0, H / 2, W, H / 2); }
    } else if (n === 3) { set(0, 0, 0, W / 2, H / 2); set(1, W / 2, 0, W / 2, H / 2); set(2, 0, H / 2, W, H / 2); }
    else if (n === 4) { set(0, 0, 0, W / 2, H / 2); set(1, W / 2, 0, W / 2, H / 2); set(2, 0, H / 2, W / 2, H / 2); set(3, W / 2, H / 2, W / 2, H / 2); }
  }

  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function txt(s, x, y, size, color, align, outline, title) {
    ctx.font = `${title ? 800 : 700} ${size}px ${title ? '"Orbitron","Rajdhani","Segoe UI",system-ui,sans-serif' : '"Rajdhani","Segoe UI",system-ui,sans-serif'}`;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    if (outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, size * 0.2);
      ctx.strokeStyle = outline;
      ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  const FONT_T = '"Orbitron","Rajdhani","Segoe UI",system-ui,sans-serif';
  const FONT_B = '"Rajdhani","Segoe UI",system-ui,sans-serif';

  function panel(x, y, w, h, r, stroke, fill) {
    ctx.beginPath(); rr(x, y, w, h, r);
    ctx.fillStyle = fill || 'rgba(6,14,32,.74)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = stroke || 'rgba(0,229,255,.38)'; ctx.stroke();
  }

  // posição suavizada de cada jogador (interpolação no host/local; seguimento suave no cliente online)
  function smoothPlayers(w, now, dt) {
    const client = app.mode === 'client';
    const a = clamp((now - w.lastTick) / w.tickMs, 0, 1);
    const f = 1 - Math.exp(-dt * 16);
    for (let i = 1; i < w.players.length; i++) {
      const p = w.players[i];
      if (client) {
        if (p.rx === undefined || !p.alive || Math.abs(p.x - p.rx) + Math.abs(p.y - p.ry) > 4) { p.rx = p.x; p.ry = p.y; }
        else { p.rx += (p.x - p.rx) * f; p.ry += (p.y - p.ry) * f; }
      } else {
        p.rx = p.px + (p.x - p.px) * a;
        p.ry = p.py + (p.y - p.py) * a;
      }
    }
  }

  // território em coordenadas do mundo: refeito só quando alguma célula muda de dono
  function buildTerritory(w) {
    const N = w.N, own = w.owner;
    const paths = new Array(MAX_PLAYERS + 1).fill(null);
    for (let y = 0; y < N; y++) {
      const row = y * N;
      let x = 0;
      while (x < N) {
        const o = own[row + x];
        if (!o) { x++; continue; }
        let e = x + 1;
        while (e < N && own[row + e] === o) e++;
        (paths[o] || (paths[o] = new Path2D())).rect(x, y, e - x, 1);
        x = e;
      }
    }
    w._paths = paths;
    w._pv = w.ver;
  }

  function drawView(v, w, now, dt) {
    const R = v.rect, N = w.N;
    const me = w.players[v.focus];
    const lo = Q.low;

    // câmera e zoom (afasta conforme o território cresce; leva em conta telas pequenas)
    if (me.alive) { v.tx = me.rx + 0.5; v.ty = me.ry + 0.5; }
    const small = Math.min(R.w, R.h) < 480;
    const visCells = (small ? 24 : 30) + Math.sqrt(Math.max(1, w.counts[me.id])) * 0.28;
    const targetCs = Math.sqrt(R.w * R.h) / visCells;
    if (!v.init) { v.init = true; v.cs = targetCs; v.cx = v.tx || N / 2; v.cy = v.ty || N / 2; }
    v.cs += (targetCs - v.cs) * (1 - Math.exp(-dt * 2.5));
    const k = 1 - Math.exp(-dt * 9);
    v.cx += (v.tx - v.cx) * k; v.cy += (v.ty - v.cy) * k;
    const cs = v.cs;
    const ox = R.x + R.w / 2 - v.cx * cs, oy = R.y + R.h / 2 - v.cy * cs;
    const depth = cs * 0.16;

    ctx.save();
    ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();

    // fundo e arena
    ctx.fillStyle = '#02050c';
    ctx.fillRect(R.x, R.y, R.w, R.h);
    const g = ctx.createLinearGradient(ox, oy, ox + N * cs, oy + N * cs);
    g.addColorStop(0, '#0b1a38'); g.addColorStop(0.5, '#08122a'); g.addColorStop(1, '#0a1530');
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, N * cs, N * cs);

    const x0 = clamp(Math.floor((R.x - ox) / cs), 0, N - 1), x1 = clamp(Math.floor((R.x + R.w - ox) / cs), 0, N - 1);
    const y0 = clamp(Math.floor((R.y - oy) / cs), 0, N - 1), y1 = clamp(Math.floor((R.y + R.h - oy) / cs) + 1, 0, N - 1);

    let grid = null;
    if (cs >= 8) {
      grid = new Path2D();
      for (let xx = x0; xx <= x1 + 1; xx++) { grid.moveTo(ox + xx * cs, oy + y0 * cs); grid.lineTo(ox + xx * cs, oy + (y1 + 1) * cs); }
      for (let yy = y0; yy <= y1 + 1; yy++) { grid.moveTo(ox + x0 * cs, oy + yy * cs); grid.lineTo(ox + (x1 + 1) * cs, oy + yy * cs); }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,229,255,.085)';
      ctx.stroke(grid);
      ctx.strokeStyle = 'rgba(0,229,255,.17)';
      ctx.beginPath();
      for (let xx = Math.ceil(x0 / 5) * 5; xx <= x1 + 1; xx += 5) { ctx.moveTo(ox + xx * cs, oy + y0 * cs); ctx.lineTo(ox + xx * cs, oy + (y1 + 1) * cs); }
      for (let yy = Math.ceil(y0 / 5) * 5; yy <= y1 + 1; yy += 5) { ctx.moveTo(ox + x0 * cs, oy + yy * cs); ctx.lineTo(ox + (x1 + 1) * cs, oy + yy * cs); }
      ctx.stroke();
    }

    // territórios: lateral escura (profundidade) + topo neon — um caminho por jogador, sem sombras
    if (w._pv !== w.ver || !w._paths) buildTerritory(w);
    const paths = w._paths;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(cs, cs);
    if (!lo) {
      ctx.save();
      ctx.translate(0, depth / cs);
      for (let o = 1; o <= MAX_PLAYERS; o++) {
        if (!paths[o] || !w.players[o]) continue;
        ctx.fillStyle = COLORS[w.players[o].color].side;
        ctx.fill(paths[o]);
      }
      ctx.restore();
    }
    for (let o = 1; o <= MAX_PLAYERS; o++) {
      if (!paths[o] || !w.players[o]) continue;
      ctx.fillStyle = COLORS[w.players[o].color].main;
      ctx.fill(paths[o]);
    }
    ctx.restore();
    if (grid && !lo && cs >= 10) {   // textura de blocos por cima dos territórios
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.10)';
      ctx.stroke(grid);
    }

    // parede da arena (neon, brilho simulado sem blur)
    ctx.lineJoin = 'miter';
    if (!lo) {
      ctx.strokeStyle = 'rgba(0,229,255,.22)';
      ctx.lineWidth = Math.max(6, cs * 0.5);
      ctx.strokeRect(ox, oy, N * cs, N * cs);
    }
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = Math.max(2, cs * 0.16);
    ctx.strokeRect(ox, oy, N * cs, N * cs);

    // rastros (linha de energia)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const cxy = (c) => [ox + ((c % N) + 0.5) * cs, oy + (((c / N) | 0) + 0.5) * cs];
    for (let id = 1; id < w.players.length; id++) {
      const p = w.players[id];
      if (!p.alive || !p.out || !p.trail.length) continue;
      const col = COLORS[p.color];
      const path = new Path2D();
      let first = true;
      const add = (qx, qy) => { if (first) { path.moveTo(qx, qy); first = false; } else path.lineTo(qx, qy); };
      if (p.ts) add(ox + (p.ts[0] + 0.5) * cs, oy + (p.ts[1] + 0.5) * cs);
      for (let i = 0; i < p.trail.length - 1; i++) { const q = cxy(p.trail[i]); add(q[0], q[1]); }
      add(ox + (p.rx + 0.5) * cs, oy + (p.ry + 0.5) * cs);
      ctx.lineWidth = cs * 0.4;
      ctx.strokeStyle = col.main; ctx.globalAlpha = lo ? 0.5 : 0.55;
      ctx.stroke(path);
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = Math.max(1.5, cs * 0.11); ctx.strokeStyle = col.trail;
      ctx.stroke(path);
      ctx.globalAlpha = 1;
    }

    // cabeças (cubos holográficos) e nomes
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    for (let id = 1; id < w.players.length; id++) {
      const p = w.players[id];
      if (!p.alive) continue;
      const hx = ox + (p.rx + 0.5) * cs, hy = oy + (p.ry + 0.5) * cs;
      if (hx < R.x - cs * 3 || hx > R.x + R.w + cs * 3 || hy < R.y - cs * 3 || hy > R.y + R.h + cs * 3) continue;
      const col = COLORS[p.color], s = cs * 0.76;
      if (p === me) {
        ctx.strokeStyle = col.main; ctx.globalAlpha = 0.25 + 0.35 * pulse; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(hx, hy, cs * (0.85 + 0.2 * pulse), 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (!lo) {   // halo no lugar do shadowBlur
        ctx.globalAlpha = 0.22; ctx.fillStyle = col.main;
        ctx.beginPath(); ctx.arc(hx, hy, s * 0.95, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col.side; ctx.beginPath(); rr(hx - s / 2, hy - s / 2 + depth, s, s, s * 0.2); ctx.fill();
      ctx.fillStyle = col.main; ctx.beginPath(); rr(hx - s / 2, hy - s / 2, s, s, s * 0.2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); rr(hx - s * 0.34, hy - s * 0.36, s * 0.46, s * 0.16, s * 0.06); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.beginPath(); rr(hx - s / 2, hy - s / 2, s, s, s * 0.2); ctx.stroke();
      txt(p.name, hx, hy - s * 0.95, Math.max(10, cs * 0.34), '#fff', 'center', 'rgba(0,0,0,.75)', true);
    }

    // partículas (aditivas)
    if (w.fx.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const f of w.fx) {
        ctx.globalAlpha = clamp(f.life, 0, 1);
        ctx.fillStyle = COLORS[f.c].main;
        const sz = cs * 0.24 * (0.5 + f.life);
        ctx.fillRect(ox + f.x * cs - sz / 2, oy + f.y * cs - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
  }

  const nameCache = new Map();
  function fitName(name, size, maxW) {
    const key = name + '|' + size.toFixed(1) + '|' + Math.round(maxW);
    let r = nameCache.get(key);
    if (r !== undefined) return r;
    ctx.font = `700 ${size}px ${FONT_B}`;
    r = name;
    while (r.length > 3 && ctx.measureText(r).width > maxW) r = r.slice(0, -2);
    if (nameCache.size > 300) nameCache.clear();
    nameCache.set(key, r);
    return r;
  }

  function drawHUD(vi, v, w, me, order) {
    const R = v.rect;
    const s = clamp(Math.min(R.w, R.h) / 560, 0.68, 1.25);
    const m = 10 * s;
    // respeita o notch nas bordas da tela
    const iL = R.x <= 1 ? INS.l : 0, iR = R.x + R.w >= W - 1 ? INS.r : 0, iT = R.y <= 1 ? INS.t : 0;
    const usable = R.w - iL - iR;
    const stacked = usable < 390 * s;   // tela estreita: placar fica embaixo do painel de status
    const pct = (w.counts[me.id] / (w.N * w.N)) * 100;
    const best = vi === 0 ? app.best : Math.max(me.best || 0, me.peak || 0);
    const col = COLORS[me.color];
    ctx.save();
    ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();

    // painel de status
    const px = R.x + iL + m, py = R.y + iT + m;
    const pw = Math.min(196 * s, usable - 2 * m), ph = 82 * s;
    panel(px, py, pw, ph, 12 * s, 'rgba(0,229,255,.4)');
    const bx = px + 10 * s, bw = pw - 20 * s, bh = 14 * s, by = py + 12 * s;
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); rr(bx, by, bw, bh, bh / 2); ctx.fill();
    const fw = Math.max(bh, bw * clamp(pct / 45, 0, 1));
    ctx.fillStyle = col.main;
    ctx.beginPath(); rr(bx, by, fw, bh, bh / 2); ctx.fill();
    txt(pct.toFixed(2) + '%', bx, by + bh + 14 * s, 16 * s, '#fff', 'left', 'rgba(0,0,0,.6)', true);
    txt('MELHOR ' + best.toFixed(2) + '%', bx + bw, by + bh + 14 * s, 11 * s, '#7e9bb8', 'right');
    const rank = order.indexOf(me) + 1;
    txt('💀 ×' + me.kills, bx, py + ph - 14 * s, 14 * s, '#ffd400', 'left');
    if (rank) txt('#' + rank + '/' + order.length, bx + bw, py + ph - 14 * s, 12 * s, '#00e5ff', 'right', null, true);

    // pontuação
    const score = Math.round(w.counts[me.id] * 10 + me.kills * 500);
    const sh = 38 * s;
    let sx, sy, sw;
    if (stacked) { sw = pw; sx = px; sy = py + ph + 6 * s; }
    else { sw = 150 * s; sx = R.x + R.w - iR - m - sw; sy = py; }
    panel(sx, sy, sw, sh, 10 * s, 'rgba(255,212,0,.45)');
    txt(String(score), sx + sw - 12 * s, sy + sh / 2 + 1, 20 * s, '#ffd400', 'right', null, true);

    // conexão (online)
    if (vi === 0 && (app.mode === 'client' || app.mode === 'host') && app.net) {
      const n = app.net;
      let label, c;
      if (app.mode === 'host') { label = 'ANFITRIÃO · ' + (n.members.filter((mm, i) => i === 0 || mm.conn).length) + ' online'; c = '#7cff6b'; }
      else if (n.ping != null) { label = n.ping + ' ms'; c = n.ping < 90 ? '#7cff6b' : n.ping < 180 ? '#ffd400' : '#ff3b5c'; }
      else { label = '…'; c = '#7e9bb8'; }
      const cw = (label.length * 7.4 + 30) * s, chh = 24 * s;
      const cx = px, cy = (stacked ? sy + sh : py + ph) + 6 * s;
      panel(cx, cy, cw, chh, 8 * s, 'rgba(255,255,255,.18)');
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(cx + 12 * s, cy + chh / 2, 3.5 * s, 0, 6.2832); ctx.fill();
      txt(label, cx + 22 * s, cy + chh / 2 + 0.5, 11 * s, '#cfe9ff', 'left', null, true);
    }

    // ranking (só quando há uma tela e ela é larga o bastante)
    if (app.views.length === 1 && !stacked) {
      const n = R.w > 700 && R.h > 420 ? 5 : 3;
      const rw = Math.min(236 * s, R.w * 0.5), rh = 28 * s;
      const x = R.x + R.w - iR - m - rw;
      let y = sy + sh + m;
      const row = (p, r) => {
        const c = COLORS[p.color];
        const pp = (w.counts[p.id] / (w.N * w.N)) * 100;
        panel(x, y, rw, rh, 8 * s, p === me ? c.main : 'rgba(255,255,255,.12)');
        ctx.fillStyle = c.main;
        ctx.beginPath(); rr(x + 5 * s, y + 5 * s, 4 * s, rh - 10 * s, 2 * s); ctx.fill();
        txt(String(r), x + 18 * s, y + rh / 2 + 1, 12 * s, '#7e9bb8', 'center', null, true);
        txt(pp.toFixed(1) + '%', x + 30 * s, y + rh / 2 + 1, 11 * s, c.main, 'left', null, true);
        txt(fitName(p.name, 14 * s, rw - 80 * s), x + 74 * s, y + rh / 2 + 1, 14 * s, '#fff', 'left');
        y += rh + 6 * s;
      };
      for (let i = 0; i < Math.min(n, order.length); i++) row(order[i], i + 1);
      const mi = order.indexOf(me);
      if (mi >= n) row(me, mi + 1);
    }
    ctx.restore();
  }

  function updateFx(w, dt) {
    while (w.deathLog.length) {
      const d = w.deathLog.pop();
      const cnt = Q.low ? 10 : 24;
      for (let i = 0; i < cnt && w.fx.length < 400; i++) {
        w.fx.push({ x: d.x + 0.5, y: d.y + 0.5, vx: (Math.random() - 0.5) * 11, vy: (Math.random() - 0.5) * 11, life: 1, c: d.color });
      }
    }
    for (let i = w.fx.length - 1; i >= 0; i--) {
      const f = w.fx[i];
      f.life -= dt * 1.5;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.vx *= 0.96; f.vy *= 0.96;
      if (f.life <= 0) w.fx.splice(i, 1);
    }
  }

  function showDead(me) {
    const w = app.world;
    app.best = Math.max(app.best, me.peak || 0);
    saveBest();
    $('stPct').textContent = (me.peak || 0).toFixed(2) + '%';
    $('stKills').textContent = me.kills;
    $('stBest').textContent = app.best.toFixed(2) + '%';
    $('deadBox').classList.remove('hidden');
    return w;
  }

  let lastT = performance.now();
  let perfAvg = 16, perfCool = 120;
  // se a média de quadros ficar lenta, reduz a resolução e depois os efeitos
  function adaptQuality(raw) {
    perfAvg += (Math.min(raw, 120) - perfAvg) * 0.05;
    if (perfCool > 0) { perfCool--; return; }
    if (perfAvg > 28) {
      if (Q.scale > 0.7) { Q.scale = Math.max(0.7, Q.scale - 0.15); resize(); }
      else if (!Q.low) Q.low = true;
      perfCool = 150; perfAvg = 20;
    }
  }
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const raw = now - lastT;
    lastT = now;
    const dt = Math.min(0.05, raw / 1000);
    if (!app.playing || !app.world) { perfCool = 120; return; }
    const w = app.world;
    adaptQuality(raw);
    ctx.clearRect(0, 0, W, H);
    updateFx(w, dt);
    smoothPlayers(w, now, dt);

    // ranking global
    const order = [];
    for (let i = 1; i < w.players.length; i++) if (w.players[i].alive) order.push(w.players[i]);
    order.sort((p, q) => w.counts[q.id] - w.counts[p.id]);

    // estatísticas de quem está sendo controlado
    app.views.forEach((v) => {
      const me = w.players[v.focus];
      const pct = (w.counts[me.id] / (w.N * w.N)) * 100;
      if (me.alive) {
        if (me._was === false) me.peak = 0;
        me.peak = Math.max(me.peak || 0, pct);
        me.best = Math.max(me.best || 0, me.peak);
        if (v === app.views[0] && pct > app.best) app.best = pct;
      }
      me._was = me.alive;
    });

    app.views.forEach((v, i) => {
      drawView(v, w, now, dt);
      const me = w.players[v.focus];
      drawHUD(i, v, w, me, order);
      if (!me.alive) {
        const R = v.rect;
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.fillRect(R.x, R.y, R.w, R.h);
        if (app.views.length > 1) txt('💀 Renascendo…', R.x + R.w / 2, R.y + R.h / 2, clamp(Math.min(R.w, R.h) / 14, 14, 26), '#12313a', 'center', 'rgba(255,255,255,.8)');
      }
    });

    // divisórias da tela dividida
    if (app.views.length > 1) {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4;
      ctx.beginPath();
      app.views.forEach((v) => { const R = v.rect; ctx.rect(R.x, R.y, R.w, R.h); });
      ctx.stroke();
    }

    // contagem regressiva inicial
    if (now < w.readyUntil) {
      const n = Math.ceil((w.readyUntil - now) / 500);
      const u = clamp(Math.min(W, H) / 600, 0.55, 1.3);
      ctx.fillStyle = 'rgba(0,50,70,.18)'; ctx.fillRect(0, 0, W, H);
      txt('Prepare-se!', W / 2, H / 2 - 60 * u, 30 * u, '#fff', 'center', 'rgba(0,40,55,.6)');
      txt(String(n), W / 2, H / 2 + 10 * u, 96 * u, '#fff', 'center', 'rgba(0,40,55,.6)');
    }

    // tela de eliminação (um jogador por tela)
    if (app.views.length === 1) {
      const me = w.players[app.views[0].focus];
      const box = $('deadBox');
      if (!me.alive) {
        if (!me._dt) me._dt = now;
        if (now - me._dt > 750 && box.classList.contains('hidden') && $('pauseBox').classList.contains('hidden')) showDead(me);
      } else {
        me._dt = 0;
        if (!box.classList.contains('hidden')) box.classList.add('hidden');
      }
    }
  }
  requestAnimationFrame(frame);

  updLocal();
  show('screenMenu');
  setTimeout(() => { loadPeer().catch(() => {}); }, 2500);   // pré-carrega a rede em segundo plano

  // entrar direto pelo link de convite (?sala=CODIGO)
  try {
    const code = (new URLSearchParams(location.search).get('sala') || '').trim().toUpperCase().slice(0, 5);
    if (code) {
      $('inCode').value = code;
      show('screenOnline');
      netMsg('Entrando na sala ' + code + '…');
      setTimeout(() => { if (!app.playing && !app.net) $('btnJoin').onclick(); }, 700);
    }
  } catch (e) { /* ignore */ }
})();
