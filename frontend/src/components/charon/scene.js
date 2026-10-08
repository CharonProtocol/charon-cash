// The original Charon card geometry, layout, artwork and materials are preserved.
// Only the film clock/camera have been replaced with live pointer interactions.
import * as THREE from "./vendor/three.module.js";
import { vertex, backgroundFragment, cardFragment } from "./shaders.js";

const LANTERN = { x: -680, y: -950 };
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
const PEOPLE = [
  "Alex Morgan",
  "Maya Chen",
  "Arjun Mehta",
  "Elena Torres",
  "Noah Williams",
  "Sofia Reyes",
  "Kai Nakamura",
  "Olivia Brooks",
  "Dev Patel",
  "Luca Rossi",
  "Ava Thompson",
  "Ronda Rousey",
];
const ADDRESSES = [
  "8zB4…pQ7x",
  "4RX4…9sVp",
  "D3aF…k8Nm",
  "7nQe…a6Tk",
  "Bx5H…3cWm",
  "Gm9K…2fYa",
];
const AMOUNTS = [
  "104",
  "28.50",
  "12.80",
  "65",
  "210",
  "8.25",
  "42",
  "16.40",
  "95",
  "32.75",
  "180",
  "55",
];
const fontLoads = new Map();
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Could not load animation asset: ${src}`));
    image.src = src;
  });
}
function loadFont(base) {
  if (!fontLoads.has(base)) {
    const promise = (async () => {
      const face = new FontFace(
        "Charon Inter",
        `url("${base}/fonts/Inter.ttf")`,
        {
          weight: "100 900",
        },
      );
      await face.load();
      document.fonts.add(face);
    })();
    fontLoads.set(base, promise);
    promise.catch(() => fontLoads.delete(base));
  }
  return fontLoads.get(base);
}
function label(
  ctx,
  content,
  x,
  y,
  size,
  color,
  weight = 450,
  align = "left",
  family = '"Charon Inter"',
) {
  ctx.font = `${weight} ${size}px ${family}, Arial, sans-serif`;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(content, x, y);
}
function avatar(ctx, x, y, index, dark) {
  ctx.save();
  const fill = ctx.createLinearGradient(x - 28, y - 28, x + 28, y + 28);
  fill.addColorStop(0, dark ? "#989894" : "#f1e5d3");
  fill.addColorStop(1, dark ? "#65676a" : "#e2d1ba");
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = dark ? "#dedbd38a" : "#ffffff";
  ctx.lineWidth = 1.1;
  ctx.stroke();
  const tones = dark
    ? ["#e7e0d4", "#b6a998", "#746653"]
    : ["#fffaf1", "#b99c78", "#896b47"];
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 3; col++) {
      const seed = ((index + 9) * (row + 3) * 17 + col * 13 + row * 7) % 11;
      if (seed < 5) continue;
      ctx.fillStyle = tones[seed % 3];
      ctx.fillRect(x - 17.5 + col * 7, y - 17.5 + row * 7, 7, 7);
      if (col !== 2)
        ctx.fillRect(x - 17.5 + (4 - col) * 7, y - 17.5 + row * 7, 7, 7);
    }
  ctx.restore();
}
function dots(ctx, right, y, count, color) {
  ctx.fillStyle = color;
  for (let j = 0; j < count; j++) {
    ctx.beginPath();
    ctx.arc(right - j * 8.3, y, 2.35, 0, Math.PI * 2);
    ctx.fill();
  }
}
function makeInk(index, dark, solana) {
  const c = document.createElement("canvas");
  c.width = 2160;
  c.height = 474;
  const g = c.getContext("2d");
  g.scale(3, 3);
  const ink = dark ? "#f2f3f4" : "#263647",
    muted = dark ? "#c2c4c9" : "#93959d";
  label(g, `5F${index + 3}w9X…3kLm`, 25, 28, 14, muted, 400);
  avatar(g, 58, 79, index, dark);
  avatar(g, 662, 79, index + 4, dark);
  label(g, PEOPLE[index], 115, 66, 18, ink, 500);
  label(g, ADDRESSES[index % 6], 115, 91, 14, muted, 400);
  label(
    g,
    `−${AMOUNTS[index]} SOL`,
    115,
    128,
    20,
    dark ? "#ff806c" : "#f57360",
    500,
  );
  if (dark) {
    dots(g, 605, 60, 12, ink);
    dots(g, 605, 86, 14, ink);
    dots(g, 605, 123, 8, ink);
  } else {
    label(g, PEOPLE[(index + 1) % 12], 605, 66, 18, ink, 500, "right");
    label(g, ADDRESSES[(index + 1) % 6], 605, 91, 14, muted, 400, "right");
    label(g, `+${AMOUNTS[index]} SOL`, 605, 128, 20, "#54b890", 500, "right");
  }
  g.drawImage(solana, 333, 54, 54, 47);
  const texture = new THREE.CanvasTexture(c);
  texture.anisotropy = 4;
  // Shader ink is authored in display RGB; leave NoColorSpace to avoid double conversion.
  return texture;
}

export async function createCharonScene(host, options = {}) {
  const base = (options.assetBase ?? "").replace(/\/$/, "");
  const [solana, lanternOn, lanternOff] = await Promise.all([
    ...["solana.svg", "LanternOn.png", "LanternOff.png"].map((name) =>
      loadImage(`${base}/${name}`),
    ),
    loadFont(base),
  ]);
  // Asset loading may finish after a React route change or Strict Mode cleanup.
  if (options.signal?.aborted) return null;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 4000);
  camera.position.z = 2000;
  const common = {
    resolution: { value: new THREE.Vector2(1, 1) },
    lantern: { value: new THREE.Vector2(LANTERN.x, LANTERN.y) },
    radius: { value: -100 },
  };
  const background = new THREE.Mesh(
    new THREE.PlaneGeometry(24000, 16000),
    new THREE.ShaderMaterial({
      uniforms: common,
      vertexShader: vertex,
      fragmentShader: backgroundFragment,
      depthWrite: false,
    }),
  );
  background.position.z = -100;
  background.renderOrder = -10;
  scene.add(background);
  const inks = PEOPLE.map((_, i) => [
    makeInk(i, false, solana),
    makeInk(i, true, solana),
  ]);
  const geometry = new THREE.PlaneGeometry(800, 238);
  const cards = [];
  for (let row = -8; row <= 4; row++)
    for (let col = -5; col <= 5; col++) {
      const stagger = row % 2 === 0 ? 392 : 0;
      let x = col * 784 + stagger,
        y = row * 236;

      // Part the row to make room for center Solana logo
      if (row === 0) {
        if (col >= 0) x += 115;
        else x -= 115;
      }

      // Part the row to make room for lantern at (-680, -950)
      if (row === -4) {
        if (col >= -1) x += 220;
        else x -= 15;
      }
      const primary = row === 1 && col === 0;
      const seed = (row + 8) * 11 + col + 5;
      const i = primary ? 0 : seed % 12;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          ...common,
          publicText: { value: inks[i][0] },
          privateText: { value: inks[i][1] },
          opacity: { value: 1 },
          hover: { value: 0 },
        },
        vertexShader: vertex,
        fragmentShader: cardFragment,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, 0);
      scene.add(mesh);
      cards.push({ mesh, x, y, seed, primary, tappedAt: -100 });
    }
  const imageTextures = [];
  function sprite(image, w, h) {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    imageTextures.push(texture);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(m);
    return m;
  }
  const centerMark = sprite(solana, 170, 148);
  centerMark.position.set(0, 0, 10);
  const lampOn = sprite(lanternOn, 178, 241),
    lampOff = sprite(lanternOff, 178, 241);
  lampOn.renderOrder = 3;
  lampOff.renderOrder = 4;
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 256;
  const gc = glowCanvas.getContext("2d");
  const gg = gc.createRadialGradient(128, 128, 0, 128, 128, 128);
  gg.addColorStop(0, "#ffd18850");
  gg.addColorStop(0.35, "#ffcf7720");
  gg.addColorStop(1, "#ffcf7700");
  gc.fillStyle = gg;
  gc.fillRect(0, 0, 256, 256);
  const glow = sprite(glowCanvas, 400, 400);
  glow.position.set(LANTERN.x, LANTERN.y, -4);

  const canvas = renderer.domElement;
  canvas.style.cssText =
    "display:block;width:100%;height:100%;touch-action:none;cursor:grab;";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motion.matches;
  let destroyed = false;
  let visible = true;
  let paused = false;
  let elapsed = 7;
  let introTime = 0.45;
  let introComplete = false;
  let previous = 0;
  let raf = 0;
  let pointer = null;
  let drag = null;
  let privateMode = false;
  let privacy = 0;
  let waveTime = 100;
  let width = 1;
  let height = 1;
  let viewScale = 1;
  let panX = 0;
  let panY = -475;
  let cameraX = 0;
  let cameraY = -475;
  const cursorWorld = new THREE.Vector3();

  function draw(delta = 0) {
    if (destroyed) return;
    const still = reduced || paused;
    if (!still) elapsed += delta;
    introTime = still ? 3.2 : Math.min(3.2, introTime + delta);
    const intro = smooth((introTime - 0.45) / 2.75);
    if (!introComplete && introTime >= 3.2) {
      introComplete = true;
      options.onIntroComplete?.();
    }
    waveTime += delta;
    const targetX =
      panX + (!still && pointer && !drag ? (pointer.x / width - 0.5) * 65 : 0);
    const targetY =
      panY + (!still && pointer && !drag ? (0.5 - pointer.y / height) * 40 : 0);
    const follow = still ? 1 : 1 - Math.exp(-delta * 7);
    cameraX += (targetX - cameraX) * follow;
    cameraY += (targetY - cameraY) * follow;
    const endZoom = width < 640 ? 0.35 : 0.5;
    const startZoom = Math.max(
      endZoom * 1.3,
      Math.min(2.04, (width / viewScale / 800) * 0.95),
    );
    camera.position.set(
      cameraX * intro,
      236 * (1 - intro) + cameraY * intro,
      2000,
    );
    camera.zoom = startZoom + (endZoom - startZoom) * intro;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    background.position.set(cameraX, cameraY, -100);
    if (pointer) {
      cursorWorld
        .set((pointer.x / width) * 2 - 1, 1 - (pointer.y / height) * 2, 0)
        .unproject(camera);
    }
    const targetPrivacy = privateMode ? 1 : 0;
    privacy = still
      ? targetPrivacy
      : privacy + clamp(targetPrivacy - privacy, -delta / 0.4, delta / 1.8);
    common.radius.value = privacy === 0 ? -100 : 6100 * Math.pow(privacy, 1.15);

    for (const c of cards) {
      const px =
        c.x + (still ? 0 : Math.sin(elapsed * 0.64 + c.seed * 1.71) * 4);
      const py =
        c.y + (still ? 0 : Math.sin(elapsed * 0.78 + c.seed * 0.63) * 5);
      const hx = pointer ? (cursorWorld.x - px) / 360 : 10;
      const hy = pointer ? (cursorWorld.y - py) / 79 : 10;
      const hover =
        1 - smooth((Math.max(Math.abs(hx), Math.abs(hy)) - 0.4) / 0.8);
      const distance = Math.hypot(c.x - LANTERN.x, c.y - LANTERN.y);
      const arrival = 1.8 * Math.pow(distance / 6100, 1 / 1.15);
      const dt = waveTime - arrival;
      const jump =
        !still && privateMode && dt > 0 && dt < 1.5
          ? Math.sin(dt * 7) * Math.exp(-dt * 3.5)
          : 0;
      const tapAge = elapsed - c.tappedAt;
      const tap =
        !still && tapAge >= 0 && tapAge < 1.2
          ? Math.sin(tapAge * 12) * Math.exp(-tapAge * 4)
          : 0;
      const dirX = (c.x - LANTERN.x) / (distance + 0.1);
      const dirY = (c.y - LANTERN.y) / (distance + 0.1);
      c.mesh.position.set(
        px + dirX * jump * 200,
        py + hover * 4 + dirY * jump * 200 + tap * 22,
        hover * 14 + jump * 40,
      );
      c.mesh.rotation.set(
        (still ? 0 : Math.sin(elapsed * 0.6 + c.seed) * 0.006) -
          dirY * jump * 0.18,
        (still ? 0 : Math.sin(elapsed * 0.4 + c.seed) * 0.007) +
          dirX * jump * 0.18,
        still ? 0 : Math.sin(elapsed * 0.6 + c.seed) * 0.0025 + tap * 0.025,
      );
      c.mesh.scale.setScalar(1 + hover * 0.012 + jump * 0.05 + tap * 0.025);
      c.mesh.material.uniforms.hover.value = hover;
      c.mesh.material.uniforms.opacity.value = c.primary
        ? 1
        : smooth((introTime - 0.5) / 1.4);
      c.mesh.visible =
        Math.abs(px - camera.position.x) <
          width / viewScale / camera.zoom / 2 + 420 &&
        Math.abs(py - camera.position.y) <
          height / viewScale / camera.zoom / 2 + 150;
    }
    const lx = LANTERN.x + (still ? 0 : Math.sin(elapsed * 0.9) * 6);
    const ly = LANTERN.y + (still ? 0 : Math.sin(elapsed * 1.25) * 8);
    for (const lamp of [lampOn, lampOff]) {
      lamp.position.set(lx, ly, 8);
      lamp.rotation.z = still ? 0 : Math.sin(elapsed * 0.8) * 0.015;
    }
    lampOn.material.opacity = privateMode ? 0 : 1;
    lampOff.material.opacity = privateMode ? 1 : 0;
    glow.position.set(lx, ly, -4);
    common.lantern.value.set(lx, ly);
    glow.material.opacity = privateMode
      ? 0
      : 0.82 + (still ? 0 : 0.08 * Math.sin(elapsed * 3));
    centerMark.material.opacity = smooth((introTime - 1) / 1.5);
    renderer.render(scene, camera);
  }
  function running() {
    return !destroyed && visible && !document.hidden && !paused && !reduced;
  }
  function tick(now) {
    raf = 0;
    if (!running()) return;
    // Cap background work at 30fps, with no jumps after tab suspension.
    if (now - previous >= 1000 / 30) {
      draw(Math.min((now - previous) / 1000, 0.1));
      previous = now;
    }
    raf = requestAnimationFrame(tick);
  }
  function schedule() {
    cancelAnimationFrame(raf);
    raf = 0;
    previous = performance.now();
    if (running()) raf = requestAnimationFrame(tick);
  }
  function togglePrivacy() {
    if (destroyed) return;
    privateMode = !privateMode;
    waveTime = 0;
    options.onPrivacyChange?.(privateMode);
    draw();
  }
  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    viewScale = Math.max(0.52, Math.min(1, width / 1920));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(common.resolution.value);
    camera.left = -width / viewScale / 2;
    camera.right = width / viewScale / 2;
    camera.top = height / viewScale / 2;
    camera.bottom = -height / viewScale / 2;
    draw();
  }
  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function onMove(event) {
    updatePointer(event);
    if (drag) {
      options.onActivity?.(true);
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.moved ||= Math.hypot(dx, dy) > 5;
      panX = clamp(drag.panX - dx / viewScale / camera.zoom, -2400, 2400);
      panY = clamp(drag.panY + dy / viewScale / camera.zoom, -1250, 350);
    }
    if (!running()) draw();
  }
  function onDown(event) {
    if (event.button !== 0) return;
    updatePointer(event);
    options.onActivity?.(true);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX,
      panY,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  }
  function onUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    updatePointer(event);
    if (!drag.moved && event.type === "pointerup") {
      draw();
      if (
        Math.hypot(cursorWorld.x - LANTERN.x, cursorWorld.y - LANTERN.y) < 125
      ) {
        togglePrivacy();
      } else {
        const card = cards.find(
          (c) =>
            Math.abs(cursorWorld.x - c.x) < 360 &&
            Math.abs(cursorWorld.y - c.y) < 79,
        );
        if (card) card.tappedAt = elapsed;
      }
    }
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    drag = null;
    options.onActivity?.(false);
    canvas.style.cursor = "grab";
    if (event.pointerType === "touch") pointer = null;
    if (!running()) draw();
  }
  function onLeave() {
    if (!drag) {
      pointer = null;
    }
    if (!running()) draw();
  }
  function onMotionChange() {
    reduced = motion.matches;
    draw();
    schedule();
  }
  function onContextLost(event) {
    event.preventDefault();
    destroy();
    options.onError?.(new Error("WebGL context lost"));
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  });
  intersectionObserver.observe(host);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("webglcontextlost", onContextLost);
  document.addEventListener("visibilitychange", schedule);
  motion.addEventListener("change", onMotionChange);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    document.removeEventListener("visibilitychange", schedule);
    motion.removeEventListener("change", onMotionChange);
    const geometries = new Set();
    const materials = new Set();
    scene.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    inks.flat().forEach((t) => t.dispose());
    imageTextures.forEach((t) => t.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  }
  resize();
  schedule();
  return {
    togglePrivacy,
    setPaused(value) {
      paused = value;
      draw();
      schedule();
    },
    destroy,
  };
}
