/*
 * The 3D globe. This is the ONLY module that imports `three`, and it is only
 * ever loaded through a dynamic import() in Globe.tsx, so the library lives in
 * its own chunk that is fetched when a desktop Bridge Monitor opens.
 *
 * Colours follow the Slash DESIGN.md: Carbon ocean, Slate land, Fog rim light,
 * and the gilded hue (the validated chart-mark gold, with the cream end of the
 * gilded gradient) for the connections, signals and city lights. Nothing here
 * is blue or neon. All shader colours are display values, written as-is.
 *
 * Everything that moves (rotation, the arcs' shimmer, the signals, the marker
 * pulse and the introduction) advances from one clock that only ticks while
 * the scene is running, so pausing stops it all at once.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TextureLoader,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import { attachDragRotation, clampTilt } from "./dragRotation";
import { arcPoints, latLonToVec3 } from "./geo";
import type { GlobeConnection, GlobeLocation } from "./types";

export type GlobeSceneOptions = {
  /** The canvas to draw on. Owned by the caller, which removes it after dispose(). */
  canvas: HTMLCanvasElement;
  /** Sized by CSS; the scene follows its size. */
  container: HTMLElement;
  locations: GlobeLocation[];
  connections: GlobeConnection[];
  lightsUrl: string;
  landUrl: string;
  /** Length of the introduction in milliseconds; 0 skips it. */
  introMs: number;
  /** Whether to start paused. */
  paused: boolean;
  /** Called if the browser takes the WebGL context away. */
  onContextLost?: () => void;
};

export type GlobeScene = {
  /** Stops or starts all motion together: rotation, arcs, signals, pulses. */
  setPaused: (paused: boolean) => void;
  /** Stops drawing and frees every GPU resource and listener. */
  dispose: () => void;
};

const FOV = 36;
const BASE_Z = 3.9;
const ROTATION_PERIOD_S = 80; // one full turn
const START_LONGITUDE = -30; // facing the Atlantic: the Americas and Europe in view
const SIGNALS_PER_ARC = 3;
const TRAIL = 3; // points per signal: a head and two fading followers
const TRAIL_SIZE = [0.05, 0.036, 0.026];

// Display colours (0..1). See the file header.
const GOLD = new Vector3(177 / 255, 140 / 255, 57 / 255);
const CREAM = new Vector3(1, 240 / 255, 204 / 255);
const FOG = new Vector3(145 / 255, 148 / 255, 161 / 255);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------- shaders ----------

const EARTH_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uLights;
  uniform sampler2D uLand;
  uniform float uOpacity;
  uniform vec3 uGold;
  uniform vec3 uCream;
  uniform vec3 uFog;
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vec3 n = normalize(vNormalView);
    float land = texture2D(uLand, vUv).r;
    float lights = texture2D(uLights, vUv).r;

    vec3 ocean = vec3(0.071, 0.075, 0.09);   // Carbon
    vec3 ground = vec3(0.18, 0.188, 0.22);   // Slate
    vec3 col = mix(ocean, ground, land);

    // A fixed light from the upper left gives the sphere its depth.
    vec3 sun = normalize(vec3(-0.5, 0.55, 0.7));
    col *= 0.30 + 0.70 * clamp(dot(n, sun), 0.0, 1.0);

    // NASA night lights, warmed to the gilded hue and softened toward the limb.
    float facing = clamp(n.z, 0.0, 1.0);
    float glow = pow(lights, 0.9) * (0.35 + 0.65 * facing);
    col += mix(uGold, uCream, smoothstep(0.55, 1.0, lights)) * glow * 1.15;

    col += uFog * pow(1.0 - facing, 3.0) * 0.22;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const ATMOSPHERE_FRAG = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uFog;
  varying vec3 vNormalView;
  void main() {
    float f = clamp(-normalize(vNormalView).z * 2.0, 0.0, 1.0);
    gl_FragColor = vec4(uFog, pow(f, 2.6) * 0.5 * uOpacity);
  }
`;

const ARC_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress;
  uniform float uTime;
  uniform float uAlpha;
  uniform float uSoft;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    float along = vUv.x;
    float drawn = 1.0 - smoothstep(uProgress - 0.025, uProgress, along);
    float flow = 0.8 + 0.2 * sin(along * 16.0 - uTime * 1.4);
    float ends = smoothstep(0.0, 0.05, along) * (1.0 - smoothstep(0.95, 1.0, along));
    float across = mix(1.0, pow(abs(normalize(vNormalView).z), 1.5), uSoft);
    gl_FragColor = vec4(uColor, drawn * flow * (0.3 + 0.7 * ends) * across * uAlpha * uOpacity);
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    gl_FragColor = vec4(uColor, pow(1.0 - smoothstep(0.0, 1.0, d), 2.2) * 0.7 * uOpacity);
  }
`;

const SIGNAL_VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  uniform float uScale;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SIGNAL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(uColor, pow(1.0 - smoothstep(0.0, 1.0, d), 2.0) * vAlpha * uOpacity);
  }
