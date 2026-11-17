// Vitrine 3D — Provador no pé (v2)
// Escaneia os pés pela câmera com um detector YOLOv8n (classes "Footwear" / "Human foot" do Open Images),
// rodando no próprio celular via onnxruntime-web, e "calça" o tênis escolhido sobre cada pé detectado.
// Funciona olhando de cima para os próprios pés (vista superior) e também de lado.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
ort.env.wasm.numThreads = 1;

const MODEL = new URL('./models/foot.onnx', import.meta.url).href;
const S = 416;                                  // entrada da rede
// limiar por classe: pé descalço tem confiança mais baixa que calçado
const CLASSES = { 265: 0.17, 203: 0.3, 56: 0.3, 432: 0.3 };   // Human foot, Footwear, Boot, Sandal
const LEG = 269, LEG_CONF = 0.15;                                // Human leg (para saber de que lado fica o calcanhar)

let sessionP = null;
// o modelo (14 MB) é servido em partes de 3,5 MB e remontado aqui
const PARTS = 4;
const getSession = () => sessionP ??= (async () => {
  const bufs = await Promise.all(Array.from({ length: PARTS }, (_, i) => fetch(`${MODEL}.part${i}`).then((r) => { if (!r.ok) throw new Error('modelo'); return r.arrayBuffer(); })));
  const all = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0)); let o = 0;
  for (const b of bufs) { all.set(new Uint8Array(b), o); o += b.byteLength; }
  return ort.InferenceSession.create(all, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
})();

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// sombra suave (gradiente radial esticado — funciona também no Safari, que não tem ctx.filter)
function shadow(c, x, y, rx, ry, a) {
  c.save(); c.translate(x, y); c.scale(1, ry / rx);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(-rx, -rx, rx * 2, rx * 2); c.restore();
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a.w * a.h + b.w * b.h - i);
}

