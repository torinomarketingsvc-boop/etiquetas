/* Cenas 3D (Three.js): fundo do login e o prédio de estoque interativo */
import * as THREE from './vendor/three.module.js';
import { esc } from './ui.js';

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

function makeLabelTexture(floorCode, accent) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f8fafc';
  g.beginPath();
  g.roundRect(6, 6, 500, 244, 22);
  g.fill();
  g.fillStyle = accent;
  g.fillRect(6, 6, 500, 14);
  g.fillStyle = '#0f172a';
  g.beginPath();
  g.roundRect(28, 44, 130, 120, 14);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '900 78px Segoe UI, Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(floorCode, 93, 98);
  g.font = '700 18px Segoe UI, Arial';
  g.fillText('ANDAR', 93, 148);
  g.textAlign = 'left';
  g.fillStyle = '#0f172a';
  g.font = '800 40px Segoe UI, Arial';
  g.fillText('SKU-' + Math.floor(1000 + Math.random() * 8999), 180, 74);
  g.fillStyle = '#475569';
  g.font = '500 24px Segoe UI, Arial';
  g.fillText('Lote L-' + Math.floor(100 + Math.random() * 899), 180, 116);
  g.fillText('END A-0' + Math.floor(1 + Math.random() * 9), 180, 150);
  g.fillStyle = '#0f172a';
  let x = 30;
  while (x < 478) {
    const w = 2 + Math.floor(Math.random() * 6);
    g.fillRect(x, 186, w, 46);
    x += w + 2 + Math.floor(Math.random() * 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Cena do login: torre de estoque com andares, etiquetas flutuando    */
/* ------------------------------------------------------------------ */
export function createLoginScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const BG = new THREE.Color('#050816');
  scene.background = BG;
  scene.fog = new THREE.Fog(BG, 20, 52);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 140);

  scene.add(new THREE.HemisphereLight(0x8ab4ff, 0x0b0b25, 1.3));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(8, 18, 10);
  scene.add(key);
  const cyan = new THREE.PointLight(0x22d3ee, 90, 34, 2);
  cyan.position.set(-7, 6, 6);
  scene.add(cyan);
  const violet = new THREE.PointLight(0xa855f7, 90, 34, 2);
  violet.position.set(8, 4, -6);
  scene.add(violet);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(48, 64),
    new THREE.MeshStandardMaterial({ color: 0x070c1f, roughness: 0.85, metalness: 0.3 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  const grid = new THREE.GridHelper(80, 80, 0x1d4ed8, 0x0f1e46);
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  scene.add(grid);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(5.4, 5.56, 96),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);
  const ring2 = ring.clone();
  ring2.material = ring.material.clone();
  ring2.scale.setScalar(1.35);
  ring2.material.opacity = 0.25;
  scene.add(ring2);

  const tower = new THREE.Group();
  scene.add(tower);
  const FLOORS = 5;
  const FH = 1.6;
  const W = 6.4;
  const D = 4.4;
  const palette = [0x22d3ee, 0xa78bfa, 0xf472b6, 0xfbbf24, 0x34d399];

  const slabGeo = new THREE.BoxGeometry(W, 0.16, D);
  const slabEdges = new THREE.EdgesGeometry(slabGeo);
  const volGeo = new THREE.BoxGeometry(W - 0.06, FH - 0.16, D - 0.06);
  const volEdges = new THREE.EdgesGeometry(volGeo);
  const shelfGeo = new THREE.BoxGeometry(W - 1.3, 0.05, 0.56);
  const postGeo = new THREE.BoxGeometry(0.05, 1.25, 0.05);
  const boxGeo = new THREE.BoxGeometry(0.34, 0.27, 0.34);
  const rackMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.75, roughness: 0.35 });
  const boxMat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 });
  const cardboard = [0xd97706, 0xb45309, 0xf59e0b, 0xc2410c, 0xe0a458];
  const dummy = new THREE.Object3D();
  const floorObjs = [];

  for (let i = 0; i < FLOORS; i++) {
    const g = new THREE.Group();
    g.position.y = i * FH;
    tower.add(g);
    const color = new THREE.Color(palette[i % palette.length]);
    const slab = new THREE.Mesh(
      slabGeo,
      new THREE.MeshStandardMaterial({ color: 0x0b1226, metalness: 0.65, roughness: 0.3, emissive: color, emissiveIntensity: 0.05 })
    );
    g.add(slab);
    const edge = new THREE.LineSegments(slabEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    g.add(edge);
    const vol = new THREE.Mesh(
      volGeo,
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity: 0.04,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    vol.position.y = FH / 2;
    g.add(vol);
    const volLine = new THREE.LineSegments(volEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.16 }));
    volLine.position.y = FH / 2;
    g.add(volLine);

    const racks = 3;
    const boxes = new THREE.InstancedMesh(boxGeo, boxMat, racks * 2 * 10);
    let k = 0;
    for (let r = 0; r < racks; r++) {
      const z = -D / 2 + 0.95 + r * ((D - 1.9) / (racks - 1));
      for (const px of [-(W - 1.3) / 2, (W - 1.3) / 2]) {
        for (const pz of [z - 0.26, z + 0.26]) {
          const post = new THREE.Mesh(postGeo, rackMat);
          post.position.set(px, 0.08 + 0.62, pz);
          g.add(post);
        }
      }
      for (let s = 0; s < 2; s++) {
        const sy = 0.22 + s * 0.62;
        const shelf = new THREE.Mesh(shelfGeo, rackMat);
        shelf.position.set(0, sy, z);
        g.add(shelf);
        for (let b = 0; b < 10; b++) {
          if (Math.random() < 0.18) continue;
          dummy.position.set(-(W - 1.3) / 2 + 0.3 + b * ((W - 1.9) / 9), sy + 0.16, z + (Math.random() - 0.5) * 0.08);
          dummy.rotation.set(0, (Math.random() - 0.5) * 0.25, 0);
          dummy.scale.setScalar(0.85 + Math.random() * 0.3);
          dummy.updateMatrix();
          boxes.setMatrixAt(k, dummy.matrix);
          boxes.setColorAt(k, new THREE.Color(cardboard[Math.floor(Math.random() * cardboard.length)]));
          k++;
        }
      }
    }
    boxes.count = k;
    g.add(boxes);
    floorObjs.push({ g, slab, edge, vol, volLine, k: 0 });
  }

  const roof = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: 0x0b1226, metalness: 0.7, roughness: 0.3 }));
  roof.position.y = FLOORS * FH;
  tower.add(roof);
  const roofEdge = new THREE.LineSegments(slabEdges, new THREE.LineBasicMaterial({ color: 0x67e8f9 }));
  roofEdge.position.y = FLOORS * FH;
  tower.add(roofEdge);

  const pillarGeo = new THREE.BoxGeometry(0.16, FLOORS * FH, 0.16);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8, roughness: 0.3 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(sx * (W / 2 - 0.08), (FLOORS * FH) / 2, sz * (D / 2 - 0.08));
      tower.add(p);
    }
  }

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x67e8f9 })
  );
  beacon.position.y = FLOORS * FH + 0.6;
  tower.add(beacon);
  const beaconLight = new THREE.PointLight(0x67e8f9, 30, 12, 2);
  beaconLight.position.copy(beacon.position);
  tower.add(beaconLight);

  const scanner = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.7, 0.025, D + 0.7),
    new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  tower.add(scanner);

  const codes = ['T', '1', '2', '3', '4'];
  const accents = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399'];
  const textures = codes.map((c, i) => makeLabelTexture(c, accents[i]));
  const labelGeo = new THREE.PlaneGeometry(1.6, 0.8);
  const floaters = [];
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(
      labelGeo,
      new THREE.MeshBasicMaterial({ map: textures[i % textures.length], side: THREE.DoubleSide, transparent: true, toneMapped: false })
    );
    scene.add(m);
    floaters.push({
      m,
      radius: 7.2 + Math.random() * 4.5,
      angle: (i / 16) * Math.PI * 2 + Math.random() * 0.3,
      y: 1 + Math.random() * 8,
      speed: 0.04 + Math.random() * 0.07,
      phase: Math.random() * 10,
    });
  }

  const N = 900;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 3 + Math.random() * 24;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 18;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.07, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scene.add(points);

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = (e) => {
    mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove);

  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // desloca a torre para a esquerda, deixando espaço para o cartão de login
    camera.setViewOffset(w, h, w * 0.035, 0, w, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let raf = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;

    tower.rotation.y = t * 0.11;
    const active = Math.floor(t / 2.4) % FLOORS;
    floorObjs.forEach((f, i) => {
      f.k += ((i === active ? 1 : 0) - f.k) * 0.07;
      f.vol.material.opacity = 0.035 + f.k * 0.17;
      f.volLine.material.opacity = 0.14 + f.k * 0.66;
      f.slab.material.emissiveIntensity = 0.05 + f.k * 0.55;
      f.g.position.x = f.k * 0.25;
    });
    scanner.position.y = (t * 1.3) % (FLOORS * FH);
    scanner.material.opacity = 0.18 + 0.14 * Math.sin(t * 7);
    beacon.scale.setScalar(1 + Math.sin(t * 4) * 0.25);
    ring.material.opacity = 0.45 + Math.sin(t * 2) * 0.25;
    ring2.scale.setScalar(1.25 + ((t * 0.25) % 0.6));
    ring2.material.opacity = 0.35 * (1 - ((t * 0.25) % 0.6) / 0.6);

    for (const f of floaters) {
      f.angle += f.speed * 0.012;
      f.m.position.set(Math.cos(f.angle) * f.radius, f.y + Math.sin(t * 0.8 + f.phase) * 0.45, Math.sin(f.angle) * f.radius);
      f.m.lookAt(camera.position);
      f.m.rotateZ(Math.sin(t * 0.6 + f.phase) * 0.18);
    }
    const arr = pGeo.attributes.position.array;
    for (let i = 1; i < arr.length; i += 3) {
      arr[i] += 0.012;
      if (arr[i] > 18) arr[i] = 0;
    }
    pGeo.attributes.position.needsUpdate = true;

    camera.position.set(Math.sin(mouse.x * 0.35) * 21, 8.5 - mouse.y * 2.2, Math.cos(mouse.x * 0.35) * 21);
    camera.lookAt(0, 4, 0);
    renderer.render(scene, camera);
  };
  tick();

  const onVis = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      tick();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  return {
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      disposeScene(scene);
      textures.forEach((t) => t.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Prédio de estoque interativo (painéis)                              */
/* floors: [{id, name, code, color, total, printed}] de baixo p/ cima   */
/* ------------------------------------------------------------------ */
export function createTower(container, { floors, highlightId = null, highlightIds = null, onSelect = null, silent = false } = {}) {
  const hlIds = new Set(highlightIds || (highlightId ? [highlightId] : []));
  container.innerHTML = '';
  if (!floors || !floors.length) {
    container.innerHTML = '<div class="tower-empty">Cadastre os andares para visualizar o prédio.</div>';
    return { dispose() {} };
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'tower-canvas';
  const overlay = document.createElement('div');
  overlay.className = 'tower-overlay';
  const tip = document.createElement('div');
  tip.className = 'tower-tip';
  container.append(canvas, overlay, tip);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight(0xa5c8ff, 0x0b0b25, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 2.2);
  dl.position.set(6, 14, 9);
  scene.add(dl);
  const pl = new THREE.PointLight(0x22d3ee, 40, 30, 2);
  pl.position.set(-6, 5, 6);
  scene.add(pl);

  const n = floors.length;
  const FH = 1.2;
  const W = 5.2;
  const D = 3.4;
  const BASE = 0.24;
  const HT = n * FH + BASE;

  const tower = new THREE.Group();
  scene.add(tower);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(4.3, 4.5, BASE, 64),
    new THREE.MeshStandardMaterial({ color: 0x0b1226, metalness: 0.7, roughness: 0.35 })
  );
  base.position.y = BASE / 2;
  scene.add(base);
  const baseRing = new THREE.Mesh(
    new THREE.TorusGeometry(4.4, 0.03, 8, 96),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.8 })
  );
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = BASE;
  scene.add(baseRing);

  const slabGeo = new THREE.BoxGeometry(W, 0.14, D);
  const slabEdges = new THREE.EdgesGeometry(slabGeo);
  const volGeo = new THREE.BoxGeometry(W - 0.05, FH - 0.14, D - 0.05);
  const volEdges = new THREE.EdgesGeometry(volGeo);
  const boxGeo = new THREE.BoxGeometry(0.3, 0.24, 0.3);
  const gray = new THREE.Color(0x3b4a63);
  const dummy = new THREE.Object3D();
  const objs = [];
  const pickables = [];

  floors.forEach((f, i) => {
    const color = new THREE.Color(f.color || '#22d3ee');
    const g = new THREE.Group();
    const targetY = BASE + i * FH;
    g.position.y = silent ? targetY : targetY + 7 + i * 1.2;
    tower.add(g);
    const slab = new THREE.Mesh(
      slabGeo,
      new THREE.MeshStandardMaterial({ color: 0x0d1630, metalness: 0.6, roughness: 0.32, emissive: color, emissiveIntensity: 0.08 })
    );
    slab.position.y = 0.07;
    g.add(slab);
    const edge = new THREE.LineSegments(slabEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    edge.position.y = 0.07;
    g.add(edge);
    const vol = new THREE.Mesh(
      volGeo,
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 0.3, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    vol.position.y = FH / 2 + 0.07;
    vol.userData.index = i;
    g.add(vol);
    pickables.push(vol);
    const volLine = new THREE.LineSegments(volEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 }));
    volLine.position.y = vol.position.y;
    g.add(volLine);

    const total = Number(f.total) || 0;
    const printed = Number(f.printed) || 0;
    const ratio = total ? printed / total : 0;
    const count = total ? Math.max(1, Math.min(36, total)) : 0;
    if (count) {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
      const inst = new THREE.InstancedMesh(boxGeo, mat, count);
      const lit = Math.round(count * ratio);
      const cols = Math.min(12, count);
      const gap = 0.4;
      for (let k = 0; k < count; k++) {
        const cx = k % cols;
        const cz = Math.floor(k / cols);
        dummy.position.set(-((cols - 1) * gap) / 2 + cx * gap, 0.27, D / 2 - 0.65 - cz * 0.5);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        inst.setMatrixAt(k, dummy.matrix);
        inst.setColorAt(k, k < lit ? color : gray);
      }
      g.add(inst);
    }
    if (f.total !== null && f.total !== undefined) {
      const trackLen = W - 0.5;
      const track = new THREE.Mesh(
        new THREE.BoxGeometry(trackLen, 0.07, 0.07),
        new THREE.MeshBasicMaterial({ color: 0x1e293b })
      );
      track.position.set(0, 0.2, D / 2 + 0.12);
      g.add(track);
      if (ratio > 0) {
        const fill = new THREE.Mesh(
          new THREE.BoxGeometry(trackLen * ratio, 0.09, 0.09),
          new THREE.MeshBasicMaterial({ color })
        );
        fill.position.set(-trackLen / 2 + (trackLen * ratio) / 2, 0.2, D / 2 + 0.12);
        g.add(fill);
      }
    }
    objs.push({ g, slab, edge, vol, volLine, targetY, f, h: 0 });
  });

  const roof = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: 0x0d1630, metalness: 0.7, roughness: 0.3 }));
  const roofEdge = new THREE.LineSegments(slabEdges, new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.8 }));
  const roofY = BASE + n * FH + 0.07;
  roof.position.y = silent ? roofY : roofY + 9 + n * 1.2;
  roofEdge.position.y = roof.position.y;
  tower.add(roof, roofEdge);

  overlay.innerHTML = floors
    .map((f, i) => {
      const hasStats = f.total !== null && f.total !== undefined;
      const p = f.total ? Math.round((f.printed / f.total) * 100) : 0;
      return `<div class="tower-label${hlIds.has(f.id) ? ' hl' : ''}" data-i="${i}">
        <span class="dot" style="background:${esc(f.color)}"></span>
        <span class="tl-name">${esc(f.name)}</span>
        ${hasStats ? `<span class="tl-val">${f.total ? `${p}%` : '—'}</span>` : ''}
      </div>`;
    })
    .join('');
  const labelEls = [...overlay.querySelectorAll('.tower-label')];
  labelEls.forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.i)));
    el.addEventListener('pointerenter', () => (hovered = Number(el.dataset.i)));
    el.addEventListener('pointerleave', () => (hovered = -1));
  });

  let hovered = -1;
  const hlIndexes = new Set(floors.map((f, i) => (hlIds.has(f.id) ? i : -1)).filter((i) => i >= 0));
  let selected = hlIndexes.size === 1 ? [...hlIndexes][0] : -1;
  function select(i) {
    selected = i;
    labelEls.forEach((el, k) => el.classList.toggle('sel', k === i));
    if (onSelect && floors[i]) onSelect(floors[i]);
  }

  const LABEL_COL = 150;
  let cw = 1;
  let ch = 1;
  const resize = () => {
    cw = Math.max(1, container.clientWidth);
    ch = Math.max(1, container.clientHeight);
    renderer.setSize(cw, ch, false);
    const effW = Math.max(120, cw - LABEL_COL);
    camera.aspect = cw / ch;
    camera.setViewOffset(cw, ch, LABEL_COL / 2, 0, cw, ch);
    // enquadra a esfera que envolve o prédio + base
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (effW / ch));
    const radius = Math.hypot(4.6, HT / 2 + 0.3);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.88;
    const dir = new THREE.Vector3(0.55, 0.36, 0.85).normalize();
    camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, HT / 2, 0));
    camera.lookAt(0, HT / 2 - 0.2, 0);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let drag = null;
  let userRot = 0;
  let pointer = null;
  const onDown = (e) => {
    drag = { x: e.clientX, rot: userRot, moved: false };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    ndc.set((pointer.x / r.width) * 2 - 1, -(pointer.y / r.height) * 2 + 1);
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      userRot = drag.rot + dx * 0.008;
    }
  };
  const onUp = (e) => {
    if (drag && !drag.moved && hovered >= 0) select(hovered);
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  const onLeave = () => {
    pointer = null;
    hovered = -1;
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);

  const clock = new THREE.Clock();
  const v = new THREE.Vector3();
  let raf = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    tower.rotation.y = -0.35 + Math.sin(t * 0.35) * 0.22 + userRot;

    objs.forEach((o, i) => {
      if (Math.abs(o.g.position.y - o.targetY) > 0.001) {
        const delay = i * 0.12;
        const k = Math.min(1, Math.max(0, (t - delay) * 2.4));
        o.g.position.y += (o.targetY - o.g.position.y) * (0.06 + k * 0.1);
      }
      const isHL = hlIndexes.has(i);
      const isActive = i === hovered || i === selected;
      const target = isActive ? 1 : isHL ? 0.55 + 0.45 * Math.sin(t * 3) : 0;
      o.h += (target - o.h) * 0.12;
      const dim = hlIndexes.size && !isHL && !isActive ? 0.45 : 1;
      o.vol.material.opacity = (0.05 + o.h * 0.2) * (dim < 1 ? 0.7 : 1);
      o.volLine.material.opacity = (0.22 + o.h * 0.7) * dim;
      o.edge.material.opacity = 0.9 * dim;
      o.slab.material.emissiveIntensity = 0.08 + o.h * 0.7;
      const s = 1 + o.h * 0.035;
      o.g.scale.set(s, 1, s);
    });
    if (Math.abs(roof.position.y - roofY) > 0.001) {
      roof.position.y += (roofY - roof.position.y) * 0.07;
      roofEdge.position.y = roof.position.y;
    }
    baseRing.material.opacity = 0.55 + Math.sin(t * 2) * 0.25;

    if (pointer && !drag) {
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      const idx = hit ? hit.object.userData.index : -1;
      if (idx !== hovered && !labelEls.some((el) => el.matches(':hover'))) hovered = idx;
      canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    } else if (drag) canvas.style.cursor = 'grabbing';

    if (hovered >= 0 && pointer) {
      const f = floors[hovered];
      const hasStats = f.total !== null && f.total !== undefined;
      tip.innerHTML = `<b>${esc(f.name)}</b>${hasStats
        ? `<span>${f.printed || 0} de ${f.total || 0} etiquetas impressas</span>${f.analysts ? `<span>${f.analysts.length ? esc(f.analysts.join(', ')) : 'Nenhum analista'}</span>` : ''}`
        : ''}`;
      tip.style.transform = `translate(${Math.min(pointer.x + 14, cw - 220)}px, ${Math.max(0, pointer.y - 10)}px)`;
      tip.classList.add('show');
    } else tip.classList.remove('show');

    objs.forEach((o, i) => {
      v.set(0, o.g.position.y + FH / 2, 0);
      v.project(camera);
      const y = (-v.y * 0.5 + 0.5) * ch;
      const el = labelEls[i];
      el.style.transform = `translate(0, ${(y - 14).toFixed(1)}px)`;
      el.classList.toggle('hot', i === hovered);
    });

    renderer.render(scene, camera);
  };
  tick();

  const onVis = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      tick();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  return {
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      disposeScene(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      container.innerHTML = '';
    },
  };
}