`;

const PASS_UV_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

type Uniform<T> = { value: T };

export async function createGlobeScene(options: GlobeSceneOptions): Promise<GlobeScene> {
  const { canvas, container, locations, connections } = options;

  // Throws when WebGL is unavailable; the caller shows its fallback.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  let lights: Texture;
  let land: Texture;
  try {
    const loader = new TextureLoader();
    [lights, land] = await Promise.all([loader.loadAsync(options.lightsUrl), loader.loadAsync(options.landUrl)]);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  lights.anisotropy = anisotropy;
  land.anisotropy = anisotropy;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 50);
  // The camera looks at the origin; the tilt is on the globe, so lighting stays put.
  const root = new Group();
  root.rotation.x = 0.42; // north pole toward the viewer: every project location is in the north
  root.rotation.z = 0.16;
  scene.add(root);
  const spinner = new Group();
  root.add(spinner);

  // Uniforms shared by every material, so one write updates them all.
  const uOpacity: Uniform<number> = { value: 0 };
  const uTime: Uniform<number> = { value: 0 };
  const uScale: Uniform<number> = { value: 1 };

  // ----- Earth and atmosphere
  const earth = new Mesh(
    new SphereGeometry(1, 96, 64),
    new ShaderMaterial({
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
      transparent: true,
      uniforms: { uLights: { value: lights }, uLand: { value: land }, uOpacity, uGold: { value: GOLD }, uCream: { value: CREAM }, uFog: { value: FOG } },
    }),
  );
  earth.renderOrder = 0;
  spinner.add(earth);

  const atmosphere = new Mesh(
    new SphereGeometry(1.13, 64, 48),
    new ShaderMaterial({
      vertexShader: PASS_UV_VERT,
      fragmentShader: ATMOSPHERE_FRAG,
      transparent: true,
      side: BackSide,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: { uOpacity, uFog: { value: FOG } },
    }),
  );
  atmosphere.renderOrder = -1;
  root.add(atmosphere);

  // ----- Markers
  const Z = new Vector3(0, 0, 1);
  const coreGeometry = new SphereGeometry(0.014, 20, 14);
  const coreMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const haloGeometry = new CircleGeometry(0.07, 40);
  const haloMaterial = new ShaderMaterial({
    vertexShader: PASS_UV_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    uniforms: { uColor: { value: CREAM }, uOpacity },
  });
  const markers = locations.map((loc, index) => {
    const normal = new Vector3(...latLonToVec3(loc.lat, loc.lon));
    const core = new Mesh(coreGeometry, coreMaterial);
    core.position.copy(normal).multiplyScalar(1.004);
    core.renderOrder = 2;
    const halo = new Mesh(haloGeometry, haloMaterial);
    halo.position.copy(normal).multiplyScalar(1.006);
    halo.quaternion.copy(new Quaternion().setFromUnitVectors(Z, normal));
    halo.renderOrder = 2;
    spinner.add(core, halo);
    return { core, halo, phase: index * 1.3, appearAt: 0.3 + index * 0.06 };
  });

  // ----- Arcs
  const placeById = new Map(locations.map((l) => [l.id, l]));
  const arcMaterial = (color: Vector3, progress: Uniform<number>, alpha: number, soft: number) =>
    new ShaderMaterial({
      vertexShader: PASS_UV_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: { uColor: { value: color }, uProgress: progress, uTime, uAlpha: { value: alpha }, uSoft: { value: soft }, uOpacity },
    });
  const arcs = connections.flatMap((conn, index) => {
    const a = placeById.get(conn.from);
    const b = placeById.get(conn.to);
    if (!a || !b) return [];
    const curve = new CatmullRomCurve3(
      arcPoints([a.lat, a.lon], [b.lat, b.lon]).map((p) => new Vector3(...p)),
      false,
      "centripetal",
    );
    const progress: Uniform<number> = { value: 0 };
    const core = new Mesh(new TubeGeometry(curve, 192, 0.0032, 6, false), arcMaterial(GOLD, progress, 0.95, 0));
    const glow = new Mesh(new TubeGeometry(curve, 96, 0.0105, 8, false), arcMaterial(GOLD, progress, 0.16, 1));
    core.renderOrder = 1;
    glow.renderOrder = 1;
    spinner.add(glow, core);
    return [{ curve, progress, start: 0.4 + index * 0.11, duration: 0.38 }];
  });

  // ----- Signals travelling along the arcs
  const signals = arcs.flatMap((arc, arcIndex) =>
    Array.from({ length: SIGNALS_PER_ARC }, (_, i) => ({
      arc,
      phase: i / SIGNALS_PER_ARC + arcIndex * 0.17,
      period: 3.4 + arcIndex * 0.55,
    })),
  );
  const pointCount = signals.length * TRAIL;
  const signalPositions = new BufferAttribute(new Float32Array(pointCount * 3), 3);
  const signalAlpha = new BufferAttribute(new Float32Array(pointCount), 1);
  const signalSize = new BufferAttribute(new Float32Array(pointCount), 1);
  for (let i = 0; i < pointCount; i += 1) signalSize.setX(i, TRAIL_SIZE[i % TRAIL] ?? 0.03);
  const signalGeometry = new BufferGeometry();
  signalGeometry.setAttribute("position", signalPositions);
  signalGeometry.setAttribute("aAlpha", signalAlpha);
  signalGeometry.setAttribute("aSize", signalSize);
  const signalPoints = new Points(
    signalGeometry,
    new ShaderMaterial({
      vertexShader: SIGNAL_VERT,
      fragmentShader: SIGNAL_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      uniforms: { uColor: { value: CREAM }, uScale, uOpacity },
    }),
  );
  signalPoints.frustumCulled = false; // positions change every frame
  signalPoints.renderOrder = 3;
  spinner.add(signalPoints);

  // ----- State and drawing
  let paused = options.paused;
  let disposed = false;
  let contextLost = false;
  let pageVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  let inView = true;
  let running = false;
  let last = 0;
  let time = 0;
  let introElapsed = 0;
  let spin = MathUtils.degToRad(-90 - START_LONGITUDE);
  let tilt = root.rotation.x; // the initial tilt; dragging moves it within the tilt limits
  let dragging = false;
  let fit = 1;
  const tmp = new Vector3();

  const introT = () => (options.introMs > 0 ? clamp01(introElapsed / options.introMs) : 1);

  function apply() {
    const t = introT();
    const eased = easeOutCubic(t);
    uOpacity.value = easeOutCubic(t / 0.6);
    uTime.value = time;
    root.scale.setScalar(0.92 + 0.08 * easeOutCubic(t / 0.65));
    camera.position.set(0, 0, BASE_Z * fit + 0.6 * (1 - eased));
    spinner.rotation.y = spin;
    root.rotation.x = tilt;

    markers.forEach((m) => {
      const grow = easeOutCubic((t - m.appearAt) / 0.25);
      const pulse = 1 + 0.18 * Math.sin(time * 2.2 + m.phase);
      m.core.scale.setScalar(Math.max(grow, 0.0001));
      m.halo.scale.setScalar(Math.max(grow * pulse, 0.0001));
    });
    arcs.forEach((arc) => {
      arc.progress.value = easeInOutCubic((t - arc.start) / arc.duration) * 1.03;
    });

    signals.forEach((sig, si) => {
      const u = (time / sig.period + sig.phase) % 1;
      const envelope = smoothstep(0, 0.08, u) * (1 - smoothstep(0.92, 1, u));
      for (let k = 0; k < TRAIL; k += 1) {
        const idx = si * TRAIL + k;
        const uk = u - k * 0.016;
        if (uk < 0 || uk > sig.arc.progress.value) {
          signalAlpha.setX(idx, 0);
          continue;
        }
        sig.arc.curve.getPointAt(uk, tmp);
        signalPositions.setXYZ(idx, tmp.x, tmp.y, tmp.z);
        signalAlpha.setX(idx, envelope * (1 - k * 0.34));
      }
    });
    signalPositions.needsUpdate = true;
    signalAlpha.needsUpdate = true;
  }

  function step(dt: number) {
    time += dt;
    if (introElapsed < options.introMs) introElapsed += dt * 1000;
    const speed = 1 + 3 * (1 - easeOutCubic(introT())); // spins faster while the globe arrives
    if (!dragging) spin += ((Math.PI * 2) / ROTATION_PERIOD_S) * dt * speed; // the pointer owns the spin while grabbed
    apply();
  }

  function render() {
    if (!disposed && !contextLost) renderer.render(scene, camera);
  }

  function frame(now: number) {
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05); // a long gap (a hidden tab) never jumps
    last = now;
    step(dt);
    render();
  }

  const shouldRun = () => !paused && pageVisible && inView && !contextLost && !disposed;
  function sync() {
    const want = shouldRun();
    if (want && !running) {
      running = true;
      last = performance.now();
      renderer.setAnimationLoop(frame);
    } else if (!want && running) {
      running = false;
      renderer.setAnimationLoop(null);
    }
  }

  function resize() {
    if (disposed) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    fit = Math.max(1, 1 / camera.aspect); // a tall, narrow box keeps the whole globe in view
    camera.updateProjectionMatrix();
    uScale.value = renderer.domElement.height / (2 * Math.tan(MathUtils.degToRad(FOV / 2)));
    apply();
    if (!running) render();
  }

  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);
  const intersectionObserver =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          inView = entries.some((e) => e.isIntersecting);
          sync();
        })
      : null;
  intersectionObserver?.observe(container);
  const onVisibility = () => {
    pageVisible = document.visibilityState !== "hidden";
    sync();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    sync();
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const drag = attachDragRotation(canvas, {
    getSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
    onStart: () => {
      dragging = true;
    },
    onRotate: (dYaw, dPitch) => {
      spin += dYaw;
      tilt = clampTilt(tilt + dPitch);
      apply();
      if (!running) render(); // paused (or off-screen): no loop is drawing, so draw now
    },
    onEnd: () => {
      dragging = false; // a running loop picks automatic rotation straight back up
    },
  });

  resize();
  sync();

  return {
    setPaused(next) {
      if (disposed || next === paused) return;
      paused = next;
      sync();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      drag.detach();
      sync();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      scene.traverse((object) => {
        const mesh = object as Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      lights.dispose();
      land.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
