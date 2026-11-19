'use strict';

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const COLORS = ['green', 'red'];
const NAME = { green: 'Green', red: 'Red' };
const CH = { green: 'G', red: 'R' };
const COLOR_OF = { G: 'green', R: 'red' };
const other = c => (c === 'green' ? 'red' : 'green');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const now = () => performance.now();
const countOf = (cells, ch) => cells.split(ch).length - 1;
const fmt = secs => `0:${String(secs).padStart(2, '0')}`;
const buzz = pattern => { try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) { /* unsupported */ } };

/** Only touches the DOM when the markup actually changes. */
function setHTML(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}

/* ------------------------------------------------------------------ storage */

const memory = {};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('bacteria.' + key);
      return v === null ? (key in memory ? memory[key] : fallback) : JSON.parse(v);
    } catch (_) {
      return key in memory ? memory[key] : fallback;
    }
  },
  set(key, value) {
    memory[key] = value;
    try { localStorage.setItem('bacteria.' + key, JSON.stringify(value)); } catch (_) { /* private mode */ }
  },
};

const getToken = id => store.get('tokens', {})[id] || null;
function setToken(id, token) {
  const tokens = store.get('tokens', {});
  tokens[id] = token;
  const ids = Object.keys(tokens);
  if (ids.length > 40) delete tokens[ids[0]];
  store.set('tokens', tokens);
}

/* ------------------------------------------------------------------ sound */

const sound = (() => {
  let ctx = null;
  let muted = store.get('muted', false);
  const btn = $('#sound');
  const paint = () => {
    btn.classList.toggle('muted', muted);
    btn.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
  };
  paint();

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Browsers only allow audio after a user gesture.
  window.addEventListener('pointerdown', () => { if (!muted) audio(); }, { once: true });

  function tone(f0, f1, dur, type = 'sine', vol = 0.1, delay = 0) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + delay;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  const sounds = {
    select: () => tone(660, 900, 0.05, 'triangle', 0.05),
    copy: () => tone(260, 640, 0.12, 'sine', 0.16),
    jump: () => { tone(220, 560, 0.1, 'sine', 0.12); tone(560, 280, 0.14, 'sine', 0.1, 0.1); },
    convert: k => tone(520 + k * 70, 760 + k * 90, 0.07, 'triangle', 0.07),
    fill: () => tone(300, 900, 0.6, 'triangle', 0.05),
    start: () => { tone(440, 440, 0.12, 'triangle', 0.09); tone(660, 660, 0.18, 'triangle', 0.09, 0.12); },
    tick: () => tone(1250, 1250, 0.03, 'square', 0.025),
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.18, 'triangle', 0.09, i * 0.1)),
    lose: () => [440, 370, 311].forEach((f, i) => tone(f, f * 0.97, 0.22, 'triangle', 0.08, i * 0.15)),
    nope: () => tone(190, 140, 0.08, 'square', 0.03),
  };

  btn.addEventListener('click', () => {
    muted = !muted;
    store.set('muted', muted);
    paint();
    play('select');
  });

  function play(name, ...args) {
    if (muted) return;
    try { sounds[name](...args); } catch (_) { /* audio unavailable */ }
  }
  return { play };
})();

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;
function toast(text, ms = 2400) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ rules (mirror of src/game.rs) */

const AROUND = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// Copies to the 8 neighbours, then the 4 straight jumps.
const STEPS = [...AROUND, [2, 0], [-2, 0], [0, 2], [0, -2]];

function offset(b, i, dx, dy) {
  const x = (i % b.w) + dx;
  const y = Math.floor(i / b.w) + dy;
  return x < 0 || y < 0 || x >= b.w || y >= b.h ? -1 : y * b.w + x;
}

/** Empty cells the bacterium at `i` can reach. `b` is `{w, h, cells}`. */
function destinations(b, i) {
  const out = [];
  STEPS.forEach(([dx, dy], k) => {
    const j = offset(b, i, dx, dy);
    if (j >= 0 && b.cells[j] === '.') out.push({ to: j, jump: k >= 8 });
  });
  return out;
}

function captures(b, color, to) {
  const enemy = CH[other(color)];
  return AROUND.map(([dx, dy]) => offset(b, to, dx, dy)).filter(j => j >= 0 && b.cells[j] === enemy);
}

