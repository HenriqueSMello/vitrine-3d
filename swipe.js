// Vitrine 3D — gestos com sensação "nativa": o conteúdo segue o dedo, tem inércia,
// elástico nas bordas e encaixe suave no próximo item.

const EASE = 'cubic-bezier(.22,1,.36,1)';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const haptic = () => { try { navigator.vibrate?.(6); } catch {} };

/**
 * Carrossel arrastável com física de mola (contínua e interrompível).
 * O movimento nunca "corta": ao soltar o dedo, a mola herda a velocidade do gesto;
 * ao pegar o carrossel no meio de uma animação, ele para exatamente onde está.
 * opts.onProgress(pos)  -> posição contínua (ex.: 1.37) a cada frame
 * opts.onChange(index)  -> índice de destino mudou
 * opts.loop             -> next()/goTo além do fim voltam ao começo
 */
export class Swiper {
  constructor(viewport, track, opts = {}) {
    Object.assign(this, { viewport, track, opts, index: 0, pos: 0, vel: 0, dragging: false, moved: false });
    this.count = track.children.length;
    viewport.style.touchAction = 'pan-y';
    track.style.transition = 'none';
    viewport.addEventListener('pointerdown', (e) => this.down(e));
    addEventListener('pointermove', (e) => this.move(e), { passive: false });
    addEventListener('pointerup', (e) => this.up(e));
    addEventListener('pointercancel', (e) => this.up(e));
    viewport.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    viewport.addEventListener('click', (e) => { if (this.moved) { e.stopPropagation(); e.preventDefault(); } }, true);
    viewport.addEventListener('dragstart', (e) => e.preventDefault());
    new ResizeObserver(() => this.paint()).observe(viewport);
    this.paint();
  }
  get W() { return this.viewport.clientWidth || 1; }
  paint() {
    this.track.style.transform = `translate3d(${(-this.pos * this.W).toFixed(2)}px,0,0)`;
    this.opts.onProgress?.(this.pos);
  }
  // mola amortecida: k = rigidez, z = amortecimento (1 = crítico, sem quique)
  spring(target, { k = 90, z = 1 } = {}) {
    cancelAnimationFrame(this.raf);
    this.target = target;
    const c = 2 * Math.sqrt(k) * z;
    let last = performance.now();
    const step = (now) => {
      let dt = Math.min((now - last) / 1000, 1 / 30); last = now;
      // sub-passos para estabilidade
      for (let i = 0; i < 4; i++) {
        const h = dt / 4, a = -k * (this.pos - target) - c * this.vel;
        this.vel += a * h; this.pos += this.vel * h;
      }
      if (Math.abs(this.pos - target) < 0.0004 && Math.abs(this.vel) < 0.002) { this.pos = target; this.vel = 0; this.paint(); return; }
      this.paint();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  goTo(i, { soft = false } = {}) {
    if (this.opts.loop && (i >= this.count || i < 0)) i = (i + this.count) % this.count;
    i = Math.max(0, Math.min(this.count - 1, i));
    const changed = i !== this.index;
    this.index = i;
    // avanço automático: mola mais lenta e macia; voltar ao início percorre o caminho todo, suave
    const far = Math.abs(i - this.pos) > 1.5;
    this.spring(i, soft || far ? { k: far ? 28 : 38, z: 1 } : { k: 90, z: 1 });
    if (changed) this.opts.onChange?.(i);
  }
  next(o) { this.goTo(this.index + 1, o); }
  prev(o) { this.goTo(this.index - 1, o); }

  down(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancelAnimationFrame(this.raf);
    this.vel = 0;
    this.start = { x: e.clientX, y: e.clientY, pos: this.pos };
    this.hist = [{ x: e.clientX, t: e.timeStamp || performance.now() }];
    this.dragging = true; this.locked = null; this.moved = false; this.pid = e.pointerId;
    this.opts.onGrab?.();
  }
  move(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    const dx = e.clientX - this.start.x, dy = e.clientY - this.start.y;
    if (!this.locked) {
      if (Math.hypot(dx, dy) < 5) return;
      this.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (this.locked === 'y') { this.dragging = false; this.goTo(Math.round(this.pos)); return; }
      try { this.viewport.setPointerCapture(this.pid); } catch {}
      this.viewport.classList.add('grabbing');
      this.start.x = e.clientX; // evita "pulo" dos 5px iniciais
    }
    e.preventDefault();
    this.moved = true;
    let p = this.start.pos - (e.clientX - this.start.x) / this.W;
    const max = this.count - 1;
    if (p < 0) p = -this.rubber(-p);
    if (p > max) p = max + this.rubber(p - max);
    this.pos = p;
    this.hist.push({ x: e.clientX, t: e.timeStamp || performance.now() });
    if (this.hist.length > 8) this.hist.shift();
    this.paint();
  }
  rubber(over) { return 0.35 * (1 - 1 / (over * 2.4 + 1)); }
  up(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    this.dragging = false;
    this.viewport.classList.remove('grabbing');
    if (!this.moved) { this.goTo(Math.round(this.pos)); this.opts.onRelease?.(); return; }
    // velocidade média dos últimos ~80ms do gesto
    const h = this.hist, b = h[h.length - 1];
    let a = h[0]; for (const p of h) if (b.t - p.t <= 80) { a = p; break; }
    const vpx = (b.x - a.x) / Math.max(1, b.t - a.t);          // px/ms
    this.vel = -vpx * 1000 / this.W;                           // slides/s, herdada pela mola
    // projeta onde o gesto "pararia" e escolhe o slide mais próximo disso (no máx. ±1)
    const base = Math.round(this.start.pos);
    let target = Math.round(this.pos + this.vel * 0.25);
    if (Math.abs(vpx) > 0.3) target = vpx < 0 ? base + 1 : base - 1;   // "flick" sempre troca
    target = Math.max(base - 1, Math.min(base + 1, target));
    target = Math.max(0, Math.min(this.count - 1, target));
    const changed = target !== this.index;
    this.index = target;
    this.spring(target, { k: 110, z: 0.92 });
    if (changed) { haptic(); this.opts.onChange?.(target); }
    this.opts.onRelease?.();
    setTimeout(() => { this.moved = false; }, 0);
  }
  wheel(e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    // trackpad: segue o dedo continuamente e encaixa quando o gesto termina
    cancelAnimationFrame(this.raf);
    this.opts.onGrab?.();
    const max = this.count - 1;
    let p = this.pos + e.deltaX / this.W;
    if (p < 0) p = -this.rubber(-p); if (p > max) p = max + this.rubber(p - max);
    this.wv = e.deltaX / this.W * 60;   // aprox. slides/s
    this.pos = p; this.paint();
    clearTimeout(this.wt);
    this.wt = setTimeout(() => {
      this.vel = this.wv || 0;
      let target = Math.round(this.pos + this.vel * 0.12);
      target = Math.max(0, Math.min(max, target));
      const changed = target !== this.index; this.index = target;
      this.spring(target, { k: 90, z: 1 });
      if (changed) this.opts.onChange?.(target);
      this.opts.onRelease?.();
    }, 90);
  }
}

/**
 * Arrastar para baixo para fechar (bottom sheet no celular).
 * handle: onde o gesto pode começar; panel: o que se move; canStart(e) decide se o gesto é aceito.
 */
export function dragToClose(handle, panel, backdrop, onClose, canStart = () => true) {
  let s = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!matchMedia('(max-width: 899px)').matches || !canStart(e)) return;
    s = { y: e.clientY, x: e.clientX, t: performance.now(), locked: null, id: e.pointerId, hist: [] };
  });
  addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dy = e.clientY - s.y, dx = e.clientX - s.x;
    if (!s.locked) {
      if (Math.hypot(dx, dy) < 8) return;
      s.locked = Math.abs(dy) > Math.abs(dx) && dy > 0 ? 'y' : 'no';
      if (s.locked === 'no') { s = null; return; }
      panel.style.transition = 'none'; backdrop.style.transition = 'none';
    }
    const y = Math.max(0, dy);
    panel.style.transform = `translate3d(0,${y}px,0)`;
    backdrop.style.backgroundColor = `rgba(0,0,0,${0.35 * (1 - Math.min(y / 500, 1))})`;
    s.hist.push({ y: e.clientY, t: performance.now() }); if (s.hist.length > 6) s.hist.shift();
  }, { passive: true });
  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const ok = s.locked === 'y'; const h = s.hist; s = null;
    if (!ok) return;
    const dy = parseFloat(panel.style.transform.split(',')[1]) || 0;
    const v = h.length > 1 ? (h.at(-1).y - h[0].y) / Math.max(1, h.at(-1).t - h[0].t) : 0;
    panel.style.transition = `transform .42s ${EASE}`; backdrop.style.transition = 'background-color .42s';
    if (dy > 140 || v > 0.6) { haptic(); onClose(); }
    else { panel.style.transform = ''; backdrop.style.backgroundColor = ''; }
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
}

