// Vitrine 3D — Provador no pé (protótipo)
// Câmera + detecção de pose (MediaPipe Pose Landmarker, roda no navegador) para encontrar
// calcanhar, ponta do pé e tornozelo, e three.js para "calçar" o modelo 3D do tênis em cada pé.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// índices BlazePose
const L = { knee: 25, ankle: 27, heel: 29, toe: 31 };
const R = { knee: 26, ankle: 28, heel: 30, toe: 32 };

// pontos do modelo (metros, eixo x: bico em -x, calcanhar em +x; y para cima)
const M_HEEL = new THREE.Vector3(0.135, 0.03, 0);
const M_TOE = new THREE.Vector3(-0.08, 0.03, 0);   // "foot_index" fica na base dos dedos

let landmarkerP = null;
function getLandmarker() {
  landmarkerP ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    try { return await PoseLandmarker.createFromOptions(vision, opts('GPU')); }
    catch { return await PoseLandmarker.createFromOptions(vision, opts('CPU')); }
  })();
  return landmarkerP;
}

export class TryOn {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('video');
    this.stage = root.querySelector('.to-stage');
    this.status = root.querySelector('.to-status');
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.stage.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(0, 1, 0, -1, -5000, 5000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(300, 800, 900); this.scene.add(dl);
    this.feet = [this.makeFoot(), this.makeFoot()];
    this.facing = 'environment';
    addEventListener('resize', () => this.resize());
  }
  makeFoot() {
    const pivot = new THREE.Group(); pivot.visible = false;
    const holder = new THREE.Group(); pivot.add(holder);
    // sombra de contato
    const sh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.scale.set(0.2, 0.065, 1); sh.position.set(0.02, 0.002, 0);
    holder.add(sh);
    this.scene.add(pivot);
    return { pivot, holder, shoe: null, ready: false, pos: null, quat: new THREE.Quaternion(), s: 0, alpha: 0 };
  }
  async setModel(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.feet.forEach((f) => {
      if (f.shoe) f.holder.remove(f.shoe);
      const s = gltf.scene.clone(true);
      s.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.side = THREE.DoubleSide; o.material.transparent = true; } });
      f.shoe = s; f.holder.add(s);
    });
  }
  async start() {
    this.running = true;
    this.say('Abrindo a câmera…');
    await this.openCamera();
    this.say('Carregando o provador…');
    this.lm = await getLandmarker();
    this.say('Aponte para os seus pés');
    this.resize();
    this.lastT = -1;
    const loop = () => { if (!this.running) return; this.frame(); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  async openCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.playsInline = true; this.video.muted = true;
    await this.video.play();
    await new Promise((r) => this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true }));
    this.root.classList.toggle('mirror', this.facing === 'user');
    this.resize();
  }
  async flip() { this.facing = this.facing === 'user' ? 'environment' : 'user'; await this.openCamera(); }
  stop() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.feet.forEach((f) => { f.pivot.visible = false; f.pos = null; f.alpha = 0; });
  }
  say(t) { this.status.textContent = t; }
  resize() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    this.W = W; this.H = H;
    this.renderer.setSize(W, H);
    Object.assign(this.cam, { left: 0, right: W, top: 0, bottom: -H }); this.cam.updateProjectionMatrix();
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const k = Math.max(W / vw, H / vh);                // mesmo enquadramento do object-fit: cover
    this.map = { k, ox: (W - vw * k) / 2, oy: (H - vh * k) / 2, vw, vh };
  }
  px(p) { const m = this.map; return new THREE.Vector2(p.x * m.vw * m.k + m.ox, p.y * m.vh * m.k + m.oy); }
  w3(p) { return new THREE.Vector3(p.x, -p.y, -p.z); }   // mundo MediaPipe → three (y p/ cima, z p/ câmera)

  frame() {
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastT) {
      this.lastT = v.currentTime;
      if (this.map.vw !== v.videoWidth) this.resize();
      const res = this.lm.detectForVideo(v, performance.now());
      const lm = res.landmarks?.[0], wl = res.worldLandmarks?.[0];
      let seen = 0;
      [L, R].forEach((idx, i) => {
        const f = this.feet[i];
        const vis = lm && Math.min(lm[idx.heel].visibility ?? 1, lm[idx.toe].visibility ?? 1, lm[idx.ankle].visibility ?? 1);
        if (!lm || vis < 0.45) { f.target = null; return; }
        seen++;
        const other = i === 0 ? R : L;
        f.target = this.solve(lm, wl, idx, other);
      });
      this.say(seen ? (seen === 2 ? 'Tênis calçados ✓' : 'Mostre os dois pés') : 'Aponte para os seus pés, de lado, a ~1 m');
    }
    // suavização (posição, escala, rotação) e fade in/out
    this.feet.forEach((f) => {
      const t = f.target;
      f.alpha += ((t ? 1 : 0) - f.alpha) * 0.18;
      if (t) {
        if (!f.pos) { f.pos = t.pos.clone(); f.s = t.s; f.quat.copy(t.quat); f.mirror = t.mirror; }
        f.pos.lerp(t.pos, 0.5); f.s += (t.s - f.s) * 0.4; f.quat.slerp(t.quat, 0.4); f.mirror = t.mirror;
      }
      f.pivot.visible = f.alpha > 0.02 && !!f.pos && !!f.shoe;
      if (!f.pivot.visible) return;
      f.pivot.position.copy(f.pos);
      f.pivot.quaternion.copy(f.quat);
      f.pivot.scale.set(f.s, f.s, f.s * (f.mirror ? -1 : 1));
      f.holder.traverse((o) => { if (o.material && o.material.opacity !== undefined && o.material !== undefined) o.material.opacity = o.isMesh && o.geometry.type === 'CircleGeometry' ? 0.22 * f.alpha : f.alpha; });
    });
    this.renderer.render(this.scene, this.cam);
  }

  // calcula pose do tênis para um pé
  solve(lm, wl, idx, other) {
    const H2 = this.px(lm[idx.heel]), T2 = this.px(lm[idx.toe]), A2 = this.px(lm[idx.ankle]);
    // orientação 3D a partir das coordenadas de mundo (metros)
    const h = this.w3(wl[idx.heel]), t = this.w3(wl[idx.toe]), a = this.w3(wl[idx.ankle]);
    const fwd = t.clone().sub(h).normalize();
    const up0 = a.clone().sub(h);
    const up = up0.sub(fwd.clone().multiplyScalar(up0.dot(fwd))).normalize();
    const xm = fwd.clone().negate();                 // modelo: bico em −x
    const zm = new THREE.Vector3().crossVectors(xm, up);
    const rot = new THREE.Matrix4().makeBasis(xm, up, zm);
    const quat = new THREE.Quaternion().setFromRotationMatrix(rot);
    // lado de fora do pé: o lado lateral (foto externa) deve ficar para fora
    const outward = h.clone().sub(this.w3(wl[other.heel])); outward.y = 0;
    const mirror = zm.dot(outward) < 0;
    // escala: px por metro, pela projeção do vetor calcanhar→dedos do próprio modelo
    const vModel = M_TOE.clone().sub(M_HEEL).applyQuaternion(quat);
    const projLen = Math.hypot(vModel.x, vModel.y);
    const scr = T2.clone().sub(H2).length();
    let s;
    if (projLen > 0.25 * vModel.length()) s = scr / projLen;
    else {   // pé apontado para a câmera: usa a canela como régua
      const K2 = this.px(lm[idx.knee]), shin = this.w3(wl[idx.knee]).distanceTo(a);
      s = K2.distanceTo(A2) / Math.max(shin, 0.2);
    }
    // posiciona: o calcanhar do modelo vai sobre o calcanhar detectado
    const heelOff = M_HEEL.clone().multiply(new THREE.Vector3(1, 1, mirror ? -1 : 1)).applyQuaternion(quat).multiplyScalar(s);
    const pos = new THREE.Vector3(H2.x - heelOff.x, -H2.y - heelOff.y, 0);
    return { pos, quat, s, mirror };
  }

  // foto: vídeo + tênis num único JPEG
  async snapshot() {
    const W = this.W, H = this.H, dpr = Math.min(devicePixelRatio, 2);
    const c = document.createElement('canvas'); c.width = W * dpr; c.height = H * dpr;
    const x = c.getContext('2d'); x.scale(dpr, dpr);
    if (this.facing === 'user') { x.translate(W, 0); x.scale(-1, 1); }
    const m = this.map;
    x.drawImage(this.video, m.ox, m.oy, m.vw * m.k, m.vh * m.k);
    x.drawImage(this.renderer.domElement, 0, 0, W, H);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  }
}