function hasMoves(b, color) {
  for (let i = 0; i < b.cells.length; i++) {
    if (b.cells[i] === CH[color] && destinations(b, i).length) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ board view */

const PIECE_ANIMS = ['spawning', 'jumping', 'converting', 'filling', 'nope', 'hop'];

function anim(el, cls) {
  el.classList.remove(...PIECE_ANIMS, cls);
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
}

/** Renders a board and animates moves on it. Knows nothing about the network. */
class BoardView {
  constructor(el, handlers = {}) {
    this.el = el;
    this.pending = [];
    this.pieces = [];
    this.cellsEl = [];
    if (handlers.onTap) {
      el.addEventListener('pointerdown', e => {
        if (e.button > 0) return;
        const cell = e.target.closest('.cell');
        if (!cell) return;
        this.fx(+cell.dataset.i, 'tap');
        handlers.onTap(+cell.dataset.i);
      });
    }
    if (handlers.onHover) {
      el.addEventListener('pointerover', e => {
        if (e.pointerType !== 'mouse') return;
        const cell = e.target.closest('.cell');
        handlers.onHover(cell ? +cell.dataset.i : -1);
      });
      el.addEventListener('pointerleave', () => handlers.onHover(-1));
    }
  }

  setup(w, h, cells) {
    this.cols = w;
    this.rows = h;
    this.el.style.setProperty('--w', w);
    this.el.style.setProperty('--h', h);
    this.pieces = new Array(w * h).fill(null);
    this.cellsEl = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < w * h; i++) {
      const c = document.createElement('div');
      const alt = ((i % w) + Math.floor(i / w)) % 2 === 1;
      c.className = 'cell' + (cells[i] === '#' ? ' blocked' : alt ? ' alt' : '');
      c.dataset.i = i;
      frag.appendChild(c);
      this.cellsEl.push(c);
    }
    this.el.replaceChildren(frag);
  }

  piece(color) {
    const p = document.createElement('div');
    p.className = 'bac ' + color;
    p.style.setProperty('--d', (-Math.random() * 7).toFixed(2) + 's');
    p.appendChild(document.createElement('i'));
    p.addEventListener('animationend', e => { if (e.target === p) p.classList.remove(...PIECE_ANIMS); });
    return p;
  }

  /** Puts the board in the given position, without animation. */
  sync(cells) {
    for (let i = 0; i < this.pieces.length; i++) {
      const want = COLOR_OF[cells[i]];
      const p = this.pieces[i];
      if (!want) {
        if (p) { p.remove(); this.pieces[i] = null; }
      } else if (!p) {
        const n = this.piece(want);
        this.cellsEl[i].appendChild(n);
        this.pieces[i] = n;
      } else if (!p.classList.contains(want)) {
        p.classList.remove(other(want));
        p.classList.add(want);
      }
    }
  }

  later(fn, ms) {
    const task = { fn };
    task.id = setTimeout(() => {
      this.pending = this.pending.filter(t => t !== task);
      fn();
    }, ms);
    this.pending.push(task);
  }

  /** Runs every scheduled step right now (a new position is coming). */
  flush() {
    const tasks = this.pending;
    this.pending = [];
    tasks.forEach(t => { clearTimeout(t.id); t.fn(); });
  }

  /** Animates a move. Returns how long the whole sequence takes, in ms. */
  animate(m, color, sounds = true) {
    const w = this.cols;
    const dx = (m.from % w) - (m.to % w);
    const dy = Math.floor(m.from / w) - Math.floor(m.to / w);
    let el = null;
    if (m.jump) {
      el = this.pieces[m.from];
      this.pieces[m.from] = null;
      this.fx(m.from, 'puff ' + color);
    }
    if (!el) el = this.piece(color);
    if (this.pieces[m.to]) this.pieces[m.to].remove();
    el.classList.remove('selected', 'threat');
    this.cellsEl[m.to].appendChild(el);
    this.pieces[m.to] = el;
    el.style.setProperty('--dx', dx);
    el.style.setProperty('--dy', dy);
    anim(el, m.jump ? 'jumping' : 'spawning');
    if (sounds) sound.play(m.jump ? 'jump' : 'copy');

    const start = m.jump ? 290 : 190;
    const step = 60;
    m.converted.forEach((i, k) => this.later(() => {
      this.convert(i, color);
      if (sounds) sound.play('convert', k);
    }, start + k * step));
    let end = start + m.converted.length * step + 260;
    if (m.filled && m.filled.length) end = this.fillAll(m.filled, color, m.to, end + 200, sounds);
    return end;
  }

  /** Auto-complete: empty cells fill up in a wave starting from `origin`. */
  fillAll(list, color, origin, delay, sounds = true) {
    const w = this.cols;
    const ox = origin % w;
    const oy = Math.floor(origin / w);
    const dist = i => Math.hypot((i % w) - ox, Math.floor(i / w) - oy);
    const order = [...list].sort((a, b) => dist(a) - dist(b));
    const step = Math.max(12, Math.min(50, 900 / order.length));
    if (sounds) this.later(() => sound.play('fill'), delay);
    order.forEach((i, k) => this.later(() => this.fill(i, color), delay + k * step));
    return delay + order.length * step + 350;
  }

  convert(i, color) {
    const p = this.pieces[i];
    if (!p) return;
    p.classList.remove(other(color));
    p.classList.add(color);
    anim(p, 'converting');
    this.fx(i, 'ring ' + color);
  }

  fill(i, color) {
    if (this.pieces[i]) return;
    const p = this.piece(color);
    this.cellsEl[i].appendChild(p);
    this.pieces[i] = p;
    anim(p, 'filling');
  }

  fx(i, cls) {
    const s = document.createElement('span');
    s.className = 'fx ' + cls;
    s.addEventListener('animationend', () => s.remove());
    this.cellsEl[i].appendChild(s);
  }

  celebrate(color) {
    this.pieces.forEach((p, i) => {
      if (!p || !p.classList.contains(color)) return;
      p.style.setProperty('--k', ((i % this.cols) + Math.floor(i / this.cols)) * 45 + 'ms');
      anim(p, 'hop');
    });
  }
}

/* ------------------------------------------------------------------ router */

let current = null;

function route() {
  if (current) current.destroy();
  current = null;
  $('#toast').classList.remove('show');
  const m = location.pathname.match(/^\/g\/([a-z0-9]+)\/?$/);
  current = m ? new GameView(m[1]) : new HomeView();
  window.scrollTo(0, 0);
}

function navigate(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}

window.addEventListener('popstate', route);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});

