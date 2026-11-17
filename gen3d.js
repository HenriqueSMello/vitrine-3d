// Vitrine 3D — gera um modelo .glb a partir de duas fotos recortadas (fundo transparente):
//   lateral  = lado externo, bico para a ESQUERDA
//   medial   = lado interno, bico para a DIREITA
// A silhueta lateral vira a geometria; a forma é "inflada" pela transformada de distância
// (bordas arredondadas, laterais quase planas) e recebe as fotos como textura.
// Saída: Blob GLB (glTF 2.0 binário) em escala real, pronto para <model-viewer> / AR.

const LENGTH_M = 0.30;   // comprimento do tênis (m)
const HALF_W = 0.050;    // meia-largura máxima (m)
const GRID = 240;       // resolução da malha ao longo do comprimento

const loadImg = (src) => new Promise((res, rej) => {
  const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
});

function maskFrom(img, gw, gh) {
  const c = new OffscreenCanvas(gw, gh), x = c.getContext('2d');
  x.drawImage(img, 0, 0, gw, gh);
  const d = x.getImageData(0, 0, gw, gh).data, m = new Uint8Array(gw * gh);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  return m;
}

// Transformada de distância (chanfro 3-4) — distância até a borda da silhueta, em células
function distance(m, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? INF : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : d[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

// Atlas 2048x1024 [lateral | medial], com "sangria" de cor para não aparecer borda escura
async function buildAtlas(lat, med) {
  const S = 1024, c = new OffscreenCanvas(2 * S, S), x = c.getContext('2d');
  x.fillStyle = '#888'; x.fillRect(0, 0, 2 * S, S);
  const rects = [];
  [lat, med].forEach((im, i) => {
    const sc = Math.min(S / im.width, S / im.height) * 0.96;
    const w = Math.round(im.width * sc), h = Math.round(im.height * sc);
    const ox = i * S + ((S - w) >> 1), oy = (S - h) >> 1;
    for (let r = 14; r >= 1; r -= 2)
      for (let a = 0; a < 8; a++)
        x.drawImage(im, ox + Math.round(Math.cos(a * Math.PI / 4) * r), oy + Math.round(Math.sin(a * Math.PI / 4) * r), w, h);
    x.drawImage(im, ox, oy, w, h);
    rects.push([ox, oy, w, h]);
  });
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), rects, W: 2 * S, H: S };
}