/**
 * Faixa contínua (sem encaixe): o conteúdo segue o dedo, desliza com inércia e para onde a
 * física mandar — inclusive entre dois tênis. Loop infinito e deriva lenta quando ninguém mexe.
 * opts.slideWidth(W) -> largura de cada item em px
 * opts.onFrame(pos, items, sw) -> chamado a cada frame (pos contínuo em "itens")
 * opts.drift  -> velocidade da deriva automática (itens/s)
 */
export class FreeStrip {
  constructor(viewport, items, opts = {}) {
    Object.assign(this, { viewport, items, opts, pos: 0, vel: 0, dragging: false, moved: false, lastTouch: -1e9 });
    this.n = items.length;
    viewport.style.touchAction = 'pan-y';
    viewport.addEventListener('pointerdown', (e) => this.down(e));
    addEventListener('pointermove', (e) => this.move(e), { passive: false });
    addEventListener('pointerup', (e) => this.up(e));
    addEventListener('pointercancel', (e) => this.up(e));
    viewport.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    viewport.addEventListener('click', (e) => { if (this.moved) { e.stopPropagation(); e.preventDefault(); } }, true);
    viewport.addEventListener('dragstart', (e) => e.preventDefault());
    this.last = performance.now();
    const loop = (now) => { this.tick(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  get sw() { return this.opts.slideWidth ? this.opts.slideWidth(this.viewport.clientWidth) : this.viewport.clientWidth * 0.5; }
  wrap(d) { const n = this.n; return ((d % n) + n * 1.5) % n - n / 2; }   // distância circular em [-n/2, n/2)
  tick(now) {
    const dt = Math.min((now - this.last) / 1000, 1 / 20); this.last = now;
    if (!this.dragging) {
      const idle = now - this.lastTouch > (this.opts.idleMs ?? 2600) && !this.paused;
      const drift = idle ? (this.opts.drift ?? 0.09) : 0;
      // atrito exponencial (parecido com a desaceleração do iOS) + aproximação suave da deriva
      const fr = Math.exp(-dt * 2.6);
      this.vel = drift + (this.vel - drift) * (idle ? Math.exp(-dt * 1.2) : fr);
      this.pos += this.vel * dt;
    }
    const sw = this.sw;
    this.items.forEach((el, i) => {
      const d = this.wrap(i - this.pos);
      el.style.transform = `translate3d(${(d * sw).toFixed(2)}px,0,0)`;
      el._d = d;
    });
    this.opts.onFrame?.(this.pos, this.items, sw);
  }
  touch() { this.lastTouch = performance.now(); }
  down(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.dragging = true; this.locked = null; this.moved = false; this.pid = e.pointerId;
    this.start = { x: e.clientX, y: e.clientY, pos: this.pos };
    this.hist = [{ x: e.clientX, t: e.timeStamp || performance.now() }];
    this.vel = 0; this.touch();
  }
  move(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    const dx = e.clientX - this.start.x, dy = e.clientY - this.start.y;
    if (!this.locked) {
      if (Math.hypot(dx, dy) < 5) return;
      this.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (this.locked === 'y') { this.dragging = false; return; }
      try { this.viewport.setPointerCapture(this.pid); } catch {}
      this.viewport.classList.add('grabbing');
      this.start.x = e.clientX; this.start.pos = this.pos;
    }
    e.preventDefault();
    this.moved = true;
    this.pos = this.start.pos - (e.clientX - this.start.x) / this.sw;
    this.hist.push({ x: e.clientX, t: e.timeStamp || performance.now() });
    if (this.hist.length > 8) this.hist.shift();
    this.touch();
  }
  up(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    this.dragging = false;
    this.viewport.classList.remove('grabbing');
    if (this.moved) {
      const h = this.hist, b = h[h.length - 1];
      let a = h[0]; for (const p of h) if (b.t - p.t <= 90) { a = p; break; }
      const vpx = (b.x - a.x) / Math.max(1, b.t - a.t);
      this.vel = Math.max(-6, Math.min(6, -vpx * 1000 / this.sw));
    }
    this.touch();
    setTimeout(() => { this.moved = false; }, 0);
  }
  wheel(e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    this.pos += e.deltaX / this.sw;
    this.vel = 0; this.touch();
    // pequena inércia ao terminar o gesto do trackpad
    clearTimeout(this.wt); const v = e.deltaX / this.sw * 50;
    this.wt = setTimeout(() => { this.vel = Math.max(-3, Math.min(3, v)); this.touch(); }, 60);
  }
  goTo(i) {   // anima até o item i pelo caminho mais curto (usado pelos indicadores)
    const d = this.wrap(i - this.pos);
    this.vel = d * 2.6;   // com o atrito acima, percorre ~d itens
    this.touch();
  }
  nearest() { return ((Math.round(this.pos) % this.n) + this.n) % this.n; }
}