/* ------------------------------------------------------------------ home */

const ICONS = {
  link: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3"/></svg>',
  duo: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19.5c.4-3.2 2.7-5.5 5.5-5.5s5.1 2.3 5.5 5.5M14.5 14.3c.6-.2 1.3-.3 2-.3 2.4 0 4.2 1.9 4.5 4.5"/></svg>',
};

const RULES = `
  <ol>
    <li>Tap one of your bacteria, then a highlighted cell.</li>
    <li>Next door, diagonals included: your bacterium <b>copies</b> itself.</li>
    <li>Two cells away in a straight line (no diagonals): it <b>jumps</b>, leaving its old cell empty.</li>
    <li>Where it lands, every enemy bacterium touching it <b>converts</b> to your colour, diagonals included.</li>
    <li>You have <b>30 seconds</b> per move. Run out and you lose.</li>
    <li>When a player can't move, the other one takes every empty cell. Most cells wins.</li>
  </ol>`;

class HomeView {
  constructor() {
    const level = (name, n) => `<button type="button" data-level="${name}"><span class="pips">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(3 - n)}</span>${cap(name)}</button>`;
    app.innerHTML = `
      <section class="home">
        <div class="hero">
          <div class="board demo" aria-hidden="true"></div>
          <h1>Bacteria</h1>
          <p class="tagline">Spread your bacteria. Convert your rivals. Take the board.</p>
        </div>
        <nav class="modes">
          <button type="button" class="mode" data-mode="online">
            <span class="mode-icon">${ICONS.link}</span>
            <span class="mode-text"><b>Play with a friend</b><small>Send a link, play anywhere</small></span>
          </button>
          <div class="mode-group">
            <button type="button" class="mode" data-mode="solo" aria-expanded="false">
              <span class="mode-icon">${ICONS.cpu}</span>
              <span class="mode-text"><b>Play the computer</b><small>Easy, medium or hard</small></span>
            </button>
            <div class="levels">${level('easy', 1)}${level('medium', 2)}${level('hard', 3)}</div>
          </div>
          <button type="button" class="mode" data-mode="local">
            <span class="mode-icon">${ICONS.duo}</span>
            <span class="mode-text"><b>Pass and play</b><small>Two players, one screen</small></span>
          </button>
        </nav>
        <details class="rules">
          <summary>How to play</summary>
          ${RULES}
        </details>
      </section>`;

    const group = $('.mode-group');
    app.querySelector('.modes').addEventListener('click', e => {
      const lvl = e.target.closest('[data-level]');
      if (lvl) return this.create('solo', lvl.dataset.level, lvl);
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      if (btn.dataset.mode === 'solo') {
        const open = group.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        sound.play('select');
        return;
      }
      this.create(btn.dataset.mode, undefined, btn);
    });

    this.demo = new Demo($('.board.demo'));
  }