function buildMesh(lat, atlas) {
  const gw = GRID, gh = Math.round(GRID * lat.height / lat.width);
  const m = maskFrom(lat, gw, gh), d = distance(m, gw, gh);
  const D = Math.max(gh * 0.22, 4), px = LENGTH_M / gw;
  const idx = new Int32Array(gw * gh).fill(-1);
  const P = [], U = [];
  let n = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x; if (!m[i]) continue;
    idx[i] = n++;
    const t = x / (gw - 1);                       // 0 bico → 1 calcanhar
    let wc = 0.82 + 0.18 * Math.sin(Math.min(Math.max((1 - t) * 1.25, 0), 1) * Math.PI / 2);
    if (t > 0.8) wc *= 1 - (t - 0.8) * 0.9;
    const hn = 1 - y / (gh - 1);                  // 0 sola → 1 topo
    const hc = 1 - 0.28 * Math.max(hn - 0.35, 0) / 0.65;
    const prof = Math.sqrt(Math.min(Math.max((d[i] - 0.5) / D, 0), 1));
    P.push(x * px - LENGTH_M / 2, (gh - 1 - y) * px, HALF_W * prof * wc * hc);
    U.push(x / (gw - 1), y / (gh - 1));
  }
  // suaviza o contorno (tira o "serrilhado" da grade): Laplaciano só nos vértices de borda
  const isB = (x, y) => m[y * gw + x] && (x === 0 || y === 0 || x === gw - 1 || y === gh - 1 ||
    !m[y * gw + x - 1] || !m[y * gw + x + 1] || !m[(y - 1) * gw + x] || !m[(y + 1) * gw + x]);
  const bnd = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (isB(x, y)) {
    const nb = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < gw && Y < gh && isB(X, Y)) nb.push(idx[Y * gw + X]);
    }
    if (nb.length) bnd.push([idx[y * gw + x], nb]);
  }
  for (let it = 0; it < 6; it++) {
    const upd = bnd.map(([v, nb]) => {
      let sx = 0, sy = 0; nb.forEach((k) => { sx += P[k * 3]; sy += P[k * 3 + 1]; });
      return [v, P[v * 3] * 0.5 + sx / nb.length * 0.5, P[v * 3 + 1] * 0.5 + sy / nb.length * 0.5];
    });
    upd.forEach(([v, x, y]) => { P[v * 3] = x; P[v * 3 + 1] = y; });
  }
  const [[lx, ly, lw, lh], [mx, my, mw, mh]] = atlas.rects, AW = atlas.W, AH = atlas.H;
  const pos = new Float32Array(n * 6), uv = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const X = P[k * 3], Y = P[k * 3 + 1], Z = P[k * 3 + 2];
    const un = (X + LENGTH_M / 2) / px / (gw - 1), vn = (gh - 1 - Y / px) / (gh - 1);
    pos.set([X, Y, Z], k * 3); pos.set([X, Y, -Z], (k + n) * 3);
    uv.set([(lx + un * lw) / AW, (ly + vn * lh) / AH], k * 2);              // frente: lateral
    uv.set([(mx + (1 - un) * mw) / AW, (my + vn * mh) / AH], (k + n) * 2);  // verso: medial
  }
  const F = [];
  for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
    const a = idx[y * gw + x], b = idx[y * gw + x + 1], c = idx[(y + 1) * gw + x], e = idx[(y + 1) * gw + x + 1];
    if (a < 0 || b < 0 || c < 0 || e < 0) continue;
    F.push(a, c, b, b, c, e);                                   // frente (+z)
    F.push(a + n, b + n, c + n, b + n, e + n, c + n);           // verso (−z)
  }
  const ind = new Uint32Array(F);
  // normais suaves
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < ind.length; i += 3) {
    const [A, B, C] = [ind[i] * 3, ind[i + 1] * 3, ind[i + 2] * 3];
    const ux = pos[B] - pos[A], uy = pos[B + 1] - pos[A + 1], uz = pos[B + 2] - pos[A + 2];
    const vx = pos[C] - pos[A], vy = pos[C + 1] - pos[A + 1], vz = pos[C + 2] - pos[A + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const V of [A, B, C]) { nor[V] += nx; nor[V + 1] += ny; nor[V + 2] += nz; }
  }
  for (let i = 0; i < nor.length; i += 3) {
    const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]) || 1;
    nor[i] /= l; nor[i + 1] /= l; nor[i + 2] /= l;
  }
  return { pos, nor, uv, ind };
}

function packGLB({ pos, nor, uv, ind }, img) {
  const pad4 = (n) => (n + 3) & ~3;
  const parts = [pos, nor, uv, ind, img];
  const views = []; let off = 0;
  parts.forEach((p) => { views.push({ byteOffset: off, byteLength: p.byteLength }); off = pad4(off + p.byteLength); });
  const bin = new Uint8Array(off);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer ?? p, p.byteOffset ?? 0, p.byteLength), views[i].byteOffset));
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const json = {
    asset: { version: '2.0', generator: 'Vitrine 3D photo-to-glb' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'tenis' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.6 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 4, mimeType: 'image/jpeg' }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: views.map((v, i) => ({ buffer: 0, ...v, ...(i < 3 ? { target: 34962 } : i === 3 ? { target: 34963 } : {}) })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: ind.length, type: 'SCALAR' },
    ],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jl = pad4(js.length), jsP = new Uint8Array(jl).fill(0x20); jsP.set(js);
  const total = 12 + 8 + jl + 8 + bin.byteLength, out = new ArrayBuffer(total), dv = new DataView(out);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); new Uint8Array(out, 20).set(jsP);
  dv.setUint32(20 + jl, bin.byteLength, true); dv.setUint32(24 + jl, 0x004E4942, true);
  new Uint8Array(out, 28 + jl).set(bin);
  return new Blob([out], { type: 'model/gltf-binary' });
}

const cache = new Map();

/** Gera (ou devolve do cache) a URL blob do .glb. onStep(i) reporta o progresso 0..3. */
export async function generateModel(latSrc, medSrc, onStep = () => {}) {
  const key = latSrc + '|' + medSrc;
  if (cache.has(key)) return cache.get(key);
  onStep(0);
  const [lat, med] = await Promise.all([loadImg(latSrc), loadImg(medSrc)]);
  await new Promise(requestAnimationFrame);
  onStep(1);
  const atlas = await buildAtlas(lat, med);
  onStep(2);
  await new Promise(requestAnimationFrame);
  const mesh = buildMesh(lat, atlas);
  onStep(3);
  const url = URL.createObjectURL(packGLB(mesh, atlas.bytes));
  cache.set(key, url);
  return url;
}
