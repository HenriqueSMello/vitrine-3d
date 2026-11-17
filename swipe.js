// Vitrine 3D — gestos com sensação "nativa": o conteúdo segue o dedo, tem inércia,
// elástico nas bordas e encaixe suave no próximo item.

const EASE = 'cubic-bezier(.22,1,.36,1)';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const haptic = () => { try { navigator.vibrate?.(6); } catch {} };

/**
 * Carrossel arrastável.
 * viewport: elemento com overflow hidden; track: filho com os slides lado a lado (cada um 100% da largura).
 * opts.onProgress(pos)  -> pos contínuo (ex.: 1.37) a cada frame, para parallax/indicadores
 * opts.onChange(index)  -> quando encaixa num novo índice
 * opts.loop             -> volta ao início ao passar do último (só no avanço automático / next())
 */
export class Swiper {
  constructor(viewport, track, opts = {}) {
    Object.assign(this, { viewport, track, opts, index: 0, pos: 0, dragging: false, moved: false });
    this.count = track.children.length;
    viewport.style.touchAction = 'pan-y';
    viewport.addEventListener('pointerdown', (e) => this.down(e));
    addEventListener('pointermove', (e) => this.move(e), { passive: false });
    addEventListener('pointerup', (e) => this.up(e));
    addEventListener('pointercancel', (e) => this.up(e));
    viewport.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // evita o "click" depois de um arrasto
    viewport.addEventListener('click', (e) => { if (this.moved) { e.stopPropagation(); e.preventDefault(); } }, true);
    viewport.addEventListener('dragstart', (e) => e.preventDefault());
    new ResizeObserver(() => this.render(false)).observe(viewport);
    this.render(false);
  }
  get W() { return this.viewport.clientWidth || 1; }
  render(animate = true, ms = 520) {
    this.track.style.transition = animate ? `transform ${ms}ms ${EASE}` : 'none';
    this.track.style.transform = `translate3d(${-this.pos * this.W}px,0,0)`;
    if (animate) this.animateProgress(ms); else this.opts.onProgress?.(this.pos);
  }
  // acompanha a transição CSS para quem usa onProgress (parallax / indicador)
  animateProgress(ms) {
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    const tick = () => {
      const m = getComputedStyle(this.track).transform;
      const x = m && m !== 'none' ? new DOMMatrix(m).m41 : 0;
      this.opts.onProgress?.(-x / this.W);
      if (performance.now() - t0 < ms + 40) this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  goTo(i, animate = true) {
    const loop = this.opts.loop && (i >= this.count || i < 0);
    i = loop ? (i + this.count) % this.count : clamp(i, 0, this.count - 1);
    const changed = i !== this.index;
    this.index = i; this.pos = i;
    this.render(animate, loop ? 760 : 520);
    if (changed) this.opts.onChange?.(i);
  }
  next() { this.goTo(this.index + 1); }
  prev() { this.goTo(this.index - 1); }

  down(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.start = { x: e.clientX, y: e.clientY, t: performance.now(), pos: this.pos };
    this.hist = [{ x: e.clientX, t: performance.now() }];
    this.dragging = true; this.locked = null; this.moved = false; this.pid = e.pointerId;
    cancelAnimationFrame(this.raf);
    // congela onde a animação estava, para "pegar" o carrossel em movimento
    const m = getComputedStyle(this.track).transform;
    if (m && m !== 'none') { this.pos = -new DOMMatrix(m).m41 / this.W; this.start.pos = this.pos; }
    this.track.style.transition = 'none';
    this.render(false);
    this.opts.onGrab?.();
  }
  move(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    const dx = e.clientX - this.start.x, dy = e.clientY - this.start.y;
    if (!this.locked) {
      if (Math.hypot(dx, dy) < 6) return;
      this.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (this.locked === 'y') { this.dragging = false; return; }
      try { this.viewport.setPointerCapture(this.pid); } catch {}
      this.viewport.classList.add('grabbing');
    }
    e.preventDefault();
    this.moved = true;
    let p = this.start.pos - dx / this.W;
    // elástico nas bordas
    if (p < 0) p = -this.rubber(-p);
    if (p > this.count - 1) p = this.count - 1 + this.rubber(p - (this.count - 1));
    this.pos = p;
    this.hist.push({ x: e.clientX, t: performance.now() });
    if (this.hist.length > 6) this.hist.shift();
    this.render(false);
  }
  rubber(over) { return (1 - 1 / (over * 3 + 1)) / 3; }
  up(e) {
    if (!this.dragging || e.pointerId !== this.pid) return;
    this.dragging = false;
    this.viewport.classList.remove('grabbing');
    if (!this.moved) { this.opts.onRelease?.(); return; }
    const h = this.hist, a = h[0], b = h[h.length - 1];
    const v = (b.x - a.x) / Math.max(1, b.t - a.t);   // px/ms (positivo = arrastou p/ direita)
    let target = Math.round(this.pos);
    if (Math.abs(v) > 0.35) target = v < 0 ? Math.floor(this.start.pos) + 1 : Math.ceil(this.start.pos) - 1;
    target = clamp(target, 0, this.count - 1);
    // a duração acompanha a velocidade do gesto: lançar rápido = encaixe rápido
    const dist = Math.abs(target - this.pos) * this.W;
    const ms = clamp(dist / Math.max(Math.abs(v), 0.6) * 2.2, 280, 620);
    const changed = target !== this.index;
    this.index = target; this.pos = target;
    this.render(true, ms);
    if (changed) { haptic(); this.opts.onChange?.(target); }
    this.opts.onRelease?.();
    setTimeout(() => { this.moved = false; }, 0);
  }
  wheel(e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    this.wacc = (this.wacc || 0) + e.deltaX;
    clearTimeout(this.wt);
    this.wt = setTimeout(() => { this.wacc = 0; }, 180);
    if (Math.abs(this.wacc) > 60 && !this.wlock) {
      this.wlock = true; this.opts.onGrab?.();
      this.goTo(this.index + (this.wacc > 0 ? 1 : -1));
      this.wacc = 0; setTimeout(() => { this.wlock = false; this.opts.onRelease?.(); }, 450);
    }
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