  async create(mode, difficulty, btn) {
    if (this.busy) return;
    this.busy = true;
    btn.classList.add('busy');
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, difficulty }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { id, token } = await res.json();
      setToken(id, token);
      navigate('/g/' + id);
    } catch (_) {
      toast("Couldn't start a game. Try again.");
      btn.classList.remove('busy');
      this.busy = false;
    }
  }

  destroy() {
    this.demo.stop();
  }
}

/** The little board on the home page that plays against itself. */
class Demo {
  constructor(el) {
    this.view = new BoardView(el);
    this.reset();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.timer = setInterval(() => this.step(), 1150);
    }
  }

  reset() {
    this.cells = ('G...R' + '.....' + '..#..' + '.....' + 'R...G').split('');
    this.turn = 'green';
    this.rest = 0;
    this.view.setup(5, 5, this.cells);
    this.view.sync(this.cells);
    anim(this.view.el, 'appear');
  }

  step() {
    if (document.hidden) return;
    if (this.rest > 0) {
      if (--this.rest === 0) this.reset();
      return;
    }
    const b = { w: 5, h: 5, cells: this.cells };
    const me = CH[this.turn];
    let best = null;
    let bestScore = -1;
    this.cells.forEach((c, i) => {
      if (c !== me) return;
      for (const d of destinations(b, i)) {
        const score = captures(b, this.turn, d.to).length * 2 + (d.jump ? 0 : 1) + Math.random() * 2.5;
        if (score > bestScore) { bestScore = score; best = { from: i, ...d }; }
      }
    });
    if (!best) { this.rest = 3; return; }
    const converted = captures(b, this.turn, best.to);
    if (best.jump) this.cells[best.from] = '.';
    this.cells[best.to] = me;
    converted.forEach(j => (this.cells[j] = me));
    const filled = [];
    if (!hasMoves(b, other(this.turn))) {
      this.cells.forEach((c, i) => { if (c === '.') { filled.push(i); this.cells[i] = me; } });
      this.rest = 4;
    }
    this.view.flush();
    this.view.animate({ ...best, converted, filled }, this.turn, false);
    this.turn = other(this.turn);
  }

  stop() {
    clearInterval(this.timer);
    this.view.flush();
  }
}

/* ------------------------------------------------------------------ game */

const panelHTML = c => `
  <div class="panel" data-c="${c}">
    <span class="swatch"><span class="bac ${c}"><i></i></span></span>
    <span class="who">
      <span class="name"></span>
      <span class="presence" hidden></span>
      <span class="thinking" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>
    <span class="count">0</span>
    <span class="clock">0:30</span>
    <span class="bar"><i></i></span>
  </div>`;

class GameView {
  constructor(id) {
    this.id = id;
    this.seat = null; // 'green' | 'red' | 'both' | null (spectator)
    this.s = null; // last state from the server
    this.board = null;
    this.selected = -1;
    this.dests = [];
    this.threats = [];
    this.lastCells = [];
    this.optimistic = null;
    this.retry = 0;
    app.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    this.connect();
    this.ping = setInterval(() => this.send({ t: 'ping' }), 25000);
    this.onVisible = () => {
      if (document.hidden) { this.hiddenAt = now(); return; }
      // Phones freeze background tabs: resync after a while away.
      if (this.hiddenAt && now() - this.hiddenAt > 5000 && this.ws) this.ws.close();
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  destroy() {
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.retryTimer);
    clearTimeout(this.disarm);
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.ws) this.ws.close();
    if (this.board) this.board.flush();
  }

  /* --- network --- */