export class TryOn {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('video');
    this.canvas = root.querySelector('.to-stage canvas');
    this.ctx = this.canvas.getContext('2d');
    this.status = root.querySelector('.to-status');
    this.facing = 'environment';
    this.slots = [this.slot(), this.slot()];
    this.pre = document.createElement('canvas'); this.pre.width = this.pre.height = S;
    this.prex = this.pre.getContext('2d', { willReadFrequently: true });
    this.input = new Float32Array(3 * S * S);
    this.flip = false;
    addEventListener('resize', () => this.resize());
  }
  slot() { return { box: null, target: null, seen: 0, alpha: 0 }; }

  /** imagens do tênis: vista de cima (pé esquerdo/direito) e lateral */
  async setVariant(v, imgFn) {
    const tok = (this.tok = (this.tok || 0) + 1);
    const [tL, tR, lat, med] = await Promise.all(['topL', 'topR', 'lat', 'med'].map((k) => loadImg(imgFn(v, k))));
    if (tok !== this.tok) return;
    this.prevImgs = this.imgs; this.swapT = performance.now();
    this.imgs = { tL, tR, lat, med };
  }
  async start() {
    this.running = true;
    this.say('Abrindo a câmera…');
    await this.openCamera();
    this.say('Carregando o scanner…');
    this.session = await getSession();
    this.say('Aponte para os seus pés');
    this.loop();
    this.detectLoop();
  }
  async openCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    this.video.srcObject = this.stream; this.video.muted = true; this.video.playsInline = true;
    await this.video.play();
    await new Promise((r) => this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true }));
    this.root.classList.toggle('mirror', this.facing === 'user');
    this.resize();
  }
  async switchCamera() { this.facing = this.facing === 'user' ? 'environment' : 'user'; await this.openCamera(); }
  stop() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.slots = [this.slot(), this.slot()];
  }
  say(t) { if (this.status.textContent !== t) this.status.textContent = t; }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const k = Math.max(this.W / vw, this.H / vh);
    this.map = { k, ox: (this.W - vw * k) / 2, oy: (this.H - vh * k) / 2, vw, vh };
  }

  // ---------- detecção (assíncrona, no ritmo que o aparelho aguentar) ----------
  async detectLoop() {
    while (this.running) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        if (this.map.vw !== v.videoWidth) this.resize();
        try { this.update(await this.detect(v)); } catch (e) { console.warn(e); }
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  async detect(v) {
    const vw = v.videoWidth, vh = v.videoHeight, sc = S / Math.max(vw, vh);
    const dw = vw * sc, dh = vh * sc, px = (S - dw) / 2, py = (S - dh) / 2;
    const c = this.prex;
    c.fillStyle = '#727272'; c.fillRect(0, 0, S, S);
    c.drawImage(v, px, py, dw, dh);
    const d = c.getImageData(0, 0, S, S).data, inp = this.input, N = S * S;
    for (let i = 0, j = 0; i < N; i++, j += 4) { inp[i] = d[j] / 255; inp[i + N] = d[j + 1] / 255; inp[i + 2 * N] = d[j + 2] / 255; }
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) });
    const o = out[this.session.outputNames[0]], A = o.dims[2], data = o.data;   // [1, 4+601, A]
    const dets = [], legs = [];
    const box = (a, s) => {
      const cx = data[a], cy = data[A + a], w = data[2 * A + a], h = data[3 * A + a];
      return { s, x: (cx - w / 2 - px) / dw, y: (cy - h / 2 - py) / dh, w: w / dw, h: h / dh };   // 0..1 do vídeo
    };
    for (let a = 0; a < A; a++) {
      let best = 0;
      for (const k in CLASSES) { const s = data[(4 + +k) * A + a]; if (s >= CLASSES[k] && s > best) best = s; }
      if (best) {
        const b = box(a, best);
        // descarta "fatias" coladas na borda (pé de cadeira, objetos cortados)
        const edge = b.x < 0.01 || b.x + b.w > 0.99;
        if (!(edge && b.w < 0.12) && b.w > 0.04 && b.h > 0.03) dets.push(b);
      }
      const ls = data[(4 + LEG) * A + a];
      if (ls > LEG_CONF) legs.push(box(a, ls));
    }
    const nms = (arr, n) => { arr.sort((a, b) => b.s - a.s); const k = []; for (const d2 of arr) { if (k.every((q) => iou(q, d2) < 0.4)) k.push(d2); if (k.length === n) break; } return k; };
    const feet = nms(dets, 2), lg = nms(legs, 2);
    // lado do bico: o calcanhar fica embaixo da perna -> o bico aponta para o lado oposto
    for (const f of feet) {
      const fx = f.x + f.w / 2, fy = f.y;
      const leg = lg.filter((l) => l.y < fy + f.h * 0.5).sort((a, b) => Math.abs(a.x + a.w / 2 - fx) - Math.abs(b.x + b.w / 2 - fx))[0];
      if (leg) f.toeRight = (leg.x + leg.w / 2) < fx;
    }
    return feet;
  }
  update(dets) {
    const now = performance.now();
    // ordena por x para manter cada pé no seu "slot" (esquerdo / direito na tela)
    dets.sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));
    if (dets.length === 1) {
      // um só pé: vai para o slot mais próximo do último visto
      const d = dets[0], cx = d.x + d.w / 2;
      const dist = this.slots.map((s) => s.box ? Math.abs(s.box.x + s.box.w / 2 - cx) : 9);
      const i = dist[0] <= dist[1] ? 0 : 1;
      this.slots[i].target = d; this.slots[i].seen = now;
    } else dets.forEach((d, i) => { this.slots[i].target = d; this.slots[i].seen = now; });
    for (const s of this.slots) if (s.target && s.target.toeRight !== undefined && now - s.seen < 50) s.toeVote = Math.max(-1, Math.min(1, (s.toeVote || 0) * 0.7 + (s.target.toeRight ? 0.3 : -0.3)));
    const n = this.slots.filter((s) => now - s.seen < 400).length;
    this.say(n === 2 ? 'Tênis calçados ✓' : n === 1 ? 'Mostre os dois pés' : 'Aponte para os seus pés');
  }

  // ---------- desenho (60 fps, interpolando entre as detecções) ----------
  loop() {
    if (!this.running) return;
    this.draw();
    this.raf = requestAnimationFrame(() => this.loop());
  }
  toScreen(b) {
    const m = this.map;
    return { x: b.x * m.vw * m.k + m.ox, y: b.y * m.vh * m.k + m.oy, w: b.w * m.vw * m.k, h: b.h * m.vh * m.k };
  }
  draw() {
    const c = this.ctx, now = performance.now();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    if (!this.imgs) return;
    const fade = this.prevImgs ? Math.min((now - this.swapT) / 280, 1) : 1;
    this.slots.forEach((s, i) => {
      const visible = s.target && now - s.seen < 400;
      s.alpha += ((visible ? 1 : 0) - s.alpha) * 0.2;
      if (!s.target) return;
      const t = this.toScreen(s.target);
      if (!s.box) s.box = { ...t };
      for (const k of ['x', 'y', 'w', 'h']) s.box[k] += (t[k] - s.box[k]) * 0.35;
      if (s.alpha < 0.02) return;
      const toeRight = (s.toeVote ?? 1) >= 0;
      if (fade < 1 && this.prevImgs) this.drawShoe(c, s.box, i, this.prevImgs, s.alpha * (1 - fade), toeRight);
      this.drawShoe(c, s.box, i, this.imgs, s.alpha * fade, toeRight);
    });
  }
  drawShoe(c, b, i, imgs, alpha, toeRight) {
    const vertical = b.h > b.w * 0.85;      // vista de cima: pé "em pé" na tela
    c.save(); c.globalAlpha = alpha;
    if (vertical) {
      const im = i === 0 ? imgs.tL : imgs.tR;
      const h = b.h * 1.12, w = h * im.width / im.height;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      // sombra
      shadow(c, cx, cy + h * 0.04, w * 0.62, h * 0.56, 0.32);
      c.drawImage(im, cx - w / 2, cy - h / 2, w, h);
    } else {
      // bico para a direita -> foto interna (já tem o bico à direita); para a esquerda -> foto externa
      const right = toeRight !== this.flip, im = right ? imgs.med : imgs.lat;
      const w = b.w * 1.18, h = w * im.height / im.width;
      const cx = b.x + b.w / 2, by = b.y + b.h;
      shadow(c, cx, by - h * 0.02, w * 0.56, h * 0.13, 0.34);
      c.translate(cx, by);
      c.drawImage(im, -w / 2, -h, w, h);
    }
    c.restore();
  }
  toggleFlip() { this.flip = !this.flip; }

  async snapshot() {
    const W = this.W, H = this.H, dpr = this.dpr;
    const cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
    const x = cv.getContext('2d'); x.scale(dpr, dpr);
    if (this.facing === 'user') { x.translate(W, 0); x.scale(-1, 1); }
    const m = this.map;
    x.drawImage(this.video, m.ox, m.oy, m.vw * m.k, m.vh * m.k);
    x.drawImage(this.canvas, 0, 0, W, H);
    return new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
  }
}