  connect() {
    const token = getToken(this.id);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.id}` + (token ? `?token=${encodeURIComponent(token)}` : ''));
    this.ws = ws;
    ws.onopen = () => {
      if (this.retry > 1) toast('Reconnected');
      this.retry = 0;
    };
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.closed || this.notFound || ws !== this.ws) return;
      if (this.retry === 1) toast('Connection lost. Reconnecting…', 4000);
      const delay = this.retry === 0 ? 0 : Math.min(5000, 400 * 2 ** this.retry);
      this.retry++;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(m) {
    if (m.t === 'welcome') {
      this.seat = m.seat;
      if (m.token) setToken(this.id, m.token);
    } else if (m.t === 'state') {
      this.onState(m);
    } else if (m.t === 'error') {
      if (m.code === 'not_found') {
        this.notFound = true;
        this.renderNotFound();
      } else if (this.optimistic) {
        this.optimistic.rejected = true;
      }
    }
  }

  /* --- seats --- */

  mine() {
    if (this.seat === 'both') return COLORS;
    return this.seat === 'green' || this.seat === 'red' ? [this.seat] : [];
  }

  isMine(c) {
    return this.mine().includes(c);
  }

  /** The single colour this screen plays, or null for pass and play / spectators. */
  me() {
    const m = this.mine();
    return m.length === 1 ? m[0] : null;
  }

  canMove() {
    const s = this.s;
    return !!s && s.status === 'playing' && this.isMine(s.turn) && !s.players[s.turn].ai && !this.optimistic;
  }

  label(c) {
    const s = this.s;
    if (s.mode === 'local' || !this.me()) return NAME[c];
    if (this.isMine(c)) return 'You';
    if (s.players[c].ai) return `Computer · ${cap(s.difficulty)}`;
    return 'Opponent';
  }

  /* --- state --- */

  onState(s) {
    if (s.next) {
      // Rematch accepted: follow the players to the new room.
      const token = getToken(this.id);
      if (token) setToken(s.next, token);
      navigate('/g/' + s.next, true);
      return;
    }
    const prev = this.s;
    this.s = s;
    this.deadline = s.remaining_ms == null ? null : now() + s.remaining_ms;
    if (s.status === 'waiting') {
      this.renderLobby(s);
      return;
    }

    let wait = 0;
    if (!this.board) {
      this.renderGame(s);
    } else {
      const b = this.board;
      const o = this.optimistic;
      const L = s.last;
      this.optimistic = null;
      if (o && !o.rejected && L && s.ply === o.ply && L.from === o.from && L.to === o.to) {
        // Our own move, already animated: only the auto-complete is new.
        wait = Math.max(0, o.endAt - now());
        if (L.filled.length) wait = b.fillAll(L.filled, L.by, L.to, wait + 200);
      } else if (!o && prev && L && s.ply === prev.ply + 1) {
        b.flush();
        b.sync(prev.cells);
        wait = b.animate(L, L.by);
      } else {
        b.flush();
      }
      if (wait) b.later(() => b.sync(s.cells), wait);
      else b.sync(s.cells);
    }
    this.afterState(s, prev, wait);
  }

  afterState(s, prev, wait) {
    const b = this.board;
    if (s.status === 'playing' && s.ply === 0 && (!prev || prev.status === 'waiting')) this.announce(s, prev);
    this.paint();
    if (wait) b.later(() => this.paintScores(s), wait);
    else this.paintScores(s);
    if (s.status === 'finished' && (!prev || prev.status !== 'finished')) {
      if (prev) b.later(() => this.finished(s), wait + 350);
      else this.openModal();
    }
    if (this.modalOpen) this.renderModal();
  }

  announce(s, prev) {
    const me = this.me();
    sound.play('start');
    buzz(15);
    if (s.mode === 'local') toast('Green starts');
    else if (me && prev) toast(`Your opponent is here. You play ${NAME[me]}`, 3000);
    else if (me) toast(s.turn === me ? `You play ${NAME[me]}. Your move!` : `You play ${NAME[me]}`, 3000);
  }

  finished(s) {
    const r = s.result;
    const me = this.me();
    if (r.reason !== 'aborted') {
      sound.play(me && r.winner && r.winner !== me ? 'lose' : 'win');
      if (r.winner) this.board.celebrate(r.winner);
    }
    buzz([20, 60, 20]);
    this.openModal();
  }

  /* --- rendering --- */

  renderNotFound() {
    app.innerHTML = `
      <section class="center">
        <div class="card">
          <h1>Game not found</h1>
          <p class="muted">This game doesn't exist or has expired.</p>
          <a href="/" data-link class="btn primary">New game</a>
        </div>
      </section>`;
  }

  renderLobby(s) {
    if (this.lobby) return; // nothing changes until the opponent shows up
    this.lobby = true;
    const me = this.me();
    const url = `${location.origin}/g/${this.id}`;
    app.innerHTML = `
      <section class="center">
        <div class="card lobby">
          <div class="board mini" aria-hidden="true"></div>
          <h1>Invite a friend</h1>
          <p class="muted">Send this link to your opponent.<br>The game starts as soon as they open it.</p>
          <div class="share">
            <input readonly value="${url}" aria-label="Invite link" spellcheck="false">
            <button type="button" class="btn" data-copy>Copy</button>
          </div>
          ${navigator.share ? '<button type="button" class="btn primary wide" data-share>Share link</button>' : ''}
          <p class="waiting"><span class="dots"><i></i><i></i><i></i></span>Waiting for your opponent</p>
          <p class="meta">${me ? `You play <b class="tag ${me}">${NAME[me]}</b> · ` : ''}${s.map} · 30 s per move</p>
          <a href="/" data-link class="link">Cancel</a>
        </div>
      </section>`;
    const mini = new BoardView($('.board.mini'));
    mini.setup(s.w, s.h, s.cells);
    mini.sync(s.cells);
    const input = $('.share input');
    input.addEventListener('focus', () => input.select());
    $('[data-copy]').addEventListener('click', e => copyText(url, e.currentTarget));
    const share = $('[data-share]');
    if (share) {
      share.addEventListener('click', () => {
        navigator.share({ title: 'Bacteria', text: 'Come play Bacteria with me!', url }).catch(() => {});
      });
    }
  }

  renderGame(s) {
    this.lobby = false;
    const bottom = this.seat === 'red' ? 'red' : 'green';
    app.innerHTML = `
      <section class="game">
        ${panelHTML(other(bottom))}
        <div class="scorebar" aria-hidden="true"><i class="g"></i><i class="r"></i></div>
        <div class="board"></div>
        ${panelHTML(bottom)}
        <p class="status-line" aria-live="polite"></p>
        <div class="actions"></div>
        <div class="modal" hidden></div>
      </section>`;
    const root = $('.game');
    this.panels = {};
    for (const c of COLORS) {
      const el = $(`.panel[data-c="${c}"]`, root);
      this.panels[c] = {
        el,
        name: $('.name', el),
        presence: $('.presence', el),
        count: $('.count', el),
        clock: $('.clock', el),
        bar: $('.bar i', el),
      };
    }
    this.scorebar = { g: $('.scorebar .g', root), r: $('.scorebar .r', root) };
    this.statusEl = $('.status-line', root);
    this.actions = $('.actions', root);
    this.modal = $('.modal', root);
    this.board = new BoardView($('.board', root), { onTap: i => this.onTap(i), onHover: i => this.onHover(i) });
    this.board.setup(s.w, s.h, s.cells);
    this.board.sync(s.cells);
    root.addEventListener('click', e => {
      const a = e.target.closest('[data-act]');
      if (a && !a.disabled) this.act(a.dataset.act);
    });
    this.modal.addEventListener('click', e => { if (e.target === this.modal) this.closeModal(); });
    this.loop();
  }

  paint() {
    const s = this.s;
    const playing = s.status === 'playing';
    for (const c of COLORS) {
      const p = this.panels[c];
      const active = playing && s.turn === c;
      p.el.classList.toggle('active', active);
      p.el.classList.toggle('is-thinking', active && s.players[c].ai);
      p.el.classList.toggle('winner', s.status === 'finished' && s.result.winner === c);
      setHTML(p.name, this.label(c));
      p.presence.hidden = s.mode !== 'online' || this.isMine(c);
      p.presence.classList.toggle('on', s.players[c].online);
      p.presence.title = s.players[c].online ? 'Connected' : 'Disconnected';
    }
    const el = this.board.el;
    el.classList.toggle('turn-green', s.turn === 'green');
    el.classList.toggle('turn-red', s.turn === 'red');
    el.classList.toggle('playable', this.canMove());
    this.markLast(s.last ? [s.last.from, s.last.to] : []);
    setHTML(this.statusEl, this.statusText());
    this.renderActions();
    if (!this.canMove() && this.selected >= 0) this.select(-1);
  }

  paintScores(s) {
    for (const c of COLORS) {
      const el = this.panels[c].count;
      const v = String(s.scores[c]);
      if (el.textContent !== v) {
        el.textContent = v;
        anim(el, 'bump');
      }
    }
    this.scorebar.g.style.flexGrow = s.scores.green;
    this.scorebar.r.style.flexGrow = s.scores.red;
  }

  markLast(cells) {
    this.lastCells.forEach(i => this.board.cellsEl[i] && this.board.cellsEl[i].classList.remove('last'));
    this.lastCells = cells;
    cells.forEach(i => this.board.cellsEl[i].classList.add('last'));
  }

  statusText() {
    const s = this.s;
    if (s.status === 'finished') return this.resultText().title;
    const t = s.turn;
    if (s.mode === 'local') return `<span class="tag ${t}">${NAME[t]}</span> to play`;
    if (this.isMine(t)) return s.ply < 2 ? 'Your move! You have 30 seconds' : 'Your move';
    if (s.players[t].ai) return 'The computer is thinking…';
    if (!this.me()) return `<span class="tag ${t}">${NAME[t]}</span> to play`;
    return s.players[t].online ? "Your opponent's move" : 'Your opponent is disconnected…';
  }

  renderActions() {
    const s = this.s;
    let html = '';
    if (s.status === 'playing' && this.mine().length) {
      html = `<button type="button" class="btn ghost${this.resignArmed ? ' armed' : ''}" data-act="resign">${this.resignArmed ? 'Tap again to resign' : 'Resign'}</button>`;
    } else if (s.status === 'finished') {
      html = this.rematchButton() + '<button type="button" class="btn" data-act="home">New game</button>';
      if (!this.modalOpen) html += '<button type="button" class="btn ghost" data-act="result">Result</button>';
    }
    setHTML(this.actions, html);
  }

  rematchButton() {
    const s = this.s;
    if (!this.mine().length) return '';
    if (s.mode !== 'online') return '<button type="button" class="btn primary" data-act="rematch">Play again</button>';
    const me = this.me();
    if (s.rematch[me]) return '<button type="button" class="btn primary" disabled>Waiting for opponent…</button>';
    if (s.rematch[other(me)]) return '<button type="button" class="btn primary pulse" data-act="rematch">Accept rematch</button>';
    return '<button type="button" class="btn primary" data-act="rematch">Rematch</button>';
  }

  resultText() {
    const s = this.s;
    const r = s.result;
    const me = this.me();
    const w = r.winner;
    const loser = w && other(w);
    const who = c => (me ? (c === me ? 'You' : this.label(c)) : NAME[c]);

    let title;
    let tone = 'neutral';
    if (r.reason === 'aborted') title = 'Game aborted';
    else if (!w) title = 'Draw';
    else if (me) { title = w === me ? 'You won!' : 'You lost'; tone = w === me ? 'win' : 'lose'; }
    else title = `${NAME[w]} wins`;

    let detail;
    if (r.reason === 'timeout') detail = `${who(loser)} ran out of time`;
    else if (r.reason === 'resign') detail = `${who(loser)} resigned`;
    else if (r.reason === 'aborted') detail = 'The first move wasn’t played in time';
    else {
      const n = s.last ? s.last.filled.length : 0;
      const stuck = s.last && other(s.last.by);
      if (n && s.scores[stuck] === 0) detail = `${NAME[stuck]} has no bacteria left`;
      else if (n) detail = `${NAME[stuck]} can’t move: the last ${n} empty cell${n > 1 ? 's go' : ' goes'} to ${NAME[s.last.by]}`;
      else detail = 'The board is full';
    }
    return { title, detail, tone };
  }

  openModal() {
    this.modalOpen = true;
    this.renderModal();
  }

  renderModal() {
    const s = this.s;
    if (!s || s.status !== 'finished') return;
    const { title, detail, tone } = this.resultText();
    const r = s.result;
    const mark = r.winner
      ? `<span class="bac ${r.winner}"><i></i></span>`
      : '<span class="bac green small"><i></i></span><span class="bac red small"><i></i></span>';
    const me = this.me();
    const asks = s.mode === 'online' && me && s.rematch[other(me)] && !s.rematch[me];
    setHTML(this.modal, `
      <div class="modal-card ${tone}" role="dialog" aria-label="${title}">
        <div class="result-mark${r.winner ? '' : ' pair'}">${mark}</div>
        <h2>${title}</h2>
        <p class="final"><span class="g">${s.scores.green}</span><span class="dash">–</span><span class="r">${s.scores.red}</span></p>
        <p class="detail">${detail}</p>
        ${asks ? '<p class="ask">Your opponent wants a rematch</p>' : ''}
        <div class="row">${this.rematchButton()}<button type="button" class="btn" data-act="home">New game</button></div>
        <button type="button" class="link" data-act="close">View board</button>
      </div>`);
    if (this.modal.hidden) {
      this.modal.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => this.modal.classList.add('open')));
    }
    this.renderActions();
  }

  closeModal() {
    this.modalOpen = false;
    this.modal.classList.remove('open');
    setTimeout(() => { if (!this.modalOpen) this.modal.hidden = true; }, 250);
    this.renderActions();
  }

  /** Clocks and time bars, every frame. */
  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const s = this.s;
    if (!s || !this.panels) return;
    for (const c of COLORS) {
      const p = this.panels[c];
      const active = s.status === 'playing' && s.turn === c;
      const ms = active && this.deadline != null ? Math.max(0, this.deadline - now()) : s.move_ms;
      const secs = Math.ceil(ms / 1000);
      let text = fmt(secs);
      if (s.status === 'finished') text = s.result.reason === 'timeout' && s.result.winner !== c ? '0:00' : '–';
      if (p.clock._text !== text) {
        p.clock._text = text;
        p.clock.textContent = text;
      }
      p.bar.style.transform = `scaleX(${active ? ms / s.move_ms : 0})`;
      p.el.classList.toggle('low', active && secs <= 10);
      const tick = `${s.ply}:${secs}`;
      if (active && secs <= 5 && secs > 0 && this.isMine(c) && this.tick !== tick) {
        this.tick = tick;
        sound.play('tick');
      }
    }
  }

  /* --- input --- */

  onTap(i) {
    const s = this.s;
    if (!s || s.status !== 'playing') return;
    if (this.selected >= 0) {
      const d = this.dests.find(x => x.to === i);
      if (d) return this.play(this.selected, d);
    }
    const c = s.cells[i];
    if (this.canMove() && c === CH[s.turn]) {
      this.select(i === this.selected ? -1 : i);
      return;
    }
    if (c === 'G' || c === 'R') {
      const p = this.board.pieces[i];
      if (p) anim(p, 'nope');
    }
    this.select(-1);
  }

  select(i) {
    const b = this.board;
    if (this.selected >= 0) {
      b.cellsEl[this.selected].classList.remove('sel');
      const p = b.pieces[this.selected];
      if (p) p.classList.remove('selected');
    }
    this.dests.forEach(d => b.cellsEl[d.to].classList.remove('dest', 'jump', 'copy'));
    this.onHover(-1);
    this.selected = -1;
    this.dests = [];
    if (i < 0) return;

    const s = this.s;
    const dests = destinations(s, i);
    if (!dests.length) {
      anim(b.pieces[i], 'nope');
      sound.play('nope');
      return;
    }
    this.selected = i;
    this.dests = dests;
    b.cellsEl[i].classList.add('sel');
    b.pieces[i].classList.add('selected');
    dests.forEach((d, k) => {
      const cell = b.cellsEl[d.to];
      cell.style.setProperty('--k', k);
      cell.classList.add('dest', d.jump ? 'jump' : 'copy');
    });
    sound.play('select');
    buzz(6);
  }

  /** Desktop only: hovering a target shows which bacteria would convert. */
  onHover(i) {
    const b = this.board;
    this.threats.forEach(j => b.pieces[j] && b.pieces[j].classList.remove('threat'));
    this.threats = [];
    if (i < 0 || this.selected < 0 || !this.dests.some(d => d.to === i)) return;
    this.threats = captures(this.s, this.s.turn, i);
    this.threats.forEach(j => b.pieces[j] && b.pieces[j].classList.add('threat'));
  }

  /** Plays a move: animate right away, the server confirms a moment later. */
  play(from, d) {
    const s = this.s;
    const color = s.turn;
    const ch = CH[color];
    const converted = captures(s, color, d.to);
    const cells = s.cells.split('');
    if (d.jump) cells[from] = '.';
    cells[d.to] = ch;
    converted.forEach(j => (cells[j] = ch));
    const next = cells.join('');

    this.select(-1);
    const b = this.board;
    b.flush();
    const dur = b.animate({ from, to: d.to, jump: d.jump, converted, filled: [] }, color);
    this.optimistic = { ply: s.ply + 1, from, to: d.to, endAt: now() + dur };
    this.s = {
      ...s,
      cells: next,
      turn: other(color),
      scores: { green: countOf(next, 'G'), red: countOf(next, 'R') },
      last: { by: color, from, to: d.to, jump: d.jump, converted, filled: [] },
    };
    this.deadline = now() + s.move_ms;
    this.send({ t: 'move', from, to: d.to });
    buzz(12);
    this.paint();
    const optimistic = this.s;
    b.later(() => this.paintScores(optimistic), dur);
  }

  act(a) {
    if (a === 'resign') {
      clearTimeout(this.disarm);
      if (this.resignArmed) {
        this.resignArmed = false;
        this.send({ t: 'resign' });
      } else {
        this.resignArmed = true;
        this.disarm = setTimeout(() => { this.resignArmed = false; this.renderActions(); }, 3000);
      }
      this.renderActions();
    } else if (a === 'rematch') {
      this.send({ t: 'rematch' });
    } else if (a === 'home') {
      navigate('/');
    } else if (a === 'close') {
      this.closeModal();
    } else if (a === 'result') {
      this.openModal();
    }
  }
}

async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
    ta.remove();
  }
  if (!ok) return;
  btn.textContent = 'Copied ✓';
  btn.classList.add('ok');
  buzz(10);
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
}

route();
