import * as T from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TAU, clamp, lerp, smoothstep, easeInOut, hash2, vnoise, makeRng, fmtClock, fmtShort } from "./math";
import {
  RE,
  MU_E,
  G0,
  H_OLM,
  L_B,
  T_IGN,
  T_BMECO,
  T_SHIPIGN,
  T_SEP,
  T_BB0,
  T_SECO,
  CS_BASE,
  LAT,
  boosterThrottle,
  boosterEnginesAscent,
  buildAscent,
  buildBooster,
  buildShip,
  newAscentSample,
  sunTransJS,
  type BoosterSample,
} from "./mission";
import {
  BAKE_VERT,
  BAKE_FRAG,
  EARTH_VERT,
  EARTH_FRAG,
  CLOUD_FRAG,
  SKY_VERT,
  SKY_FRAG,
  CAP_VERT,
  CAP_FRAG,
  OCEAN_VERT,
  OCEAN_FRAG,
  STAR_VERT,
  STAR_FRAG,
  PUFF_VERT,
  PUFF_FRAG,
  PLUME_VERT,
  PLUME_FRAG,
  SHEATH_VERT,
  SHEATH_FRAG,
  ENV_VERT,
  ENV_FRAG,
} from "./shaders";
import { profileY, resampleProfile, shipProfile, shipRadius, type Pt2 } from "./vehicleShape";

const D2R = Math.PI / 180;

export type Quality = "high" | "balanced";
export type CamMode = "chase" | "ground";
export type Follow = "auto" | "booster" | "ship";
/** Drives the status light: grey, amber, fire, accent or green. */
export type PhaseTone = "hold" | "paused" | "count" | "burn" | "coast" | "done";
/** `booster` and `ship` are followed by that vehicle's status. */
export type PhaseId = "hold" | "paused" | "countdown" | "ignition" | "ascent" | "staging" | "booster" | "ship";
export type BoosterStatus =
  | "fueled"
  | "engineStart"
  | "ascent"
  | "hotStaging"
  | "flip"
  | "boostback"
  | "coast"
  | "descent"
  | "landingBurn"
  | "approach"
  | "caught";
export type ShipStatus =
  | "fueled"
  | "stacked"
  | "hotStaging"
  | "sixEngine"
  | "coast"
  | "deploy"
  | "relight"
  | "entryAttitude"
  | "plasma"
  | "bellyFlop"
  | "landingBurn"
  | "splashdown"
  | "complete";
export type EventKey =
  | "go"
  | "qd"
  | "deluge"
  | "ign"
  | "liftoff"
  | "tower"
  | "maxq"
  | "meco"
  | "hot"
  | "sep"
  | "bb"
  | "bbend"
  | "hsr"
  | "blb"
  | "catch"
  | "seco"
  | "door"
  | "sats"
  | "apo"
  | "satsok"
  | "doorc"
  | "relight"
  | "att"
  | "ei"
  | "peak"
  | "sub"
  | "flip"
  | "splash"
  | "tip"
  /** Toast only: the ground camera was picked out of range. */
  | "nocam";
export type TickId = "liftoff" | "maxq" | "staging" | "catch" | "seco" | "deploy" | "entry" | "peak" | "splash";

export interface Snapshot {
  met: string;
  phase: PhaseId;
  tone: PhaseTone;
  launched: boolean;
  paused: boolean;
  b: {
    /** Speed, km/h. */
    spd: number;
    /** Altitude, km. */
    alt: number;
    status: BoosterStatus;
    /** Raptors running, 0–33. */
    eng: number;
  };
  s: {
    spd: number;
    alt: number;
    status: ShipStatus;
    /** Sea-level Raptors running, 0–3. */
    sl: number;
    /** Raptor Vacuums running, 0–3. */
    vac: number;
  };
  warpUser: number;
  warpEff: number;
  auto: boolean;
  follow: Follow;
  cam: CamMode;
  autoOrbit: boolean;
  /** Timeline progress, 0–1. */
  tl: number;
  ticks: { id: TickId; left: number; minor: boolean; done: boolean }[];
  /** Newest first. */
  log: { met: string; key: EventKey }[];
  toast: { key: EventKey; values?: number[]; id: string } | null;
  canSkip: boolean;
}

export interface SimCallbacks {
  onStatus(s: Snapshot): void;
  /** Earth texture bake progress, 0–1. */
  onProgress(p: number): void;
  onReady(): void;
}

export interface SimOptions {
  quality: Quality;
  /** Drops camera shake and lift-off vibration. */
  reducedMotion: boolean;
}

export interface Sim {
  snapshot(): Snapshot;
  primary(): Snapshot;
  restart(): Snapshot;
  skip(): Snapshot;
  setWarp(w: number): Snapshot;
  toggleAuto(): Snapshot;
  setFollow(f: Follow): Snapshot;
  setCam(c: CamMode): Snapshot;
  toggleOrbit(): Snapshot;
  resetCamera(): Snapshot;
  setQuality(q: Quality): void;
  dispose(): void;
}

type Focus = "stack" | "booster" | "ship";

interface MissionEvent {
  t: number;
  key: EventKey;
  /** Numbers shown in the toast (kPa, km, km/h, g or m depending on the event). */
  values?: number[];
}

interface BState extends BoosterSample {
  /** Throttle, 0–1. */
  thr: number;
  /** Dynamic pressure, Pa. */
  q: number;
}

interface SState {
  th: number;
  h: number;
  vh: number;
  vv: number;
  v: number;
  psi: number;
  /** Sea-level Raptors running. */
  sl: number;
  /** Raptor Vacuums running. */
  vac: number;
  /** Throttle, 0–1. */
  thr: number;
  gf: number;
  q: number;
  /** Entry heating relative to the peak, 0–1. */
  heat: number;
}

interface Flap {
  piv: T.Group;
  beta: number;
  side: number;
  tilt: number;
  tileMat: T.MeshStandardMaterial;
}

interface Satellite {
  mesh: T.Mesh;
  t0: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
}

interface RcsPort {
  p: T.Vector3;
  d: T.Vector3;
}

/** Instanced billboard particles animated on the GPU from their birth state. */
interface Puffs {
  mat: T.ShaderMaterial;
  emit(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    birth: number,
    life: number,
    s0: number,
    s1: number,
    op: number,
    r: number,
    g: number,
    b: number,
    drag: number,
  ): void;
  flush(): void;
  clear(): void;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const x = c.getContext("2d");
  if (!x) throw new Error("Canvas 2D is not available.");
  return x;
}

/**
 * Builds the whole scene (Super Heavy, Starship, Starbase, the splashdown ocean, true-scale Earth, sky, stars,
 * particles) on the canvas and flies the mission. The returned handle drives it; status arrives through `cb`.
 */
export function createSim(canvas: HTMLCanvasElement, opts: SimOptions, cb: SimCallbacks): Sim {
  const hi = opts.quality !== "balanced";
  const S: {
    quality: Quality;
    launched: boolean;
    paused: boolean;
    warpUser: number;
    auto: boolean;
    follow: Follow;
    cam: CamMode;
    autoOrbit: boolean;
  } = {
    quality: hi ? "high" : "balanced",
    launched: false,
    paused: false,
    warpUser: 1,
    auto: true,
    follow: "auto",
    cam: "chase",
    autoOrbit: false,
  };
  let renderer: T.WebGLRenderer;
  try {
    renderer = new T.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
  } catch {
    throw new Error("WebGL is not available in this browser or device.");
  }
  if (T.ColorManagement) T.ColorManagement.legacyMode = false;
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 1);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  function pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, S.quality === "high" ? 2 : 1.25);
  }
  renderer.setPixelRatio(pixelRatio());

  /* ---------- mission timeline ---------- */
  const A = buildAscent();
  const B = buildBooster(A);
  const SH = buildShip(A);
  const T_START = -15;
  const T_QD = -12;
  const T_DELUGE = -4.5;
  const T_HSR = B.tBBe + 6;
  const T_DOOR = 1080;
  const T_DEPLOY0 = 1104;
  const DEPLOY_DT = 22;
  const N_SATS = 8;
  const T_DOOR_CLOSE = T_DEPLOY0 + (N_SATS - 1) * DEPLOY_DT + 30;
  const T_RELIGHT = SH.tEI - 420;
  const RELIGHT_DUR = 3.2;
  const T_ENTRY_ATT = SH.tEI - 330;
  let tTower = 8;
  for (let k = 0; k < A.N; k++) {
    const t = A.t0 + k * A.DT;
    if (t > 0 && H_OLM + A.H[k] > 150) {
      tTower = t;
      break;
    }
  }

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, 1, 0.5, 6e7);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.minDistance = 22;
  controls.maxDistance = 9000;
  controls.autoRotateSpeed = 0.5;

  const Zax = new T.Vector3(0, 0, 1);
  const Yax = new T.Vector3(0, 1, 0);
  const Xax = new T.Vector3(1, 0, 0);
  const CENTER = new T.Vector3(0, -RE, 0);
  /* sun fixed in the Earth frame: sunrise at Starbase (~7 deg up), sunset (~1 deg up) at the splashdown point */
  const TH_L = SH.thSplash;
  const SUN_B = 10 * D2R;
  const SUN_C = Math.cos(SUN_B);
  const SUN_PHI = TH_L - Math.acos(Math.sin(1.2 * D2R) / SUN_C);
  const SUN_IN = new T.Vector3(SUN_C * Math.sin(SUN_PHI), SUN_C * Math.cos(SUN_PHI), Math.sin(SUN_B));
  const sunD = SUN_IN.clone();
  const worldRoot = new T.Group();
  worldRoot.position.copy(CENTER);
  scene.add(worldRoot);
  const padFrame = new T.Group();
  padFrame.position.set(0, RE, 0);
  worldRoot.add(padFrame);
  const landFrame = new T.Group();
  landFrame.position.set(RE * Math.sin(TH_L), RE * Math.cos(TH_L), 0);
  landFrame.rotation.z = -TH_L;
  worldRoot.add(landFrame);
  const earthGroup = new T.Group();
  worldRoot.add(earthGroup);
  const boosterG = new T.Group();
  scene.add(boosterG);
  const shipG = new T.Group();
  scene.add(shipG);

  /* ---------- lights ---------- */
  const sun = new T.DirectionalLight(0xffffff, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(hi ? 4096 : 2048, hi ? 4096 : 2048);
  const shc = sun.shadow.camera;
  shc.left = -120;
  shc.right = 120;
  shc.top = 120;
  shc.bottom = -120;
  shc.near = 1;
  shc.far = 4000;
  shc.updateProjectionMatrix();
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.06;
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new T.HemisphereLight(0x8fb4e8, 0x5a6650, 0.55);
  scene.add(hemi);
  const bLight = new T.PointLight(0xffa860, 0, 2500, 1.0);
  bLight.position.set(0, -18, 0);
  boosterG.add(bLight);
  const sLight = new T.PointLight(0xffa860, 0, 1500, 1.0);
  sLight.position.set(0, -14, 0);
  shipG.add(sLight);
  const fog = new T.FogExp2(0x9fb8d8, 0.00002);
  scene.fog = fog;

  /* ---------- environment reflections, regenerated with altitude ---------- */
  const pmrem = new T.PMREMGenerator(renderer);
  const envScene = new T.Scene();
  const envMat = new T.ShaderMaterial({
    side: T.BackSide,
    depthWrite: false,
    uniforms: {
      uSun: { value: new T.Vector3() },
      uSky: { value: new T.Vector3() },
      uHorizon: { value: new T.Vector3() },
      uGround: { value: new T.Vector3() },
      uDip: { value: 0 },
      uSunK: { value: 1 },
    },
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
  });
  const envMesh = new T.Mesh(new T.SphereGeometry(10, 48, 24), envMat);
  envScene.add(envMesh);
  let envRT: T.WebGLRenderTarget | null = null;
  let envAlt = -1;
  let envT = -99;
  const envSun = new T.Vector3(9, 9, 9);
  function updateEnv(alt: number, sunVis: number, warm: number, now: number) {
    const a01 = smoothstep(0, 60000, alt);
    if (envRT && Math.abs(a01 - envAlt) < 0.05 && now - envT < 6 && envSun.distanceTo(sunD) < 0.08) return;
    envAlt = a01;
    envT = now;
    envSun.copy(sunD);
    const u = envMat.uniforms;
    u.uSun.value.copy(sunD);
    const dk = clamp(sunVis * 1.3, 0.12, 1);
    u.uSky.value.set(lerp(0.16, 0.0, a01) * dk, lerp(0.3, 0.0, a01) * dk, lerp(0.62, 0.005, a01) * dk);
    u.uHorizon.value.set(
      lerp(lerp(0.55, 0.95, warm), 0.12, a01) * dk,
      lerp(lerp(0.62, 0.62, warm), 0.22, a01) * dk,
      lerp(lerp(0.75, 0.48, warm), 0.45, a01) * dk,
    );
    u.uGround.value.set(lerp(0.07, 0.05, a01) * dk, lerp(0.08, 0.1, a01) * dk, lerp(0.07, 0.2, a01) * dk);
    u.uDip.value = -Math.sqrt(Math.max(0, 1 - Math.pow(RE / (RE + Math.max(alt, 10)), 2)));
    u.uSunK.value = sunVis;
    const rt = pmrem.fromScene(envScene, 0.04);
    scene.environment = rt.texture;
    if (envRT) envRT.dispose();
    envRT = rt;
  }

  /* ---------- texture + mesh helpers ---------- */
  function newCanvas(w: number, h: number) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  function canvasTex(c: HTMLCanvasElement, srgb: boolean) {
    const t = new T.CanvasTexture(c);
    if (srgb) t.encoding = T.sRGBEncoding;
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
    return t;
  }
  function addMesh(geo: T.BufferGeometry, mat: T.Material | T.Material[], parent: T.Object3D, shadow?: boolean) {
    const m = new T.Mesh(geo, mat);
    if (shadow !== false) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    parent.add(m);
    return m;
  }
  function boxAt(
    parent: T.Object3D,
    mat: T.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry?: number,
    shadow?: boolean,
  ) {
    const m = addMesh(new T.BoxGeometry(w, h, d), mat, parent, shadow);
    m.position.set(x, y, z);
    if (ry) m.rotation.y = ry;
    return m;
  }
  function cylAt(
    parent: T.Object3D,
    mat: T.Material,
    rt: number,
    rb: number,
    h: number,
    x: number,
    y: number,
    z: number,
    seg?: number,
    shadow?: boolean,
  ) {
    const m = addMesh(new T.CylinderGeometry(rt, rb, h, seg || 20), mat, parent, shadow);
    m.position.set(x, y, z);
    return m;
  }
  type RGB = [number, number, number];
  function plumeMat(core: RGB, edge: RGB, len: number, gain: number, invert: number, diamond: number) {
    return new T.ShaderMaterial({
      uniforms: {
        uThrottle: { value: 0 },
        uTime: { value: 0 },
        uCore: { value: new T.Vector3(core[0], core[1], core[2]) },
        uEdge: { value: new T.Vector3(edge[0], edge[1], edge[2]) },
        uLen: { value: len },
        uGain: { value: gain },
        uInvert: { value: invert },
        uDiamond: { value: diamond },
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
    });
  }
  function latticeTex(rx: number, ry: number, diag: boolean) {
    const c = newCanvas(256, 256);
    const x = ctx2d(c);
    x.strokeStyle = "#ffffff";
    x.lineWidth = 18;
    x.strokeRect(9, 9, 238, 238);
    x.lineWidth = 9;
    x.beginPath();
    if (diag) {
      x.moveTo(0, 0);
      x.lineTo(256, 256);
      x.moveTo(256, 0);
      x.lineTo(0, 256);
    }
    x.moveTo(0, 128);
    x.lineTo(256, 128);
    x.stroke();
    const t = canvasTex(c, true);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(rx, ry);
    return t;
  }
  function latticeMat(rx: number, ry: number, color: number, diag: boolean) {
    return new T.MeshStandardMaterial({
      map: latticeTex(rx, ry, diag),
      alphaTest: 0.5,
      side: T.DoubleSide,
      color: color,
      roughness: 0.62,
      metalness: 0.45,
    });
  }
  /** Stainless hull painted per profile row (weld rings, panel tint, streaks), plus a frost alpha map. */
  function steelTextures(prof: Pt2[], W: number, H: number, ringH: number, frostRanges: Pt2[], seed: number) {
    const c = newCanvas(W, H);
    const x = ctx2d(c);
    const img = x.createImageData(W, H);
    const fc = newCanvas(W / 2, H / 2);
    const fx = ctx2d(fc);
    const fimg = fx.createImageData(W / 2, H / 2);
    for (let py = 0; py < H; py++) {
      const v = 1 - (py + 0.5) / H;
      const y = profileY(prof, v);
      const ring = Math.floor(y / ringH);
      const fy = y / ringH - ring;
      const weld = Math.min(fy, 1 - fy) * ringH;
      for (let px = 0; px < W; px++) {
        const u = (px + 0.5) / W;
        const seg = Math.floor(u * 3 + (ring % 2) * 0.5) % 3;
        const panel = hash2(ring * 7 + seed, seg) - 0.5;
        const streak = vnoise(u * 260, y * 0.18 + seed) - 0.5;
        const fine = vnoise(u * 900, y * 2.2) - 0.5;
        let g = 196 + panel * 22 + streak * 18 + fine * 8;
        const pf = (u * 3 + (ring % 2) * 0.5) % 1;
        const seam = (Math.min(pf, 1 - pf) * TAU * 4.5) / 3;
        if (weld < 0.035) g -= 46;
        else if (weld < 0.09) g += 10;
        if (seam < 0.026) g -= 30;
        const o = (py * W + px) * 4;
        img.data[o] = g;
        img.data[o + 1] = g + 2;
        img.data[o + 2] = g + 5;
        img.data[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    for (let qy = 0; qy < H / 2; qy++) {
      const y2 = profileY(prof, 1 - (qy + 0.5) / (H / 2));
      let fr = 0;
      frostRanges.forEach(function (rg) {
        fr = Math.max(fr, smoothstep(rg[0] - 0.6, rg[0] + 0.6, y2) * (1 - smoothstep(rg[1] - 0.8, rg[1] + 0.4, y2)));
      });
      for (let qx = 0; qx < W / 2; qx++) {
        const u2 = (qx + 0.5) / (W / 2);
        const n = vnoise(u2 * 140, y2 * 1.3) * 0.6 + vnoise(u2 * 520, y2 * 5) * 0.4;
        const a = fr * clamp(0.35 + 0.9 * n - 0.25 * vnoise(u2 * 40, y2 * 0.35), 0, 1);
        const o2 = (qy * (W / 2) + qx) * 4;
        fimg.data[o2] = a * 255;
        fimg.data[o2 + 1] = a * 255;
        fimg.data[o2 + 2] = a * 255;
        fimg.data[o2 + 3] = 255;
      }
    }
    fx.putImageData(fimg, 0, 0);
    return { color: canvasTex(c, true), frost: canvasTex(fc, false) };
  }
  /** Hexagonal heat-shield tiles, seamless in both directions. */
  function hexTileTex() {
    const W = 512;
    const H = 444;
    const w = W / 4;
    const s = w / Math.sqrt(3);
    const sy = H / (6 * s);
    const c = newCanvas(W, H);
    const x = ctx2d(c);
    x.fillStyle = "#3e3e42";
    x.fillRect(0, 0, W, H);
    function hex(cx: number, cy: number, k: number) {
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const px = cx + (s - 3.2) * Math.cos(a);
        const py = cy + (s - 3.2) * Math.sin(a);
        if (i === 0) x.moveTo(px, py * sy);
        else x.lineTo(px, py * sy);
      }
      x.closePath();
      const g = 20 + Math.floor(hash2(k, 11) * 13);
      x.fillStyle = "rgb(" + g + "," + g + "," + (g + 2) + ")";
      x.fill();
    }
    for (let row = -1; row <= 4; row++)
      for (let col = -1; col <= 4; col++) {
        hex(col * w + (row & 1 ? w / 2 : 0), row * 1.5 * s, (((row % 4) + 4) % 4) * 7 + (((col % 4) + 4) % 4));
      }
    const t = canvasTex(c, true);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    return t;
  }

  /* ===================== shared vehicle materials ===================== */
  const V2 = (p: Pt2) => new T.Vector2(p[0], p[1]);
  const matDarkMetal = new T.MeshStandardMaterial({
    color: 0x2b2d31,
    roughness: 0.55,
    metalness: 0.55,
    envMapIntensity: 0.8,
  });
  const matAft = new T.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.8, metalness: 0.3, side: T.DoubleSide });
  const matPlainSteel = new T.MeshStandardMaterial({
    color: 0xc4c9cf,
    roughness: 0.36,
    metalness: 0.72,
    envMapIntensity: 1.0,
  });
  const matFrameSteel = new T.MeshStandardMaterial({
    color: 0x8d9298,
    roughness: 0.45,
    metalness: 0.7,
    envMapIntensity: 0.9,
  });
  const nozzleTex = (function () {
    const c = newCanvas(256, 512);
    const x = ctx2d(c);
    const grad = x.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, "rgb(150,140,132)");
    grad.addColorStop(0.45, "rgb(118,104,96)");
    grad.addColorStop(1, "rgb(70,74,82)");
    x.fillStyle = grad;
    x.fillRect(0, 0, 256, 512);
    for (let k = 0; k < 256; k += 3) {
      x.fillStyle = k % 6 === 0 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.14)";
      x.fillRect(k, 0, 1.5, 512);
    }
    return canvasTex(c, true);
  })();
  const matNozzle = new T.MeshStandardMaterial({
    map: nozzleTex,
    metalness: 0.75,
    roughness: 0.42,
    side: T.DoubleSide,
    envMapIntensity: 0.9,
  });
  const matVac = new T.MeshStandardMaterial({ color: 0x3a3e46, metalness: 0.6, roughness: 0.5, side: T.DoubleSide });
  function nozzleGeo(rExit: number, len: number, rThroat: number, seg?: number) {
    const pts: T.Vector2[] = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16;
      pts.push(new T.Vector2(rThroat + (rExit - rThroat) * Math.pow(1 - t, 1.7), t * len));
    }
    pts.push(new T.Vector2(rThroat * 1.35, len + 0.25));
    pts.push(new T.Vector2(rThroat * 1.35, len + 0.9));
    return new T.LatheGeometry(pts, seg || 32);
  }
  /* methalox plumes: cores carry the shock diamonds, the outer sheath widens with altitude */
  function coreCone(r0: number, r1: number, len: number) {
    const g = new T.CylinderGeometry(r1, r0, len, 20, 12, true);
    g.translate(0, len / 2, 0);
    g.rotateX(Math.PI);
    return g;
  }
  const raptorCoreGeo = coreCone(0.56, 1.45, 22);
  const glowMatProto = new T.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    side: T.BackSide,
  });

  /* ===================== SUPER HEAVY (booster frame: base at y=0, +Y up, catch pins on ±X) ===================== */
  const bProf = resampleProfile(
    [
      [4.32, 0],
      [4.5, 0.55],
      [4.5, 69.0],
    ],
    0.5,
  );
  const bTex = steelTextures(
    bProf,
    1024,
    2048,
    1.83,
    [
      [3.2, 33.0],
      [35.4, 66.6],
    ],
    3,
  );
  const matBSteel = new T.MeshStandardMaterial({
    map: bTex.color,
    metalness: 0.72,
    roughness: 0.36,
    envMapIntensity: 1.0,
  });
  addMesh(new T.LatheGeometry(bProf.map(V2), 96), matBSteel, boosterG);
  const matBFrost = new T.MeshStandardMaterial({
    color: 0xf2f6fa,
    roughness: 0.92,
    metalness: 0,
    alphaMap: bTex.frost,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    envMapIntensity: 0.5,
  });
  const frostB = new T.Mesh(
    new T.LatheGeometry(
      bProf.map((p) => new T.Vector2(p[0] + 0.035, p[1])),
      96,
    ),
    matBFrost,
  );
  frostB.renderOrder = 3;
  boosterG.add(frostB);
  (function () {
    const dome: T.Vector2[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = ((k / 10) * Math.PI) / 2;
      dome.push(new T.Vector2(Math.max(0.001, 4.5 * Math.cos(a)), 69.0 + 1.3 * Math.sin(a)));
    }
    addMesh(new T.LatheGeometry(dome.reverse(), 64), matPlainSteel, boosterG);
    const aft = addMesh(new T.CircleGeometry(4.42, 64), matAft, boosterG);
    aft.rotation.x = Math.PI / 2;
    aft.position.y = 1.15;
    /* chines and raceway */
    [125, -125].forEach(function (bd) {
      const b = bd * D2R;
      const m = boxAt(boosterG, matPlainSteel, 0.9, 30, 0.14, 4.9 * Math.cos(b), 17, 4.9 * Math.sin(b));
      m.rotation.y = -b;
    });
    const rw = boxAt(
      boosterG,
      matPlainSteel,
      0.55,
      62,
      0.75,
      4.72 * Math.cos(Math.PI / 2),
      33,
      4.72 * Math.sin(Math.PI / 2),
    );
    rw.rotation.y = -Math.PI / 2;
    /* catch pins on +X / -X just below the grid fins */
    [0, Math.PI].forEach(function (b) {
      const g = new T.Group();
      g.position.set(4.5 * Math.cos(b), 61.85, 4.5 * Math.sin(b));
      g.rotation.y = -b;
      boosterG.add(g);
      const pin = addMesh(new T.CylinderGeometry(0.35, 0.35, 1.3, 16), matFrameSteel, g);
      pin.rotation.z = Math.PI / 2;
      pin.position.x = 0.65;
      boxAt(g, matPlainSteel, 0.5, 1.6, 1.6, 0.2, 0.4, 0);
    });
  })();
  const gridFins: T.Group[] = [];
  (function () {
    const finMat = new T.MeshStandardMaterial({
      map: latticeTex(7, 5, true),
      alphaTest: 0.45,
      side: T.DoubleSide,
      color: 0x9ca1a8,
      roughness: 0.5,
      metalness: 0.7,
    });
    [90, 210, 330].forEach(function (bd) {
      const b = bd * D2R;
      const root = new T.Group();
      root.position.set(4.5 * Math.cos(b), 65.5, 4.5 * Math.sin(b));
      root.rotation.y = -b;
      boosterG.add(root);
      boxAt(root, matPlainSteel, 1.5, 2.8, 1.9, 0.6, 0, 0);
      const piv = new T.Group();
      piv.position.x = 1.2;
      root.add(piv);
      [-0.38, 0.38].forEach(function (yy) {
        const pl = addMesh(new T.PlaneGeometry(5.6, 3.8), finMat, piv);
        pl.rotation.x = -Math.PI / 2;
        pl.position.set(2.9, yy, 0);
      });
      boxAt(piv, matFrameSteel, 5.8, 0.8, 0.22, 2.9, 0, 1.9);
      boxAt(piv, matFrameSteel, 5.8, 0.8, 0.22, 2.9, 0, -1.9);
      boxAt(piv, matFrameSteel, 0.24, 0.8, 4.0, 5.75, 0, 0);
      boxAt(piv, matFrameSteel, 0.3, 0.8, 4.0, 0.05, 0, 0);
      gridFins.push(piv);
    });
  })();
  /* hot-stage ring: vented adapter with a shielding dome, jettisoned after boostback */
  const hsr = new T.Group();
  hsr.position.y = 69.0;
  boosterG.add(hsr);
  const hsrMat = (function () {
    const c = newCanvas(1024, 64);
    const x = ctx2d(c);
    x.fillStyle = "rgb(196,200,205)";
    x.fillRect(0, 0, 1024, 64);
    for (let k = 0; k < 36; k++) {
      const u = ((k + 0.5) / 36) * 1024;
      x.fillStyle = "rgb(18,18,20)";
      x.fillRect(u - 9, 14, 18, 38);
      x.fillStyle = "rgb(120,124,130)";
      x.fillRect(u - 12, 10, 24, 3);
    }
    x.fillStyle = "rgb(140,144,150)";
    x.fillRect(0, 0, 1024, 4);
    x.fillRect(0, 60, 1024, 4);
    return new T.MeshStandardMaterial({
      map: canvasTex(c, true),
      metalness: 0.7,
      roughness: 0.4,
      emissive: 0x000000,
      envMapIntensity: 1.0,
    });
  })();
  addMesh(new T.CylinderGeometry(4.5, 4.5, 1.9, 96, 1, true), hsrMat, hsr).position.y = 0.95;
  addMesh(new T.CylinderGeometry(1.4, 4.5, 0.15, 64, 1, false), matDarkMetal, hsr).position.y = 1.95;
  const hsrHome = hsr.position.clone();
  const hsrDeb = { sep: false, x: 0, y: 0, vx: 0, vy: 0, z: 0, ang: 0, w: 0, t: 0, th: 0 };
  /* 33 Raptors: 3 centre (gimbal), 10 inner ring, 20 outer ring */
  const BENG: { x: number; z: number; ring: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (90 + k * 120) * D2R;
    BENG.push({ x: 1.05 * Math.cos(a), z: 1.05 * Math.sin(a), ring: 0 });
  }
  for (let k = 0; k < 10; k++) {
    const a = (18 + k * 36) * D2R;
    BENG.push({ x: 2.45 * Math.cos(a), z: 2.45 * Math.sin(a), ring: 1 });
  }
  for (let k = 0; k < 20; k++) {
    const a = k * 18 * D2R;
    BENG.push({ x: 3.87 * Math.cos(a), z: 3.87 * Math.sin(a), ring: 2 });
  }
  const bNoz = new T.InstancedMesh(nozzleGeo(0.6, 1.7, 0.24, 28), matNozzle, 33);
  bNoz.castShadow = true;
  bNoz.receiveShadow = true;
  boosterG.add(bNoz);
  const bGlow = new T.InstancedMesh(nozzleGeo(0.58, 1.68, 0.22, 20), glowMatProto.clone(), 33);
  boosterG.add(bGlow);
  const m4i = new T.Matrix4();
  const colI = new T.Color();
  BENG.forEach(function (e, i) {
    m4i.makeTranslation(e.x, 0.12, e.z);
    bNoz.setMatrixAt(i, m4i);
    bGlow.setMatrixAt(i, m4i);
    bGlow.setColorAt(i, colI.setRGB(0, 0, 0));
  });
  const bCoreMats = [0, 1, 2].map(() => plumeMat([0.95, 0.85, 1.0], [1.0, 0.6, 0.3], 22, 1.6, 0, 0.45));
  const bCores = BENG.map(function (e) {
    const m = new T.Mesh(raptorCoreGeo, bCoreMats[e.ring]);
    m.position.set(e.x, 0.12, e.z);
    m.renderOrder = 8;
    m.frustumCulled = false;
    boosterG.add(m);
    return m;
  });
  const bBigMat = plumeMat([1.0, 0.74, 0.46], [1.0, 0.46, 0.16], 85, 0.55, 0, 0.12);
  const bBig = new T.Mesh(coreCone(4.8, 15, 85), bBigMat);
  bBig.position.y = 0.1;
  bBig.renderOrder = 8;
  bBig.frustumCulled = false;
  boosterG.add(bBig);
  const bVents = [
    new T.Vector3(3.6, 60, 2.4),
    new T.Vector3(-4.2, 64, -1.0),
    new T.Vector3(1.0, 36, -4.4),
    new T.Vector3(-2.0, 12, 4.0),
  ];

  /* ===================== STARSHIP (ship frame: base at y=0, +Y nose, heat shield on +X) ===================== */
  const sProf = shipProfile();
  const sTex = steelTextures(
    sProf,
    1024,
    1024,
    1.83,
    [
      [2.4, 20.8],
      [22.4, 31.8],
    ],
    17,
  );
  const matSSteel = new T.MeshStandardMaterial({
    map: sTex.color,
    metalness: 0.72,
    roughness: 0.34,
    envMapIntensity: 1.0,
  });
  addMesh(new T.LatheGeometry(sProf.map(V2), 96), matSSteel, shipG);
  const matSFrost = matBFrost.clone();
  matSFrost.alphaMap = sTex.frost;
  const frostS = new T.Mesh(
    new T.LatheGeometry(
      sProf.map((p) => new T.Vector2(p[0] > 0.2 ? p[0] + 0.03 : p[0], p[1])),
      96,
    ),
    matSFrost,
  );
  frostS.renderOrder = 3;
  shipG.add(frostS);
  const hexTex = hexTileTex();
  const tileTex = hexTex.clone();
  tileTex.needsUpdate = true;
  tileTex.repeat.set(12.5, 46.5);
  const matTiles = new T.MeshStandardMaterial({
    map: tileTex,
    roughness: 0.82,
    metalness: 0.05,
    envMapIntensity: 0.35,
    emissive: 0x000000,
    emissiveIntensity: 1,
  });
  addMesh(
    new T.LatheGeometry(
      sProf.map((p) => new T.Vector2(p[0] > 0.05 ? p[0] + 0.05 : p[0], p[1])),
      72,
      -15 * D2R,
      210 * D2R,
    ),
    matTiles,
    shipG,
  );
  {
    const aft = addMesh(new T.CircleGeometry(4.4, 64), matAft, shipG);
    aft.rotation.x = Math.PI / 2;
    aft.position.y = 0.95;
  }
  /* flaps: forward pair on the nose, aft pair at the base; tiles on the windward face */
  const flaps: Flap[] = [];
  function makeFlap(
    beta: number,
    yC: number,
    span: number,
    chord: number,
    taper: number,
    thick: number,
    rootR: number,
    tilt: number,
  ) {
    const side = beta > 0 ? 1 : -1;
    const piv = new T.Group();
    piv.position.set(rootR * Math.cos(beta), yC, rootR * Math.sin(beta));
    piv.rotation.order = "YZX";
    shipG.add(piv);
    const g = new T.BoxGeometry(span, chord, thick, 4, 2, 1);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const xx = pa.getX(i) + span / 2;
      const tp = lerp(1, taper, xx / span);
      pa.setX(i, xx);
      pa.setY(i, pa.getY(i) * tp + (1 - tp) * chord * 0.18);
    }
    g.computeVertexNormals();
    const ft = hexTex.clone();
    ft.needsUpdate = true;
    ft.repeat.set(span / 1.3, chord / 1.14);
    const tileF = new T.MeshStandardMaterial({ map: ft, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.35 });
    const mats = [
      matFrameSteel,
      matFrameSteel,
      matFrameSteel,
      matFrameSteel,
      side > 0 ? matPlainSteel : tileF,
      side > 0 ? tileF : matPlainSteel,
    ];
    addMesh(g, mats, piv);
    boxAt(piv, matDarkMetal, 0.6, chord * 0.9, 0.9, 0.1, 0, 0);
    const f: Flap = { piv, beta, side, tilt, tileMat: tileF };
    flaps.push(f);
    return f;
  }
  const fwdTilt = Math.atan(9 / Math.sqrt(40.28 * 40.28 - 81));
  makeFlap(96 * D2R, 42.4, 3.4, 6.0, 0.55, 0.32, shipRadius(42.4) - 0.05, fwdTilt);
  makeFlap(-96 * D2R, 42.4, 3.4, 6.0, 0.55, 0.32, shipRadius(42.4) - 0.05, fwdTilt);
  makeFlap(84 * D2R, 6.8, 4.6, 10.0, 0.62, 0.5, 4.45, 0);
  makeFlap(-84 * D2R, 6.8, 4.6, 10.0, 0.62, 0.5, 4.45, 0);
  function setFlap(f: Flap, defl: number) {
    f.piv.rotation.set(0, -(f.beta + f.side * defl), f.tilt);
  }
  flaps.forEach((f) => setFlap(f, 60 * D2R));
  /* payload ("Pez") door on the leeward side and eight Starlink mass simulators */
  addMesh(
    new T.LatheGeometry([new T.Vector2(4.47, 31.15), new T.Vector2(4.47, 32.85)], 24, 232 * D2R, 76 * D2R),
    new T.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9, side: T.DoubleSide }),
    shipG,
    false,
  );
  const doorPanel = addMesh(
    new T.LatheGeometry([new T.Vector2(4.545, 31.1), new T.Vector2(4.545, 32.9)], 24, 231 * D2R, 78 * D2R),
    new T.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.7, roughness: 0.36, side: T.DoubleSide }),
    shipG,
  );
  const sats: Satellite[] = [];
  (function () {
    const body = () => new T.MeshStandardMaterial({ color: 0x5a6068, metalness: 0.6, roughness: 0.4 });
    const satMat = [
      body(),
      body(),
      new T.MeshStandardMaterial({ color: 0x1d2a3d, metalness: 0.35, roughness: 0.3, envMapIntensity: 1.2 }),
      new T.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.5, roughness: 0.5 }),
      body(),
      body(),
    ];
    const rng = makeRng(77);
    for (let k = 0; k < N_SATS; k++) {
      const m = addMesh(new T.BoxGeometry(2.7, 0.3, 4.3), satMat, shipG);
      m.visible = false;
      sats.push({
        mesh: m,
        t0: T_DEPLOY0 + k * DEPLOY_DT,
        vx: -(0.32 + 0.1 * rng()),
        vy: (rng() - 0.5) * 0.08,
        vz: (rng() - 0.5) * 0.14,
        wx: (rng() - 0.5) * 0.05,
        wy: (rng() - 0.5) * 0.06,
        wz: (rng() - 0.5) * 0.05,
      });
    }
  })();
  /* engines: 3 sea-level Raptors + 3 Raptor Vacuum */
  const SENG = [90, 210, 330].map((d) => ({ x: 1.3 * Math.cos(d * D2R), z: 1.3 * Math.sin(d * D2R) }));
  const RVAC = [30, 150, 270].map((d) => ({ x: 3.05 * Math.cos(d * D2R), z: 3.05 * Math.sin(d * D2R) }));
  const sCoreMat = plumeMat([0.95, 0.85, 1.0], [1.0, 0.6, 0.3], 22, 1.6, 0, 0.45);
  const sGlowMat = glowMatProto.clone();
  sGlowMat.color.setRGB(0, 0, 0);
  const sNozGeo = nozzleGeo(0.6, 1.7, 0.24, 28);
  const sGlowGeo = nozzleGeo(0.58, 1.68, 0.22, 20);
  const sCores = SENG.map(function (e) {
    const n = addMesh(sNozGeo, matNozzle, shipG);
    n.position.set(e.x, 0.15, e.z);
    const gl = new T.Mesh(sGlowGeo, sGlowMat);
    gl.position.copy(n.position);
    shipG.add(gl);
    const c = new T.Mesh(raptorCoreGeo, sCoreMat);
    c.position.set(e.x, 0.15, e.z);
    c.renderOrder = 8;
    c.frustumCulled = false;
    shipG.add(c);
    return c;
  });
  const sBigMat = plumeMat([1.0, 0.74, 0.46], [1.0, 0.46, 0.16], 40, 0.5, 0, 0.1);
  const sBig = new T.Mesh(coreCone(2.4, 7, 40), sBigMat);
  sBig.position.y = 0.1;
  sBig.renderOrder = 8;
  sBig.frustumCulled = false;
  shipG.add(sBig);
  const vacGeo = nozzleGeo(1.15, 3.3, 0.26, 40);
  const vacGlowGeo = nozzleGeo(1.12, 3.25, 0.24, 28);
  const vacPlumeGeo = coreCone(1.1, 9.0, 60);
  const vacMat = plumeMat([0.86, 0.78, 1.0], [0.95, 0.52, 0.38], 60, 0.42, 0, 0.0);
  const vacGlowMat = glowMatProto.clone();
  vacGlowMat.color.setRGB(0, 0, 0);
  const vacPlumes = RVAC.map(function (e) {
    const n = addMesh(vacGeo, matVac, shipG);
    n.position.set(e.x, -0.25, e.z);
    const gl = new T.Mesh(vacGlowGeo, vacGlowMat);
    gl.position.copy(n.position);
    shipG.add(gl);
    const p = new T.Mesh(vacPlumeGeo, vacMat);
    p.position.set(e.x, -0.25, e.z);
    p.renderOrder = 8;
    p.frustumCulled = false;
    shipG.add(p);
    return p;
  });
  /* re-entry plasma: sheath around the hull + trailing wake cones */
  const sheathMat = new T.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uTime: { value: 0 }, uFlow: { value: new T.Vector3(1, 0, 0) } },
    vertexShader: SHEATH_VERT,
    fragmentShader: SHEATH_FRAG,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const sheath = new T.Mesh(
    new T.LatheGeometry(
      sProf.map((p) => new T.Vector2(p[0] * 1.07 + 0.35, p[1] * 1.012 - 0.3)),
      64,
    ),
    sheathMat,
  );
  sheath.renderOrder = 9;
  sheath.visible = false;
  shipG.add(sheath);
  const wakeG = new T.Group();
  wakeG.position.y = 24;
  shipG.add(wakeG);
  const wakeCoreMat = plumeMat([1.0, 0.5, 0.36], [0.95, 0.3, 0.6], 260, 0.17, 0, 0.0);
  const wakeOuterMat = plumeMat([0.85, 0.32, 0.8], [0.45, 0.22, 0.95], 900, 0.06, 0, 0.0);
  [new T.Mesh(coreCone(7, 20, 260), wakeCoreMat), new T.Mesh(coreCone(12, 70, 900), wakeOuterMat)].forEach(
    function (m) {
      m.renderOrder = 9;
      m.frustumCulled = false;
      wakeG.add(m);
    },
  );
  wakeG.visible = false;
  const sVents = [new T.Vector3(-3.9, 29, 2.0), new T.Vector3(-4.2, 18, -1.4), new T.Vector3(3.0, 44, 1.6)];
  const sRcs: RcsPort[] = [
    { p: new T.Vector3(0, 47.5, 3.1), d: new T.Vector3(0, 0, 1) },
    { p: new T.Vector3(0, 47.5, -3.1), d: new T.Vector3(0, 0, -1) },
    { p: new T.Vector3(-3.4, 46.5, 0), d: new T.Vector3(-1, 0, 0) },
    { p: new T.Vector3(0, 9, 4.6), d: new T.Vector3(0, 0, 1) },
    { p: new T.Vector3(0, 9, -4.6), d: new T.Vector3(0, 0, -1) },
    { p: new T.Vector3(-4.6, 9, 0), d: new T.Vector3(-1, 0, 0) },
  ];

  /* ===================== STARBASE (pad frame: x east/downrange, y up, z south) ===================== */
  const padGroup = new T.Group();
  padFrame.add(padGroup);
  const TOWER_Z = -22.5;
  const TW = 4.6;
  const TOWER_H = 142;
  const CS_Y = CS_BASE - 1 + 61.5;
  const CS_PARK = 112;
  const matTowerCol = new T.MeshStandardMaterial({
    color: 0x6d7279,
    roughness: 0.55,
    metalness: 0.6,
    envMapIntensity: 0.8,
  });
  const matTowerLat = latticeMat(2, 31, 0x8a9097, true);
  const matArm = new T.MeshStandardMaterial({
    color: 0x3f4349,
    roughness: 0.55,
    metalness: 0.55,
    envMapIntensity: 0.8,
  });
  const matRail = new T.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.4, metalness: 0.75 });
  const matOLM = new T.MeshStandardMaterial({
    color: 0x8f9398,
    roughness: 0.62,
    metalness: 0.45,
    envMapIntensity: 0.7,
  });
  const matTank = new T.MeshStandardMaterial({
    color: 0xe6e8ea,
    roughness: 0.45,
    metalness: 0.25,
    envMapIntensity: 0.8,
  });
  function buildTower(parent: T.Object3D, z0: number, h: number) {
    const g = new T.Group();
    g.position.set(0, 0, z0);
    parent.add(g);
    const lat = addMesh(new T.BoxGeometry(TW * 2, h, TW * 2), matTowerLat, g);
    lat.position.y = h / 2;
    lat.castShadow = false;
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].forEach(function (q) {
      boxAt(g, matTowerCol, 1.0, h, 1.0, q[0] * (TW - 0.5), h / 2, q[1] * (TW - 0.5));
    });
    const levels = Math.floor(h / 9);
    const bars = new T.InstancedMesh(new T.BoxGeometry(TW * 2, 0.55, 0.55), matTowerCol, levels * 4);
    const mm = new T.Matrix4();
    const qq = new T.Quaternion();
    const sc = new T.Vector3(1, 1, 1);
    const pp = new T.Vector3();
    for (let l = 0; l < levels; l++)
      for (let s = 0; s < 4; s++) {
        const ang = (s * Math.PI) / 2;
        qq.setFromAxisAngle(Yax, ang);
        pp.set(Math.sin(ang) * (TW - 0.3), 9 * (l + 1), Math.cos(ang) * (TW - 0.3));
        bars.setMatrixAt(l * 4 + s, mm.compose(pp, qq, sc));
      }
    bars.castShadow = true;
    bars.receiveShadow = true;
    g.add(bars);
    boxAt(g, matTowerCol, 11, 7, 11, 0, h + 3.5, 0);
    boxAt(g, matArm, 4, 3, 16, 0, h + 8.5, -2);
    cylAt(g, matTowerCol, 0.22, 0.45, 18, 0, h + 16, 0, 10);
    return g;
  }
  function buildOLM(parent: T.Object3D, z0: number) {
    const g = new T.Group();
    g.position.set(0, 0, z0);
    parent.add(g);
    for (let k = 0; k < 6; k++) {
      const a = (k * 60 + 30) * D2R;
      boxAt(g, matOLM, 2.6, 18, 2.6, 10.6 * Math.cos(a), 9, 10.6 * Math.sin(a), -a);
    }
    addMesh(
      new T.LatheGeometry(
        [
          new T.Vector2(5.3, 18),
          new T.Vector2(11.8, 18),
          new T.Vector2(11.8, 22),
          new T.Vector2(5.3, 22),
          new T.Vector2(5.3, 18),
        ],
        72,
      ),
      matOLM,
      g,
    );
    const clamps = new T.InstancedMesh(new T.BoxGeometry(0.9, 1.2, 1.4), matDarkMetal, 20);
    const mm = new T.Matrix4();
    const qq = new T.Quaternion();
    const sc = new T.Vector3(1, 1, 1);
    const pp = new T.Vector3();
    for (let k = 0; k < 20; k++) {
      const b = ((k + 0.5) / 20) * TAU;
      qq.setFromAxisAngle(Yax, -b);
      pp.set(5.0 * Math.cos(b), 22.6, 5.0 * Math.sin(b));
      clamps.setMatrixAt(k, mm.compose(pp, qq, sc));
    }
    clamps.castShadow = true;
    g.add(clamps);
    cylAt(g, matDarkMetal, 13, 13.4, 0.6, 0, 0.3, 0, 64);
    for (let k = 0; k < 3; k++) {
      const a3 = (k * 120 + 90) * D2R;
      boxAt(g, matOLM, 2.2, 1.4, 14, 12.5 * Math.cos(a3), 0.7, 12.5 * Math.sin(a3), -a3 + Math.PI / 2);
    }
    return g;
  }
  buildTower(padGroup, TOWER_Z, TOWER_H);
  buildOLM(padGroup, 0);
  /* chopsticks on a carriage that rides the tower */
  const carriage = new T.Group();
  carriage.position.set(0, CS_PARK, 0);
  padGroup.add(carriage);
  (function () {
    const cl = latticeMat(3, 2, 0x5d6268, true);
    boxAt(carriage, cl, 13.4, 8.5, 1.0, 0, 2.4, TOWER_Z + TW + 0.9);
    boxAt(carriage, cl, 13.4, 8.5, 1.0, 0, 2.4, TOWER_Z - TW - 0.9);
    boxAt(carriage, cl, 1.0, 8.5, 13.4, TW + 0.9, 2.4, TOWER_Z);
    boxAt(carriage, cl, 1.0, 8.5, 13.4, -TW - 0.9, 2.4, TOWER_Z);
    boxAt(carriage, matArm, 14.4, 1.2, 1.6, 0, -1.2, TOWER_Z + TW + 0.9);
  })();
  const arms = [-1, 1].map(function (sx) {
    const piv = new T.Group();
    piv.position.set(sx * 6.4, 0, TOWER_Z + TW + 0.6);
    carriage.add(piv);
    const beamMat = latticeMat(1, 12, 0x494d53, false);
    boxAt(piv, matArm, 2.2, 0.5, 34, 0, -0.25, 17);
    boxAt(piv, matArm, 2.2, 0.5, 34, 0, -2.95, 17);
    const side = addMesh(new T.BoxGeometry(2.0, 2.4, 34), beamMat, piv);
    side.position.set(0, -1.6, 17);
    side.castShadow = false;
    boxAt(piv, matRail, 0.55, 0.4, 31, -sx * 0.8, 0.2, 18.5);
    boxAt(piv, matArm, 3.0, 4.6, 3.2, 0, -1.6, 1.0);
    return { piv, sx };
  });
  function setArms(deg: number) {
    arms.forEach(function (a) {
      a.piv.rotation.y = a.sx * deg * D2R;
    });
  }
  setArms(44);
  /* ship quick-disconnect arm */
  const qdPiv = new T.Group();
  qdPiv.position.set(-TW + 0.6, H_OLM + L_B + 8.5, TOWER_Z + TW + 0.4);
  padGroup.add(qdPiv);
  boxAt(qdPiv, latticeMat(1, 5, 0x5a5f66, true), 2.6, 3.0, 13.2, 0, 0, 6.6);
  boxAt(qdPiv, matArm, 2.9, 0.4, 13.2, 0, 1.6, 6.6);
  boxAt(qdPiv, matDarkMetal, 3.2, 3.6, 0.8, 0, 0, 13.2);
  const QD_ON = 17.6 * D2R;
  const QD_OFF = -82 * D2R;
  qdPiv.rotation.y = QD_ON;
  /* tank farm, Pad B, lightning masts */
  (function () {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++) {
        cylAt(padGroup, matTank, 4.2, 4.2, 26, -190 + i * 13, 13, -100 + j * 13, 28);
        cylAt(padGroup, matTank, 0.1, 4.2, 2.2, -190 + i * 13, 27.1, -100 + j * 13, 28);
      }
    for (let h = 0; h < 3; h++) {
      const ht = cylAt(padGroup, matTank, 2.6, 2.6, 32, -150, 3.2, -40 + h * 7, 24);
      ht.rotation.z = Math.PI / 2;
    }
    boxAt(padGroup, matOLM, 40, 6, 18, -200, 3, 40);
    buildTower(padGroup, 365 + TOWER_Z, TOWER_H);
    buildOLM(padGroup, 365);
    const c2 = new T.Group();
    c2.position.set(0, 120, 365);
    padGroup.add(c2);
    [-1, 1].forEach(function (sx) {
      const p = new T.Group();
      p.position.set(sx * 6.4, 0, TOWER_Z + TW + 0.6);
      p.rotation.y = sx * 30 * D2R;
      c2.add(p);
      boxAt(p, matArm, 2.2, 3.2, 34, 0, -1.6, 17);
    });
    boxAt(c2, matArm, 14.4, 8.5, 14.4, 0, 2.4, TOWER_Z);
  })();
  /* receives the long sunrise shadows on the apron and scrub */
  const shadowCatcher = new T.Mesh(
    new T.PlaneGeometry(2600, 2600),
    new T.ShadowMaterial({
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = 0.05;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 2;
  padGroup.add(shadowCatcher);

  /* ---------- local terrain caps (true curvature): Starbase and the splashdown ocean ---------- */
  function makeCap(mat: T.Material, parent: T.Object3D) {
    const radii = [0];
    let r = 4;
    while (r < 150000) {
      radii.push(r);
      r *= 1.075;
    }
    radii.push(150000);
    const SEG = 192;
    const pos: number[] = [0, 0, 0];
    const idx: number[] = [];
    for (let k = 1; k < radii.length; k++)
      for (let j = 0; j < SEG; j++) {
        const a = (j / SEG) * TAU;
        const rr = radii[k];
        pos.push(rr * Math.cos(a), (-rr * rr) / (2 * RE), rr * Math.sin(a));
      }
    for (let j = 0; j < SEG; j++) idx.push(0, 1 + ((j + 1) % SEG), 1 + j);
    for (let k = 1; k < radii.length - 1; k++)
      for (let j = 0; j < SEG; j++) {
        const a0 = 1 + (k - 1) * SEG + j;
        const a1 = 1 + (k - 1) * SEG + ((j + 1) % SEG);
        const b0 = a0 + SEG;
        const b1 = a1 + SEG;
        idx.push(a0, a1, b0, a1, b1, b0);
      }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new T.Mesh(g, mat);
    m.renderOrder = 1;
    m.frustumCulled = false;
    parent.add(m);
    return m;
  }
  const capMat = new T.ShaderMaterial({
    uniforms: {
      uSun: { value: new T.Vector3() },
      uCamRel: { value: new T.Vector3() },
      uCenter: { value: CENTER.clone() },
      uSunI: { value: 20 },
      uExposure: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: CAP_VERT,
    fragmentShader: CAP_FRAG,
    transparent: true,
    depthWrite: true,
  });
  capMat.extensions.derivatives = true;
  const cap = makeCap(capMat, padFrame);
  const oceanMat = new T.ShaderMaterial({
    uniforms: {
      uSun: { value: new T.Vector3() },
      uCamRel: { value: new T.Vector3() },
      uCenter: { value: CENTER.clone() },
      uSunI: { value: 20 },
      uExposure: { value: 1 },
      uTime: { value: 0 },
      uSkyZ: { value: new T.Vector3() },
      uSkyH: { value: new T.Vector3() },
      uSkyA: { value: new T.Vector3() },
      uFoam: { value: 0 },
      uFoamC: { value: new T.Vector2() },
      uFoamR: { value: 60 },
      uGlowP: { value: new T.Vector3() },
      uGlowI: { value: 0 },
    },
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    transparent: true,
    depthWrite: true,
  });
  oceanMat.extensions.derivatives = true;
  const oceanCap = makeCap(oceanMat, landFrame);
  /* splashdown zone: a camera buoy and a marker buoy */
  const landGroup = new T.Group();
  landFrame.add(landGroup);
  const BUOY_CAM = new T.Vector3(235, 2.4, 650);
  const buoys = [
    [130, 300],
    [BUOY_CAM.x + 6, BUOY_CAM.z + 4],
  ].map(function (q) {
    const g = new T.Group();
    g.position.set(q[0], 0, q[1]);
    landGroup.add(g);
    const mo = new T.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.5, metalness: 0.1 });
    cylAt(g, mo, 0.9, 1.1, 1.6, 0, 0.2, 0, 16);
    cylAt(g, matFrameSteel, 0.06, 0.06, 3.2, 0, 2.4, 0, 6);
    cylAt(g, new T.MeshBasicMaterial({ color: 0xffd27a }), 0.12, 0.12, 0.25, 0, 4.1, 0, 8, false);
    return { g, ph: q[0] * 0.01 };
  });

  /* ===================== EARTH (true scale), clouds ===================== */
  const NORTH = new T.Vector3(0, Math.sin(LAT), -Math.cos(LAT));
  earthGroup.quaternion.setFromUnitVectors(Yax, NORTH);
  const qInv = earthGroup.quaternion.clone().invert();
  const siteObj = new T.Vector3(0, 1, 0).applyQuaternion(qInv);
  const eastObj = new T.Vector3(1, 0, 0).applyQuaternion(qInv);
  const site2Obj = new T.Vector3(Math.sin(TH_L), Math.cos(TH_L), 0).applyQuaternion(qInv);
  const maxTex = renderer.capabilities.maxTextureSize || 4096;
  const bakeW = Math.min(hi ? 4096 : 2048, maxTex);
  const bakeH = bakeW / 2;
  function makeRT() {
    const rt = new T.WebGLRenderTarget(bakeW, bakeH, {
      minFilter: T.LinearMipmapLinearFilter,
      magFilter: T.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
      wrapS: T.RepeatWrapping,
      wrapT: T.ClampToEdgeWrapping,
    });
    rt.texture.anisotropy = maxAniso;
    return rt;
  }
  const rtAlbedo = makeRT();
  const rtAux = makeRT();
  const bakeScene = new T.Scene();
  const bakeCam = new T.Camera();
  const bakeMat = new T.ShaderMaterial({
    uniforms: {
      uMode: { value: 0 },
      uSite: { value: siteObj },
      uEast: { value: eastObj },
      uSite2: { value: site2Obj },
    },
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const bakeQuad = new T.Mesh(new T.PlaneGeometry(2, 2), bakeMat);
  bakeQuad.frustumCulled = false;
  bakeScene.add(bakeQuad);
  /* the Earth textures bake in strips over the first frames so the page stays responsive */
  const STRIPS = 16;
  const bakeJobs: { rt: T.WebGLRenderTarget; mode: number; strip: number }[] = [];
  for (let i = 0; i < STRIPS; i++) bakeJobs.push({ rt: rtAlbedo, mode: 0, strip: i });
  for (let i = 0; i < STRIPS; i++) bakeJobs.push({ rt: rtAux, mode: 1, strip: i });
  const bakeTotal = bakeJobs.length;
  function bakeStep() {
    const job = bakeJobs.shift();
    if (!job) return;
    const h = bakeH / STRIPS;
    bakeMat.uniforms.uMode.value = job.mode;
    job.rt.scissor.set(0, job.strip * h, bakeW, h);
    job.rt.scissorTest = true;
    renderer.setRenderTarget(job.rt);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(null);
    job.rt.scissorTest = false;
  }
  const CLOUD_ALT = 5000;
  const SITE_COS = Math.cos(100000 / RE);
  const earthMat = new T.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: rtAlbedo.texture },
      uAux: { value: rtAux.texture },
      uSun: { value: new T.Vector3() },
      uCamRel: { value: new T.Vector3() },
      uCenter: { value: CENTER.clone() },
      uTexel: { value: new T.Vector2(1 / bakeW, 1 / bakeH) },
      uSunI: { value: 20 },
      uExposure: { value: 1 },
      uSite: { value: siteObj },
      uSiteCos: { value: SITE_COS },
      uSite2: { value: site2Obj },
      uSiteCos2: { value: 2 },
    },
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_FRAG,
  });
  earthMat.extensions.derivatives = true;
  const earth = new T.Mesh(new T.SphereGeometry(RE, hi ? 512 : 384, hi ? 256 : 192), earthMat);
  earth.visible = false;
  earth.frustumCulled = false;
  earthGroup.add(earth);
  const cloudMat = new T.ShaderMaterial({
    uniforms: {
      uAux: { value: rtAux.texture },
      uSun: { value: new T.Vector3() },
      uCamRel: { value: new T.Vector3() },
      uCenter: { value: CENTER.clone() },
      uSunI: { value: 20 },
      uExposure: { value: 1 },
      uBelow: { value: 1 },
    },
    vertexShader: EARTH_VERT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
  });
  cloudMat.extensions.derivatives = true;
  const clouds = new T.Mesh(new T.SphereGeometry(RE + CLOUD_ALT, hi ? 384 : 256, hi ? 192 : 128), cloudMat);
  clouds.visible = false;
  clouds.renderOrder = 2;
  clouds.frustumCulled = false;
  earthGroup.add(clouds);
  const skyMat = new T.ShaderMaterial({
    uniforms: {
      uCamRel: { value: new T.Vector3() },
      uSun: { value: new T.Vector3() },
      uSunI: { value: 20 },
      uExposure: { value: 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: T.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const sky = new T.Mesh(new T.SphereGeometry(1e7, 96, 48), skyMat);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  scene.add(sky);

  /* ===================== deep space: layered starfield ===================== */
  const starMat = new T.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPR: { value: pixelRatio() }, uVis: { value: 0 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    depthWrite: false,
    depthTest: false,
    blending: T.AdditiveBlending,
  });
  const stars = (function () {
    const rnd = makeRng(1031);
    const group = new T.Group();
    const RAD = 3e7;
    const pal = [
      [0.72, 0.8, 1.0],
      [0.88, 0.92, 1.0],
      [1.0, 0.98, 0.95],
      [1.0, 0.92, 0.8],
      [1.0, 0.82, 0.62],
    ];
    const bN = new T.Vector3(0.35, 0.62, -0.7).normalize();
    const bU = new T.Vector3().crossVectors(bN, Zax).normalize();
    const bV = new T.Vector3().crossVectors(bN, bU).normalize();
    function gauss() {
      const a = 1 - rnd();
      const b = rnd();
      return Math.sqrt(-2 * Math.log(a)) * Math.cos(TAU * b);
    }
    function layer(count: number, sMin: number, sMax: number, bMin: number, bMax: number, tw: number, band: boolean) {
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      const size = new Float32Array(count);
      const twk = new Float32Array(count);
      const d = new T.Vector3();
      for (let k = 0; k < count; k++) {
        if (band) {
          const th = rnd() < 0.55 ? gauss() * 0.9 : rnd() * TAU;
          const w = gauss() * 0.1 * (1 + 0.8 * Math.max(0, Math.cos(th)));
          d.copy(bU).multiplyScalar(Math.cos(th)).addScaledVector(bV, Math.sin(th)).addScaledVector(bN, w).normalize();
        } else {
          const z = rnd() * 2 - 1;
          const t = rnd() * TAU;
          const r = Math.sqrt(1 - z * z);
          d.set(r * Math.cos(t), z, r * Math.sin(t));
        }
        pos[k * 3] = d.x * RAD;
        pos[k * 3 + 1] = d.y * RAD;
        pos[k * 3 + 2] = d.z * RAD;
        const c = pal[Math.floor(rnd() * pal.length)];
        const br = lerp(bMin, bMax, Math.pow(rnd(), 1.6));
        col[k * 3] = c[0] * br;
        col[k * 3 + 1] = c[1] * br;
        col[k * 3 + 2] = c[2] * br;
        size[k] = lerp(sMin, sMax, rnd());
        twk[k] = tw * rnd();
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("aColor", new T.BufferAttribute(col, 3));
      g.setAttribute("aSize", new T.BufferAttribute(size, 1));
      g.setAttribute("aTw", new T.BufferAttribute(twk, 1));
      const p = new T.Points(g, starMat);
      p.frustumCulled = false;
      p.renderOrder = -90;
      group.add(p);
    }
    layer(16000, 0.8, 1.5, 0.1, 0.32, 0, true);
    layer(7000, 1.0, 1.7, 0.25, 0.65, 0, false);
    layer(1700, 1.5, 2.6, 0.55, 1.0, 0.15, false);
    layer(150, 2.6, 4.4, 0.9, 1.25, 0.35, false);
    scene.add(group);
    return group;
  })();

  /* ===================== GPU particle systems ===================== */
  const puffTex = (function () {
    const S2 = 128;
    const c = newCanvas(S2, S2);
    const x = ctx2d(c);
    const img = x.createImageData(S2, S2);
    for (let py = 0; py < S2; py++)
      for (let px = 0; px < S2; px++) {
        const dx = ((px + 0.5) / S2) * 2 - 1;
        const dy = ((py + 0.5) / S2) * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const n = vnoise(px / 14, py / 14) * 0.55 + vnoise(px / 6, py / 6) * 0.3 + vnoise(px / 2.6, py / 2.6) * 0.15;
        let a = clamp((1 - r) * 1.7, 0, 1);
        a = a * a * (0.4 + 0.8 * n);
        const o = (py * S2 + px) * 4;
        img.data[o] = 255;
        img.data[o + 1] = 255;
        img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    x.putImageData(img, 0, 0);
    const t = new T.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  })();
  const sunV = new T.Vector3();
  const sunCol = new T.Vector3(1, 1, 1);
  const ambCol = new T.Vector3(0.4, 0.45, 0.55);
  const fogCol = new T.Vector3(0.6, 0.7, 0.82);
  const flameCol = new T.Vector3(1.0, 0.55, 0.22);
  const allPuffs: Puffs[] = [];
  function makePuffs(cap: number, additive: boolean, parent: T.Object3D): Puffs {
    const base = new T.PlaneGeometry(1, 1);
    const g = new T.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute("position", base.getAttribute("position"));
    g.setAttribute("uv", base.getAttribute("uv"));
    const arrs = [
      new Float32Array(cap * 4),
      new Float32Array(cap * 4),
      new Float32Array(cap * 4),
      new Float32Array(cap * 4),
    ];
    for (let k = 0; k < cap; k++) {
      arrs[0][k * 4 + 3] = -1e9;
      arrs[1][k * 4 + 3] = 1;
    }
    const attrs = ["iA", "iB", "iC", "iD"].map(function (nm, j) {
      const at = new T.InstancedBufferAttribute(arrs[j], 4);
      at.setUsage(T.DynamicDrawUsage);
      g.setAttribute(nm, at);
      return at;
    });
    g.instanceCount = cap;
    const mat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGrav: { value: new T.Vector3() },
        uWind: { value: new T.Vector3() },
        uUp: { value: new T.Vector3(0, 1, 0) },
        uBuoy: { value: 0 },
        uMode: { value: additive ? 1 : 0 },
        uFlameW: { value: new T.Vector3() },
        uFlameI: { value: 0 },
        uFlameCol: { value: flameCol },
        uFogD: { value: 0 },
        uTex: { value: puffTex },
        uSunV: { value: sunV },
        uSunCol: { value: sunCol },
        uAmb: { value: ambCol },
        uFogCol: { value: fogCol },
      },
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? T.AdditiveBlending : T.NormalBlending,
    });
    const mesh = new T.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? 7 : 6;
    parent.add(mesh);
    const [PA, PB, PC, PD] = arrs;
    let next = 0;
    let lo = cap;
    let hiIdx = -1;
    const P: Puffs = {
      mat,
      emit(px, py, pz, vx, vy, vz, birth, life, s0, s1, op, r, gg, b, drag) {
        const k = next;
        next = (k + 1) % cap;
        const o = k * 4;
        PA[o] = px;
        PA[o + 1] = py;
        PA[o + 2] = pz;
        PA[o + 3] = birth;
        PB[o] = vx;
        PB[o + 1] = vy;
        PB[o + 2] = vz;
        PB[o + 3] = life;
        PC[o] = s0;
        PC[o + 1] = s1;
        PC[o + 2] = Math.random();
        PC[o + 3] = op;
        PD[o] = r;
        PD[o + 1] = gg;
        PD[o + 2] = b;
        PD[o + 3] = drag;
        if (k < lo) lo = k;
        if (k > hiIdx) hiIdx = k;
      },
      flush() {
        if (hiIdx < lo) return;
        for (const at of attrs) {
          at.updateRange.offset = lo * 4;
          at.updateRange.count = (hiIdx - lo + 1) * 4;
          at.needsUpdate = true;
        }
        lo = cap;
        hiIdx = -1;
      },
      clear() {
        for (let k2 = 0; k2 < cap; k2++) PA[k2 * 4 + 3] = -1e9;
        lo = 0;
        hiIdx = cap - 1;
        next = 0;
      },
    };
    allPuffs.push(P);
    return P;
  }
  const padSmoke = makePuffs(hi ? 24000 : 14000, false, padFrame);
  padSmoke.mat.uniforms.uBuoy.value = 1.6;
  padSmoke.mat.uniforms.uWind.value.set(3.0, 0, -1.2);
  const padSpray = makePuffs(4000, false, padFrame);
  padSpray.mat.uniforms.uGrav.value.set(0, -9.8, 0);
  const bFlames = makePuffs(hi ? 3600 : 2400, true, boosterG);
  const bGas = makePuffs(1200, false, boosterG);
  bGas.mat.uniforms.uWind.value.set(0.6, -0.7, 0.3);
  const sFlames = makePuffs(hi ? 4200 : 2800, true, shipG);
  const sGas = makePuffs(1600, false, shipG);
  sGas.mat.uniforms.uWind.value.set(0.4, -0.6, 0.2);
  const landSteam = makePuffs(hi ? 9000 : 6000, false, landFrame);
  landSteam.mat.uniforms.uBuoy.value = 2.0;
  landSteam.mat.uniforms.uWind.value.set(2.2, 0, 1.0);
  const landSpray = makePuffs(5000, false, landFrame);
  landSpray.mat.uniforms.uGrav.value.set(0, -9.8, 0);
  const landFire = makePuffs(3000, true, landFrame);
  landFire.mat.uniforms.uBuoy.value = 5.0;
  /* world particles age with mission time, vehicle-attached ones with real time */
  const worldPuffs = [padSmoke, padSpray, landSteam, landSpray, landFire];
  const localPuffs = [bFlames, bGas, sFlames, sGas];

  /* ===================== mission state ===================== */
  let simT = T_START;
  let realT = 0;
  let last = performance.now();
  let raf = 0;
  let disposed = false;
  let ready = false;
  let statusAcc = 1;
  let wCur = 0;
  const bs: BState = { th: 0, h: H_OLM, vh: 0, vv: 0, v: 0, psi: Math.PI / 2, eng: 0, thr: 0, gf: 1, q: 0 };
  const ss: SState = {
    th: 0,
    h: H_OLM + L_B,
    vh: 0,
    vv: 0,
    v: 0,
    psi: Math.PI / 2,
    sl: 0,
    vac: 0,
    thr: 0,
    gf: 1,
    q: 0,
    heat: 0,
  };
  const tmpA = newAscentSample();
  const tmpB: BState = { ...bs };
  const tmpS: SState = { ...ss };
  const tmpV = new T.Vector3();
  const tmpV2 = new T.Vector3();
  const tmpV3 = new T.Vector3();
  const qTmp = new T.Quaternion();
  let thF = 0;
  let focus: Focus = "stack";
  let blend: { from: Focus; t0: number } | null = null;
  /** Entry angle of attack: belly-first, easing toward 70 deg at hypersonic speed. */
  function aoaFor(v: number) {
    return (90 - 20 * smoothstep(380, 2600, v)) * D2R;
  }
  function fromXY(o: SState, x: number, y: number, vx: number, vy: number, th: number) {
    const r = Math.sqrt(x * x + y * y);
    o.h = r - RE;
    o.th = th;
    o.vv = (x * vx + y * vy) / r;
    o.vh = (y * vx - x * vy) / r;
    o.v = Math.sqrt(vx * vx + vy * vy);
  }
  function boosterState(t: number, o: BState) {
    if (t < T_SEP) {
      A.sample(t, tmpA);
      o.th = tmpA.s / RE;
      o.h = H_OLM + tmpA.h;
      o.v = tmpA.v;
      o.vh = tmpA.v * Math.cos(tmpA.gam);
      o.vv = tmpA.v * Math.sin(tmpA.gam);
      o.psi = t < 0 ? Math.PI / 2 : tmpA.gam;
      o.eng = boosterEnginesAscent(t);
      o.thr = boosterThrottle(t) / 100;
      o.gf = t < 0 ? 1 : tmpA.gf;
      o.q = tmpA.q;
    } else {
      B.sample(t, o);
      o.thr = 1;
      o.q = 0.5 * 1.225 * Math.exp(-Math.max(o.h, 0) / 8500) * o.v * o.v;
    }
    return o;
  }
  function shipState(t: number, o: SState) {
    o.sl = 0;
    o.vac = 0;
    o.thr = 0;
    o.heat = 0;
    o.q = 0;
    if (t < T_SECO) {
      A.sample(t, tmpA);
      const gam = t < 0 ? Math.PI / 2 : tmpA.gam;
      const off = t < T_SEP ? L_B : L_B * (1 - smoothstep(T_SEP, T_SEP + 40, t));
      o.h = H_OLM + tmpA.h + off * Math.sin(gam);
      o.th = tmpA.s / RE + (off * Math.cos(gam)) / (RE + o.h);
      o.v = tmpA.v;
      o.vh = tmpA.v * Math.cos(gam);
      o.vv = tmpA.v * Math.sin(gam);
      o.psi = gam;
      o.gf = t < 0 ? 1 : tmpA.gf;
      o.q = tmpA.q;
      if (t >= T_SHIPIGN) {
        o.sl = 3;
        o.vac = 3;
        o.thr = clamp(tmpA.sthr / 100, 0.4, 1);
      }
      return o;
    }
    if (t < SH.tEI) {
      const f = t - T_SECO;
      const i = Math.min(SH.CX.length - 2, Math.floor(f));
      const w = f - i;
      fromXY(
        o,
        lerp(SH.CX[i], SH.CX[i + 1], w),
        lerp(SH.CY[i], SH.CY[i + 1], w),
        lerp(SH.CVX[i], SH.CVX[i + 1], w),
        lerp(SH.CVY[i], SH.CVY[i + 1], w),
        lerp(SH.CTH[i], SH.CTH[i + 1], w),
      );
      o.psi = Math.atan2(o.vv, o.vh) + smoothstep(T_ENTRY_ATT, T_ENTRY_ATT + 90, t) * aoaFor(o.v);
      o.gf = 0;
      if (t >= T_RELIGHT && t < T_RELIGHT + RELIGHT_DUR) {
        o.sl = 1;
        o.thr = clamp((t - T_RELIGHT) / 0.4, 0, 1) * 0.8;
        o.gf = 0.15;
      }
      return o;
    }
    if (t < SH.tF) {
      const f2 = (t - SH.tEI) / 0.25;
      const j = Math.min(SH.RX.length - 2, Math.floor(f2));
      const w2 = f2 - j;
      fromXY(
        o,
        lerp(SH.RX[j], SH.RX[j + 1], w2),
        lerp(SH.RY[j], SH.RY[j + 1], w2),
        lerp(SH.RVX[j], SH.RVX[j + 1], w2),
        lerp(SH.RVY[j], SH.RVY[j + 1], w2),
        lerp(SH.RTH[j], SH.RTH[j + 1], w2),
      );
      o.psi = Math.atan2(o.vv, o.vh) + aoaFor(o.v);
      o.heat = clamp(lerp(SH.RQ[j], SH.RQ[j + 1], w2) / SH.qMax, 0, 1);
      o.gf = lerp(SH.RG[j], SH.RG[j + 1], w2);
      o.q = 0.5 * 1.225 * Math.exp(-Math.max(o.h, 0) / 7200) * o.v * o.v;
      return o;
    }
    const tau = t - SH.tF;
    const vF = SH.vF;
    const psi0 = SH.gamF + aoaFor(vF);
    o.th = SH.thLand + (SH.vhF * Math.min(tau, 1.7)) / RE;
    o.vh = 0;
    if (t < SH.tSplash) {
      let h: number;
      let vv: number;
      if (tau < SH.T0) {
        h = SH.hF - vF * tau;
        vv = -vF;
      } else if (tau < SH.T0 + SH.T1) {
        const u = tau - SH.T0;
        h = SH.h1 - vF * u + 0.5 * SH.aL * u * u;
        vv = -vF + SH.aL * u;
      } else {
        const u2 = tau - SH.T0 - SH.T1;
        h = 3 - 2 * u2;
        vv = -2;
      }
      o.h = Math.max(h, 0);
      o.vv = vv;
      o.v = Math.abs(vv);
      o.psi = lerp(psi0, Math.PI / 2, easeInOut(tau / 3.4));
      o.sl = 3;
      o.thr = clamp(tau / 0.5, 0.15, 1);
      o.gf = tau < SH.T0 ? 0.6 : (SH.aL + 9.81) / G0;
    } else {
      o.h = -2.6 * smoothstep(SH.tSplash, SH.tSplash + 5, t);
      o.vv = 0;
      o.v = 0;
      const u3 = clamp((t - SH.tTip) / (SH.tImpact - SH.tTip), 0, 1);
      o.psi = Math.PI / 2 - 86 * D2R * u3 * u3;
      o.sl = t < SH.tSplash + 0.4 ? 3 : 0;
      o.thr = 1 - clamp((t - SH.tSplash) / 0.4, 0, 1);
      o.gf = 1;
    }
    o.q = 0.5 * 1.225 * o.v * o.v;
    return o;
  }
  /** Inertial point (pad-frame coordinates) at distance `off` along a vehicle's axis. */
  function axisPointPad(st: { th: number; h: number; psi: number }, off: number, out: T.Vector3) {
    const r = RE + st.h;
    const s = Math.sin(st.th);
    const c = Math.cos(st.th);
    const cp = Math.cos(st.psi);
    const sp = Math.sin(st.psi);
    return out.set(r * s + off * (cp * c + sp * s), r * c - RE + off * (-cp * s + sp * c), 0);
  }

  /* ---------- events ---------- */
  const vSep = A.sample(T_SEP, newAscentSample());
  const vEI = Math.sqrt(SH.RVX[0] * SH.RVX[0] + SH.RVY[0] * SH.RVY[0]);
  const events: MissionEvent[] = [
    { t: T_START, key: "go" },
    { t: T_QD, key: "qd" },
    { t: T_DELUGE, key: "deluge" },
    { t: T_IGN, key: "ign" },
    { t: 0, key: "liftoff" },
    { t: tTower, key: "tower" },
    { t: A.tMaxQ, key: "maxq", values: [A.qMax / 1000] },
    { t: T_BMECO, key: "meco" },
    { t: T_SHIPIGN, key: "hot" },
    { t: T_SEP, key: "sep", values: [(H_OLM + vSep.h) / 1000, vSep.v * 3.6] },
    { t: T_BB0, key: "bb" },
    { t: B.tBBe, key: "bbend", values: [B.apogee / 1000] },
    { t: T_HSR, key: "hsr" },
    { t: B.tIgn, key: "blb" },
    { t: B.tCatch, key: "catch" },
    { t: T_SECO, key: "seco", values: [A.V[A.N - 1] * 3.6] },
    { t: T_DOOR, key: "door" },
    { t: T_DEPLOY0, key: "sats" },
    { t: SH.tApo, key: "apo" },
    { t: T_DEPLOY0 + (N_SATS - 1) * DEPLOY_DT + 3, key: "satsok" },
    { t: T_DOOR_CLOSE, key: "doorc" },
    { t: T_RELIGHT, key: "relight" },
    { t: T_ENTRY_ATT, key: "att" },
    { t: SH.tEI, key: "ei", values: [vEI * 3.6] },
    { t: SH.tPeak, key: "peak", values: [SH.gMax] },
    { t: SH.tSub, key: "sub" },
    { t: SH.tF, key: "flip", values: [SH.hF] },
    { t: SH.tSplash, key: "splash" },
    { t: SH.tImpact, key: "tip" },
  ];
  events.sort((a, b) => a.t - b.t);
  let evIdx = 0;
  let log: { t: number; key: EventKey }[] = [];
  let toast: { key: EventKey; values?: number[]; at: number; id: string } | null = null;
  function pushEvent(ev: MissionEvent) {
    log.unshift({ t: ev.t, key: ev.key });
    if (log.length > 7) log.length = 7;
    toast = { key: ev.key, values: ev.values, at: realT, id: ev.key + ":" + Math.round(ev.t) };
  }

  /* ---------- hot-stage ring debris ---------- */
  let hsrSplash = false;
  function jettisonHSR(t: number) {
    boosterState(t, tmpB);
    const r = RE + tmpB.h;
    const s = Math.sin(tmpB.th);
    const c = Math.cos(tmpB.th);
    const cp = Math.cos(tmpB.psi);
    const sp = Math.sin(tmpB.psi);
    const ax = cp * c + sp * s;
    const ay = -cp * s + sp * c;
    hsrDeb.x = r * s + 69 * ax;
    hsrDeb.y = r * c + 69 * ay;
    hsrDeb.vx = tmpB.vh * c + tmpB.vv * s + 3.0 * ax;
    hsrDeb.vy = tmpB.vh * -s + tmpB.vv * c + 3.0 * ay;
    hsrDeb.z = 0;
    hsrDeb.ang = tmpB.psi;
    hsrDeb.th = tmpB.th;
    hsrDeb.w = 0.45;
    hsrDeb.t = t;
    hsrDeb.sep = true;
    boosterG.remove(hsr);
    scene.add(hsr);
  }
  function integrateHSR(t: number) {
    let steps = 0;
    while (hsrDeb.t < t - 1e-6 && steps++ < 6000) {
      const dt = Math.min(0.1, t - hsrDeb.t);
      const r = Math.sqrt(hsrDeb.x * hsrDeb.x + hsrDeb.y * hsrDeb.y);
      const h = r - RE;
      if (h <= 0) {
        hsrDeb.t = t;
        break;
      }
      const g = -MU_E / (r * r * r);
      const v = Math.sqrt(hsrDeb.vx * hsrDeb.vx + hsrDeb.vy * hsrDeb.vy);
      const D = (0.5 * 1.225 * Math.exp(-h / 7200) * v * 40) / 9000;
      hsrDeb.vx += (g * hsrDeb.x - D * hsrDeb.vx) * dt;
      hsrDeb.vy += (g * hsrDeb.y - D * hsrDeb.vy) * dt;
      hsrDeb.x += hsrDeb.vx * dt;
      hsrDeb.y += hsrDeb.vy * dt;
      hsrDeb.z += 0.8 * dt;
      hsrDeb.ang += hsrDeb.w * dt;
      hsrDeb.t += dt;
      let d = Math.atan2(hsrDeb.x, hsrDeb.y) - hsrDeb.th;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      hsrDeb.th += d;
    }
    const rr = Math.sqrt(hsrDeb.x * hsrDeb.x + hsrDeb.y * hsrDeb.y);
    if (rr - RE <= 0 && !hsrSplash) {
      hsrSplash = true;
      hsr.visible = false;
      const px = RE * Math.sin(hsrDeb.th);
      const py = RE * Math.cos(hsrDeb.th) - RE;
      for (let k = 0; k < 90; k++) {
        const a = Math.random() * TAU;
        const sp = 6 + Math.random() * 14;
        padSpray.emit(
          px + Math.cos(a) * 3,
          py + 0.5,
          hsrDeb.z + Math.sin(a) * 3,
          Math.cos(a) * sp * 0.6,
          8 + Math.random() * 16,
          Math.sin(a) * sp * 0.6,
          hsrDeb.t + Math.random() * 0.2,
          2.4 + Math.random(),
          1.2,
          6,
          0.6,
          0.94,
          0.96,
          1.0,
          0.2,
        );
      }
    }
  }
  function placeHSR() {
    const dth = hsrDeb.th - thF;
    const rr = Math.sqrt(hsrDeb.x * hsrDeb.x + hsrDeb.y * hsrDeb.y);
    hsr.position.set(rr * Math.sin(dth), rr * Math.cos(dth) - RE, hsrDeb.z);
    hsr.quaternion.setFromAxisAngle(Zax, hsrDeb.ang - Math.PI / 2 - dth);
    qTmp.setFromAxisAngle(Xax, (hsrDeb.t - T_HSR) * 0.31);
    hsr.quaternion.multiply(qTmp);
  }

  /* ---------- event side effects ---------- */
  let shipGone = false;
  function fireEvent(ev: MissionEvent) {
    if (ev.key === "hsr") jettisonHSR(ev.t);
    if (ev.key === "splash") {
      shipState(ev.t, tmpS);
      const px = (tmpS.th - TH_L) * RE;
      for (let k = 0; k < 220; k++) {
        const a = Math.random() * TAU;
        const sp = 8 + Math.random() * 22;
        landSpray.emit(
          px + Math.cos(a) * 4,
          0.5,
          Math.sin(a) * 4,
          Math.cos(a) * sp,
          6 + Math.random() * 14,
          Math.sin(a) * sp,
          ev.t + Math.random() * 0.3,
          2.2 + Math.random() * 1.5,
          1.2,
          6,
          0.55,
          0.95,
          0.97,
          1.0,
          0.25,
        );
      }
    }
    if (ev.key === "tip") {
      shipState(ev.t, tmpS);
      const x0 = (tmpS.th - TH_L) * RE;
      for (let j = 0; j < 260; j++) {
        const x = x0 + Math.random() * 50;
        const a2 = Math.random() * TAU;
        landFire.emit(
          x,
          2 + Math.random() * 4,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 22,
          8 + Math.random() * 26,
          (Math.random() - 0.5) * 22,
          ev.t + Math.random() * 0.5,
          1.4 + Math.random() * 1.8,
          6,
          24 + Math.random() * 18,
          0.85,
          1.0,
          0.86,
          0.62,
          0.8,
        );
        if (j < 200)
          landSpray.emit(
            x,
            0.5,
            (Math.random() - 0.5) * 10,
            Math.cos(a2) * 14,
            10 + Math.random() * 30,
            Math.sin(a2) * 14,
            ev.t + Math.random() * 0.4,
            2.5 + Math.random() * 1.5,
            2,
            9,
            0.6,
            0.95,
            0.97,
            1.0,
            0.2,
          );
        if (j < 45) {
          const gsm = 0.4 + Math.random() * 0.14;
          landSteam.emit(
            x,
            3,
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 14,
            3 + Math.random() * 10,
            (Math.random() - 0.5) * 14,
            ev.t + 0.3 + Math.random() * 2.5,
            26 + Math.random() * 22,
            10,
            50 + Math.random() * 40,
            0.32,
            gsm,
            gsm * 0.97,
            gsm * 0.94,
            0.4,
          );
        }
        if (j < 90)
          landSteam.emit(
            x,
            1.5,
            (Math.random() - 0.5) * 10,
            Math.cos(a2) * 12,
            2 + Math.random() * 5,
            Math.sin(a2) * 12,
            ev.t + Math.random() * 0.8,
            20 + Math.random() * 12,
            8,
            46 + Math.random() * 20,
            0.4,
            0.95,
            0.95,
            0.96,
            0.4,
          );
      }
    }
    pushEvent(ev);
  }

  /* ---------- emitters ---------- */
  let trailPrev: T.Vector3 | null = null;
  const npV = new T.Vector3();
  /** World-frame particles born between mission times t0 and t1 (deluge, pad smoke, trail, landing burns, impact). */
  function emitWorld(t0: number, t1: number) {
    if (t1 <= t0) return;
    let n: number;
    let tb: number;
    let a: number;
    let sp: number;
    if (t1 > T_DELUGE && t0 < 14) {
      const ta = Math.max(t0, T_DELUGE);
      const tz = Math.min(t1, 14);
      n = Math.min(90, Math.ceil((tz - ta) * 240));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta, tz, (k + Math.random()) / n);
        a = Math.random() * TAU;
        const rr = 2 + Math.random() * 10;
        padSpray.emit(
          Math.cos(a) * rr,
          0.8,
          Math.sin(a) * rr,
          Math.cos(a) * 4 + (Math.random() - 0.5) * 4,
          16 + Math.random() * 16,
          Math.sin(a) * 4 + (Math.random() - 0.5) * 4,
          tb,
          2.0 + Math.random(),
          0.8,
          3.6,
          0.5,
          0.93,
          0.95,
          1.0,
          0.25,
        );
      }
    }
    if (t1 > T_IGN && t0 < 32) {
      const ta2 = Math.max(t0, T_IGN);
      const tz2 = Math.min(t1, 32);
      n = Math.min(120, Math.ceil((tz2 - ta2) * 170));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta2, tz2, (k + Math.random()) / n);
        boosterState(tb, tmpB);
        const baseH = tmpB.h - H_OLM;
        const inten = (tmpB.eng / 33) * tmpB.thr * (1 - smoothstep(25, 300, baseH));
        if (Math.random() > inten) continue;
        a = Math.random() * TAU;
        sp = 32 + Math.random() * 46;
        padSmoke.emit(
          Math.cos(a) * 7,
          2 + Math.random() * 5,
          Math.sin(a) * 7,
          Math.cos(a) * sp,
          2 + Math.random() * 9,
          Math.sin(a) * sp,
          tb,
          30 + Math.random() * 22,
          9,
          62 + Math.random() * 44,
          0.55,
          0.93,
          0.92,
          0.9,
          0.33,
        );
        if (k % 3 === 0)
          padSmoke.emit(
            (Math.random() - 0.5) * 8,
            10 + Math.random() * 10,
            (Math.random() - 0.5) * 8,
            (Math.random() - 0.5) * 8,
            10 + Math.random() * 12,
            (Math.random() - 0.5) * 8,
            tb,
            26 + Math.random() * 14,
            10,
            50,
            0.4,
            0.97,
            0.97,
            0.98,
            0.4,
          );
      }
    }
    if (t1 > 2 && t0 < T_BMECO) {
      const ta3 = Math.max(t0, 2);
      const tz3 = Math.min(t1, T_BMECO);
      boosterState(tz3, tmpB);
      axisPointPad(tmpB, -26, npV);
      const dist = trailPrev ? npV.distanceTo(trailPrev) : 0;
      const spacing = tmpB.h < 15000 ? 6 : 12;
      n = Math.min(150, Math.max(Math.ceil(dist / spacing), Math.ceil((tz3 - ta3) * 30)));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta3, tz3, (k + Math.random()) / n);
        boosterState(tb, tmpB);
        if (tmpB.h > 46000) continue;
        const p = axisPointPad(tmpB, -26, tmpV);
        const hg = tmpB.h;
        padSmoke.emit(
          p.x,
          p.y,
          p.z,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          tb,
          150 + Math.random() * 80,
          9,
          32 + Math.min(hg * 0.0019, 95),
          hg < 18000 ? 0.2 : 0.11,
          0.92,
          0.92,
          0.92,
          0.5,
        );
      }
      trailPrev = (trailPrev || new T.Vector3()).copy(npV);
    }
    if (t1 > B.tIgn && t0 < B.tCatch + 0.5) {
      const ta4 = Math.max(t0, B.tIgn);
      const tz4 = Math.min(t1, B.tCatch + 0.5);
      n = Math.min(90, Math.ceil((tz4 - ta4) * 140));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta4, tz4, (k + Math.random()) / n);
        boosterState(tb, tmpB);
        const inten2 = (1 - smoothstep(40, 280, tmpB.h)) * (tmpB.eng >= 13 ? 1 : tmpB.eng > 0 ? 0.5 : 0);
        if (Math.random() > inten2) continue;
        const bx = tmpB.th * RE;
        a = Math.random() * TAU;
        sp = 25 + Math.random() * 35;
        padSmoke.emit(
          bx + Math.cos(a) * 6,
          1.5 + Math.random() * 3,
          Math.sin(a) * 6,
          Math.cos(a) * sp,
          2 + Math.random() * 6,
          Math.sin(a) * sp,
          tb,
          22 + Math.random() * 14,
          7,
          40 + Math.random() * 25,
          0.42,
          0.88,
          0.86,
          0.82,
          0.35,
        );
      }
    }
    if (t1 > SH.tF && t0 < SH.tSplash + 0.6) {
      const ta5 = Math.max(t0, SH.tF);
      const tz5 = Math.min(t1, SH.tSplash + 0.6);
      n = Math.min(110, Math.ceil((tz5 - ta5) * 160));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta5, tz5, (k + Math.random()) / n);
        shipState(tb, tmpS);
        const inten3 = (tmpS.sl > 0 ? tmpS.thr : 0) * (1 - smoothstep(18, 160, tmpS.h));
        if (Math.random() > inten3) continue;
        const sx = (tmpS.th - TH_L) * RE;
        a = Math.random() * TAU;
        sp = 18 + Math.random() * 30;
        if (k % 2 === 0)
          landSpray.emit(
            sx + Math.cos(a) * 3,
            0.4,
            Math.sin(a) * 3,
            Math.cos(a) * sp,
            5 + Math.random() * 12,
            Math.sin(a) * sp,
            tb,
            2.2 + Math.random(),
            2.5,
            9,
            0.42,
            0.97,
            0.97,
            0.98,
            0.3,
          );
        else
          landSteam.emit(
            sx + Math.cos(a) * 5,
            1.5,
            Math.sin(a) * 5,
            Math.cos(a) * sp * 0.7,
            2 + Math.random() * 5,
            Math.sin(a) * sp * 0.7,
            tb,
            18 + Math.random() * 10,
            6,
            36 + Math.random() * 20,
            0.45,
            0.95,
            0.95,
            0.96,
            0.35,
          );
      }
    }
    if (t1 > SH.tImpact && t0 < SH.tImpact + 16) {
      const ta6 = Math.max(t0, SH.tImpact);
      const tz6 = Math.min(t1, SH.tImpact + 16);
      shipState(SH.tImpact, tmpS);
      const x0 = (tmpS.th - TH_L) * RE;
      n = Math.min(60, Math.ceil((tz6 - ta6) * 50));
      for (let k = 0; k < n; k++) {
        tb = lerp(ta6, tz6, (k + Math.random()) / n);
        const fade = 1 - (tb - SH.tImpact) / 16;
        const xx = x0 + 8 + Math.random() * 36;
        if (Math.random() < fade)
          landFire.emit(
            xx,
            1,
            (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 4,
            5 + Math.random() * 8,
            (Math.random() - 0.5) * 4,
            tb,
            0.9 + Math.random(),
            3,
            11,
            0.6 * fade,
            1.0,
            0.8,
            0.55,
            0.5,
          );
        const gs2 = lerp(0.3, 0.55, Math.random());
        if (Math.random() < 0.7)
          landSteam.emit(
            xx,
            4,
            (Math.random() - 0.5) * 6,
            (Math.random() - 0.5) * 4,
            5 + Math.random() * 7,
            (Math.random() - 0.5) * 4,
            tb,
            30 + Math.random() * 16,
            8,
            45 + Math.random() * 30,
            0.26 * (0.4 + 0.6 * fade),
            gs2,
            gs2 * 0.97,
            gs2 * 0.95,
            0.35,
          );
      }
    }
  }
  let rcsNext = 6;
  let rcsBursts: { port: RcsPort; until: number; acc: number }[] = [];
  const flowLocal = new T.Vector3(1, 0, 0);
  const flowW = new T.Vector3(1, 0, 0);
  /** Vehicle-frame particles for one real-time step: flames, hot staging, plasma, venting, RCS. */
  function emitLocal(dt: number) {
    if (dt <= 0) return;
    let n: number;
    let a: number;
    let rr: number;
    const bOn = S.launched && simT >= T_IGN ? bs.eng * bs.thr : 0;
    if (bOn > 0) {
      const ex = 1 + Math.min(Math.max(bs.h, 0) / 16000, 5.5);
      n = Math.min(70, Math.round(dt * (50 + bs.eng * 5) + Math.random()));
      for (let k = 0; k < n; k++) {
        const e = BENG[Math.floor(Math.random() * bs.eng)];
        a = Math.random() * TAU;
        rr = Math.sqrt(Math.random()) * 0.55;
        bFlames.emit(
          e.x + Math.cos(a) * rr,
          -0.5,
          e.z + Math.sin(a) * rr,
          Math.cos(a) * rr * 10 * ex,
          -(100 + Math.random() * 60),
          Math.sin(a) * rr * 10 * ex,
          realT,
          0.22 + Math.random() * 0.18,
          1.1 * ex,
          4.6 * ex,
          0.2,
          1.0,
          0.92,
          1.0,
          0,
        );
      }
    }
    if (S.launched && simT >= T_SHIPIGN && simT < T_SEP + 0.6) {
      n = Math.min(110, Math.round(dt * 1100 + Math.random()));
      for (let k = 0; k < n; k++) {
        a = Math.random() * TAU;
        const sp = 70 + Math.random() * 100;
        bFlames.emit(
          4.6 * Math.cos(a),
          70.0 + Math.random() * 0.8,
          4.6 * Math.sin(a),
          Math.cos(a) * sp,
          (Math.random() - 0.35) * 30,
          Math.sin(a) * sp,
          realT,
          0.35 + Math.random() * 0.35,
          2.4,
          13,
          0.5,
          1.0,
          0.82,
          0.62,
          0.7,
        );
      }
    }
    const sOn = ss.sl * ss.thr;
    if (sOn > 0 && shipG.visible) {
      const exS = 1 + Math.min(Math.max(ss.h, 0) / 16000, 5.5);
      n = Math.min(40, Math.round(dt * 30 * ss.sl * ss.thr + Math.random()));
      for (let k = 0; k < n; k++) {
        const e = SENG[k % ss.sl];
        a = Math.random() * TAU;
        rr = Math.sqrt(Math.random()) * 0.55;
        sFlames.emit(
          e.x + Math.cos(a) * rr,
          -0.4,
          e.z + Math.sin(a) * rr,
          Math.cos(a) * rr * 10 * exS,
          -(90 + Math.random() * 50),
          Math.sin(a) * rr * 10 * exS,
          realT,
          0.22 + Math.random() * 0.16,
          1.0 * exS,
          4.2 * exS,
          0.2,
          1.0,
          0.92,
          1.0,
          0,
        );
      }
    }
    if (ss.heat > 0.015 && simT < SH.tF) {
      n = Math.min(90, Math.round(dt * 650 * ss.heat + Math.random()));
      for (let k = 0; k < n; k++) {
        const y = Math.random() * 51;
        const b = (Math.random() - 0.5) * 3.4;
        const r0 = shipRadius(y) + 0.4;
        const spd = 260 + Math.random() * 420;
        const pink = Math.random() < 0.55;
        sFlames.emit(
          r0 * Math.cos(b),
          y,
          r0 * Math.sin(b),
          -flowLocal.x * spd + (Math.random() - 0.5) * 30,
          -flowLocal.y * spd + (Math.random() - 0.5) * 30,
          -flowLocal.z * spd + (Math.random() - 0.5) * 30,
          realT,
          0.18 + Math.random() * 0.3,
          1.6,
          7 + Math.random() * 6,
          0.2 * Math.min(1, ss.heat * 1.6),
          1.0,
          pink ? 0.42 : 0.62,
          pink ? 0.9 : 0.3,
          0.6,
        );
      }
    }
    /* boil-off venting on the pad */
    if (!S.launched || simT < 0) {
      n = Math.round(dt * 10 + Math.random() * 0.6);
      for (let k = 0; k < n; k++) {
        const vb = Math.random() < 0.55;
        const vp = vb
          ? bVents[Math.floor(Math.random() * bVents.length)]
          : sVents[Math.floor(Math.random() * sVents.length)];
        (vb ? bGas : sGas).emit(
          vp.x * 1.03,
          vp.y,
          vp.z * 1.03,
          vp.x * 0.15 + (Math.random() - 0.5),
          -0.6 - Math.random(),
          vp.z * 0.15 + (Math.random() - 0.5),
          realT,
          4 + Math.random() * 3,
          0.7,
          6.5,
          0.3,
          1,
          1,
          1,
          0.4,
        );
      }
    }
    /* the caught booster keeps venting on the tower */
    if (S.launched && simT > B.tCatch + 1 && simT < B.tCatch + 240) {
      n = Math.round(dt * 6 * (1 - (simT - B.tCatch) / 240) + Math.random() * 0.5);
      for (let k = 0; k < n; k++) {
        const vp2 = bVents[Math.floor(Math.random() * 2)];
        bGas.emit(
          vp2.x * 1.03,
          vp2.y,
          vp2.z * 1.03,
          vp2.x * 0.2,
          -0.4,
          vp2.z * 0.2,
          realT,
          5 + Math.random() * 3,
          0.8,
          7,
          0.3,
          1,
          1,
          1,
          0.4,
        );
      }
    }
    if (S.launched && simT > T_SECO + 15 && simT < SH.tEI - 40) {
      if (realT > rcsNext) {
        rcsBursts.push({
          port: sRcs[Math.floor(Math.random() * sRcs.length)],
          until: realT + 0.2 + Math.random() * 0.15,
          acc: 0,
        });
        rcsNext = realT + 4 + Math.random() * 7;
      }
    }
    for (let k = rcsBursts.length - 1; k >= 0; k--) {
      const bu = rcsBursts[k];
      const pt = bu.port;
      bu.acc += dt * 220;
      while (bu.acc >= 1) {
        bu.acc -= 1;
        const s2 = 6 + Math.random() * 5;
        sGas.emit(
          pt.p.x + pt.d.x * 0.3,
          pt.p.y,
          pt.p.z + pt.d.z * 0.3,
          pt.d.x * s2 + (Math.random() - 0.5) * 2,
          pt.d.y * s2 + (Math.random() - 0.5) * 2,
          pt.d.z * s2 + (Math.random() - 0.5) * 2,
          realT,
          0.6 + Math.random() * 0.4,
          0.3,
          2.6,
          0.5,
          0.95,
          0.96,
          0.98,
          0,
        );
      }
      if (realT > bu.until) rcsBursts.splice(k, 1);
    }
  }

  /* ---------- plumes, plasma, mechanisms ---------- */
  function updatePlumes() {
    const fl = 0.88 + 0.12 * Math.sin(realT * 47.0) * Math.sin(realT * 13.0);
    const on = S.launched && simT >= T_IGN;
    const eng = on ? bs.eng : 0;
    const thr = bs.thr;
    const bh = Math.max(bs.h, 0);
    const exB = 1 + Math.min(bh / 16000, 5.5);
    const lnB = 1 + Math.min(bh / 30000, 1.8);
    const cs = 1 + (exB - 1) * 0.22;
    const rings = [eng >= 3 ? 1 : 0, eng >= 13 ? 1 : 0, eng >= 33 ? 1 : 0];
    bCoreMats.forEach(function (m, r) {
      m.uniforms.uThrottle.value = rings[r] * thr * fl;
      m.uniforms.uTime.value = realT;
      m.uniforms.uDiamond.value = 0.45 * (1 - smoothstep(4000, 25000, bh));
    });
    bCores.forEach((c) => c.scale.set(cs, lnB, cs));
    const share = Math.sqrt(eng / 33);
    bBigMat.uniforms.uThrottle.value = eng > 0 ? Math.pow(eng / 33, 0.5) * thr : 0;
    bBigMat.uniforms.uTime.value = realT;
    bBigMat.uniforms.uDiamond.value = 0.12 * (1 - smoothstep(4000, 25000, bh));
    bBigMat.uniforms.uGain.value = lerp(1.0, 0.5, smoothstep(2000, 30000, bh));
    bBig.scale.set(exB * (0.35 + 0.65 * share), lnB * (0.45 + 0.55 * share), exB * (0.35 + 0.65 * share));
    for (let i = 0; i < 33; i++) {
      const g = i < eng ? 0.85 * thr * fl : 0;
      bGlow.setColorAt(i, colI.setRGB(g, g * 0.45, g * 0.15));
    }
    if (bGlow.instanceColor) bGlow.instanceColor.needsUpdate = true;
    bLight.intensity = (eng / 33) * thr * 16 * (1 - smoothstep(800, 6000, bh)) * fl;
    const sl = shipG.visible ? ss.sl : 0;
    const sthr = ss.thr;
    const sh = Math.max(ss.h, 0);
    const exS = 1 + Math.min(sh / 16000, 5.5);
    const lnS = 1 + Math.min(sh / 30000, 1.8);
    const cS = 1 + (exS - 1) * 0.22;
    sCoreMat.uniforms.uThrottle.value = sl > 0 ? sthr * fl : 0;
    sCoreMat.uniforms.uTime.value = realT;
    sCoreMat.uniforms.uDiamond.value = 0.45 * (1 - smoothstep(4000, 25000, sh));
    sCores.forEach(function (c, k) {
      c.visible = k < sl;
      c.scale.set(cS, lnS, cS);
    });
    sBigMat.uniforms.uThrottle.value = sl > 0 ? (sl / 3) * sthr : 0;
    sBigMat.uniforms.uTime.value = realT;
    sBigMat.uniforms.uDiamond.value = 0.1 * (1 - smoothstep(4000, 25000, sh));
    sBigMat.uniforms.uGain.value = lerp(0.9, 0.5, smoothstep(2000, 30000, sh));
    sBig.scale.set(exS * (0.5 + (0.5 * sl) / 3), lnS, exS * (0.5 + (0.5 * sl) / 3));
    const vac = shipG.visible ? ss.vac : 0;
    const exV = 1 + Math.min(sh / 25000, 5);
    const lnV = 1 + Math.min(sh / 50000, 2.2);
    vacMat.uniforms.uThrottle.value = vac > 0 ? sthr * (0.9 + 0.1 * fl) : 0;
    vacMat.uniforms.uTime.value = realT;
    vacPlumes.forEach((p) => p.scale.set(exV, lnV, exV));
    sGlowMat.color.setRGB(1, 0.45, 0.15).multiplyScalar(sl > 0 ? 0.85 * sthr * fl : 0);
    vacGlowMat.color.setRGB(1, 0.42, 0.14).multiplyScalar(vac > 0 ? 0.7 * sthr : 0);
    sLight.intensity = (sl / 3) * sthr * 10 * (1 - smoothstep(800, 6000, sh)) * fl;
  }
  function updatePlasma() {
    const heat = shipG.visible ? ss.heat : 0;
    const k = Math.pow(heat, 0.8);
    const dth = ss.th - thF;
    const ux = Math.sin(dth);
    const uy = Math.cos(dth);
    flowW.set(ss.vh * uy + ss.vv * ux, ss.vh * -ux + ss.vv * uy, 0);
    if (flowW.lengthSq() < 1e-6) flowW.set(1, 0, 0);
    flowW.normalize();
    flowLocal.copy(flowW).applyQuaternion(qTmp.copy(shipG.quaternion).invert());
    sheath.visible = heat > 0.01;
    wakeG.visible = heat > 0.01;
    sheathMat.uniforms.uI.value = 1.25 * k;
    sheathMat.uniforms.uTime.value = realT;
    sheathMat.uniforms.uFlow.value.copy(flowW);
    if (wakeG.visible) {
      wakeG.quaternion.setFromUnitVectors(Yax, flowLocal);
      wakeG.scale.set(0.6 + 0.6 * k, 0.4 + 1.2 * k, 0.6 + 0.6 * k);
    }
    wakeCoreMat.uniforms.uThrottle.value = 0.9 * k;
    wakeOuterMat.uniforms.uThrottle.value = 0.7 * k;
    wakeCoreMat.uniforms.uTime.value = realT;
    wakeOuterMat.uniforms.uTime.value = realT;
    const glow = Math.pow(heat, 1.2) * 0.9;
    matTiles.emissive.setRGB(1.0, 0.33, 0.08).multiplyScalar(glow);
    flaps.forEach((f) => f.tileMat.emissive.setRGB(1.0, 0.4, 0.12).multiplyScalar(glow * 1.2));
  }
  /** Tower arms, grid fins, flaps, frost, payload door, satellites, hot-stage glow, buoys. */
  function applyMechanisms() {
    const t = S.launched ? simT : T_START;
    qdPiv.rotation.y = lerp(QD_ON, QD_OFF, easeInOut((t - T_QD) / 8));
    carriage.position.y = lerp(CS_PARK, CS_Y, easeInOut((t - 210) / 90));
    setArms(lerp(44, -2, easeInOut((t - (B.tCatch - 1.9)) / 1.6)));
    gridFins.forEach(function (g, i) {
      g.rotation.x =
        t > B.tBBe && t < B.tCatch ? 0.14 * Math.sin(realT * 1.3 + i * 2.1) * (1 - smoothstep(B.tLB2, B.tCatch, t)) : 0;
    });
    let fwd = 62;
    let aft = 62;
    if (t >= SH.tEI - 200 && t < SH.tF) {
      const kk = smoothstep(SH.tEI - 200, SH.tEI, t);
      fwd = lerp(62, 30, kk) + 6 * kk * Math.sin(realT * 0.9);
      aft = lerp(62, 20, kk) + 5 * kk * Math.sin(realT * 1.1 + 1);
    } else if (t >= SH.tF) {
      const k2 = smoothstep(SH.tF, SH.tF + 2.5, t);
      fwd = lerp(30, 76, k2);
      aft = lerp(20, 12, k2);
    }
    setFlap(flaps[0], (fwd + 2 * Math.sin(realT * 1.7)) * D2R);
    setFlap(flaps[1], (fwd - 2 * Math.sin(realT * 1.7)) * D2R);
    setFlap(flaps[2], aft * D2R);
    setFlap(flaps[3], aft * D2R);
    matBFrost.opacity = 1 - smoothstep(30, 420, t);
    frostB.visible = matBFrost.opacity > 0.01;
    matSFrost.opacity = 1 - smoothstep(30, 900, t);
    frostS.visible = matSFrost.opacity > 0.01;
    const dOpen = easeInOut((t - T_DOOR) / 8) * (1 - easeInOut((t - T_DOOR_CLOSE) / 8));
    doorPanel.position.y = 1.9 * dOpen;
    sats.forEach(function (s) {
      const u = t - s.t0;
      if (u < -0.2 || t > T_ENTRY_ATT - 20) {
        s.mesh.visible = false;
        return;
      }
      s.mesh.visible = true;
      if (u < 3.2) {
        s.mesh.position.set(lerp(-2.2, -6.0, easeInOut(u / 3.2)), 32.0, 0);
        s.mesh.rotation.set(0, 0, 0);
      } else {
        const d = u - 3.2;
        s.mesh.position.set(-6.0 + s.vx * d, 32.0 + s.vy * d, s.vz * d);
        s.mesh.rotation.set(s.wx * d, s.wy * d, s.wz * d);
      }
    });
    const hot =
      t >= T_SHIPIGN && t < T_SEP + 1.5
        ? (1 - smoothstep(T_SEP, T_SEP + 1.5, t)) * smoothstep(T_SHIPIGN, T_SHIPIGN + 0.3, t)
        : 0;
    hsrMat.emissive.setRGB(1.0, 0.42, 0.12).multiplyScalar(hot * 1.6);
    buoys.forEach(function (b) {
      b.g.position.y = 0.35 * Math.sin(realT * 0.9 + b.ph);
      b.g.rotation.z = 0.06 * Math.sin(realT * 0.7 + b.ph * 2);
      b.g.rotation.x = 0.05 * Math.sin(realT * 0.8 + b.ph);
    });
  }

  /* ---------- camera ---------- */
  const FOCUS_OFF: Record<Focus, number> = { stack: 58, booster: 36, ship: 25 };
  const DEF_OFF: Record<Focus, T.Vector3> = {
    stack: new T.Vector3(130, -22, 265),
    booster: new T.Vector3(95, -10, 175),
    ship: new T.Vector3(68, 14, 120),
  };
  const FRAME_R: Record<Focus, number> = { stack: 90, booster: 56, ship: 44 };
  const PADCAM = new T.Vector3(470, 4, 1350);
  const camTgt = new T.Vector3();
  const camRelV = new T.Vector3();
  const shake = new T.Vector3();
  const gPos = new T.Vector3();
  let tween: { t: number; dur: number; s0: T.Spherical; s1: T.Spherical; dT: number } | null = null;
  let lastFocus: Focus | null = null;
  let camWasGround = false;
  let aspCls: string | null = null;
  let camInit = false;
  function autoFocus(t: number): Focus {
    if (t < T_SEP + 5) return "stack";
    if (t < B.tEnd + 12) return "booster";
    return "ship";
  }
  function curFocus(): Focus {
    const t = S.launched ? simT : T_START;
    if (S.follow === "booster") return t < T_SEP ? "stack" : "booster";
    if (S.follow === "ship") return "ship";
    return autoFocus(t);
  }
  function focusPoint(f: Focus, out: T.Vector3) {
    const g = f === "ship" ? shipG : boosterG;
    return out.set(0, FOCUS_OFF[f], 0).applyQuaternion(g.quaternion).add(g.position);
  }
  /** Puts a vehicle group in the scene frame, which keeps the focused vehicle near the origin. */
  function place(g: T.Group, st: { th: number; h: number; psi: number }) {
    const dth = st.th - thF;
    const r = RE + st.h;
    g.position.set(r * Math.sin(dth), r * Math.cos(dth) - RE, 0);
    g.quaternion.setFromAxisAngle(Zax, st.psi - Math.PI / 2 - dth);
  }
  /** Default chase offset, pulled back on portrait screens. */
  function defOff(f: Focus, out: T.Vector3) {
    const asp = camera.aspect || 1.6;
    return out.copy(DEF_OFF[f]).multiplyScalar(asp < 1.3 ? clamp(1.25 / asp, 1, 2.3) : 1);
  }
  function cutTo(f: Focus) {
    focusPoint(f, camTgt);
    controls.target.copy(camTgt);
    camera.position.copy(camTgt).add(defOff(f, tmpV3));
    camera.up.set(0, 1, 0);
    camera.fov = 45;
    camera.updateProjectionMatrix();
    tween = null;
    controls.enabled = true;
    controls.update();
  }
  function startReset() {
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
    const s0 = new T.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const s1 = new T.Spherical().setFromVector3(defOff(focus, new T.Vector3()));
    let dT = s1.theta - s0.theta;
    while (dT > Math.PI) dT -= TAU;
    while (dT < -Math.PI) dT += TAU;
    tween = { t: 0, dur: 1.1, s0, s1, dT };
    controls.enabled = false;
  }
  /** Tracking camera near Starbase or the splashdown buoy, whichever is in range. */
  function groundCam(out: T.Vector3): "pad" | "buoy" | null {
    if (Math.abs(thF) * RE < 600000) {
      padFrame.localToWorld(out.copy(PADCAM));
      return "pad";
    }
    if (Math.abs(thF - TH_L) * RE < 600000) {
      landFrame.localToWorld(out.set(BUOY_CAM.x, BUOY_CAM.y + 0.35 * Math.sin(realT * 0.9), BUOY_CAM.z));
      return "buoy";
    }
    return null;
  }

  /* ---------- resize ---------- */
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const pr = pixelRatio();
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    /* nudges the vehicle below the top HUD cards (landscape) or above the console (portrait) */
    camera.setViewOffset(w, h, 0, (w / h > 1.15 ? 0.065 : -0.05) * h, w, h);
    camera.updateProjectionMatrix();
    starMat.uniforms.uPR.value = pr;
    const cls = w / h < 1.3 ? "p" : "l";
    if (aspCls && cls !== aspCls && !S.launched && S.cam !== "ground" && camInit) cutTo(curFocus());
    aspCls = cls;
  }
  let ro: ResizeObserver | null = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(resize);
    ro.observe(canvas);
  } else window.addEventListener("resize", resize);
  resize();

  /* ---------- time warp ---------- */
  /* auto warp: [from mission time, factor]; real time around every event worth watching */
  const AUTO: [number, number][] = [
    [-1e9, 1],
    [T_BB0 + 4, 2],
    [B.tBBe - 4, 1],
    [B.tBBe + 8, 6],
    [B.tIgn - 22, 1],
    [B.tEnd + 10, 3],
    [T_SECO - 12, 1],
    [T_SECO + 10, 60],
    [T_DOOR - 6, 6],
    [T_DOOR_CLOSE + 4, 60],
    [T_RELIGHT - 6, 1],
    [T_RELIGHT + RELIGHT_DUR + 4, 60],
    [T_ENTRY_ATT - 4, 6],
    [T_ENTRY_ATT + 95, 60],
    [SH.tEI - 30, 8],
    [SH.tSub, 4],
    [SH.tF - 25, 1],
  ];
  function autoWarpAt(t: number) {
    let w = 1;
    for (const [from, f] of AUTO) {
      if (t >= from) w = f;
      else break;
    }
    return w;
  }
  function targetWarp() {
    if (!S.launched || S.paused) return 0;
    if (!S.auto) return S.warpUser;
    const here = autoWarpAt(simT);
    /* look ahead so the warp drops before the next slow stretch */
    const aw = Math.min(here, autoWarpAt(simT + Math.min(here, 60) * 1.2));
    return Math.max(S.warpUser, aw);
  }

  /* ---------- status ---------- */
  function boosterStatus(t: number): BoosterStatus {
    if (t < T_IGN) return "fueled";
    if (t < 0) return "engineStart";
    if (t < T_BMECO) return "ascent";
    if (t < T_SEP) return "hotStaging";
    if (t < T_BB0) return "flip";
    if (t < B.tBBe) return "boostback";
    if (t < B.tIgn - 70) return "coast";
    if (t < B.tIgn) return "descent";
    if (t < B.tLB2) return "landingBurn";
    if (t < B.tCatch) return "approach";
    return "caught";
  }
  function shipStatus(t: number): ShipStatus {
    if (t < T_SHIPIGN) return t < T_IGN ? "fueled" : "stacked";
    if (t < T_SEP) return "hotStaging";
    if (t < T_SECO) return "sixEngine";
    if (t < T_DOOR) return "coast";
    if (t < T_DOOR_CLOSE + 8) return "deploy";
    if (t < T_RELIGHT) return "coast";
    if (t < T_RELIGHT + RELIGHT_DUR) return "relight";
    if (t < T_ENTRY_ATT) return "coast";
    if (t < SH.tEI) return "entryAttitude";
    if (t < SH.tSub) return "plasma";
    if (t < SH.tF) return "bellyFlop";
    if (t < SH.tSplash) return "landingBurn";
    if (t < SH.tImpact + 1) return "splashdown";
    return "complete";
  }
  function phaseInfo(): [PhaseId, PhaseTone] {
    if (!S.launched) return ["hold", "hold"];
    if (S.paused) return ["paused", "paused"];
    if (simT < T_IGN) return ["countdown", "count"];
    if (simT < 0) return ["ignition", "count"];
    if (simT < T_BMECO) return ["ascent", "burn"];
    if (simT < T_SEP + 3) return ["staging", "burn"];
    if (focus === "ship") return ["ship", simT > SH.tImpact ? "done" : ss.sl > 0 || ss.heat > 0.05 ? "burn" : "coast"];
    return ["booster", simT >= B.tCatch ? "done" : bs.eng > 0 ? "burn" : "coast"];
  }
  /* timeline position: piecewise so the busy first minutes and the landings get room */
  const TL: [number, number][] = [
    [T_START, 0],
    [0, 0.03],
    [T_SEP, 0.2],
    [B.tEnd, 0.4],
    [T_SECO + 30, 0.5],
    [SH.tEI, 0.66],
    [SH.tSplash, 0.96],
    [SH.tSplash + 60, 1],
  ];
  function tlMap(t: number) {
    if (t <= TL[0][0]) return 0;
    for (let k = 1; k < TL.length; k++)
      if (t <= TL[k][0]) return lerp(TL[k - 1][1], TL[k][1], (t - TL[k - 1][0]) / (TL[k][0] - TL[k - 1][0]));
    return 1;
  }
  const TICKS: [number, TickId, boolean][] = [
    [0, "liftoff", false],
    [A.tMaxQ, "maxq", true],
    [T_SEP, "staging", false],
    [B.tCatch, "catch", false],
    [T_SECO, "seco", true],
    [T_DEPLOY0, "deploy", true],
    [SH.tEI, "entry", false],
    [SH.tPeak, "peak", true],
    [SH.tSplash, "splash", false],
  ];
  /* "Next event" stops a few seconds before each of these */
  const SKIPS = [
    T_IGN - 1.5,
    A.tMaxQ - 4,
    T_BMECO - 5,
    T_BB0 - 2,
    B.tIgn - 14,
    T_SECO - 8,
    T_DOOR - 3,
    T_RELIGHT - 4,
    SH.tEI - 8,
    SH.tPeak - 25,
    SH.tF - 18,
  ];
  function nextSkip() {
    const t = S.launched ? simT : T_START;
    for (const s of SKIPS) if (s > t + 1.5) return s;
    return null;
  }
  function snapshot(): Snapshot {
    const ph = phaseInfo();
    const t = S.launched ? simT : T_START;
    const pre = !S.launched || simT < T_IGN;
    return {
      met: fmtClock(t),
      phase: ph[0],
      tone: ph[1],
      launched: S.launched,
      paused: S.paused,
      b: {
        spd: Math.round(bs.v * 3.6),
        alt: Math.max(bs.h - (t < 0 ? H_OLM : 0), 0) / 1000,
        status: boosterStatus(t),
        eng: pre ? 0 : bs.eng,
      },
      s: {
        spd: shipGone ? 0 : Math.round(ss.v * 3.6),
        alt: Math.max(ss.h - (t < 0 ? H_OLM + L_B : 0), 0) / 1000,
        status: shipStatus(t),
        sl: pre ? 0 : ss.sl,
        vac: pre ? 0 : ss.vac,
      },
      warpUser: S.warpUser,
      warpEff: wCur > 1.5 ? Math.round(wCur) : wCur > 0 ? 1 : 0,
      auto: S.auto,
      follow: S.follow,
      cam: S.cam,
      autoOrbit: S.autoOrbit,
      tl: tlMap(t),
      ticks: TICKS.map(([tt, id, minor]) => ({ id, left: tlMap(tt), minor, done: S.launched && simT >= tt })),
      log: log.map((e) => ({ met: fmtShort(e.t), key: e.key })),
      toast: toast && realT - toast.at < 4.2 ? { key: toast.key, values: toast.values, id: toast.id } : null,
      canSkip: nextSkip() !== null,
    };
  }

  /* ===================== frame ===================== */
  const sunT = [1, 1, 1];
  let expoS = 2.5;
  /* sky colours reflected by the splashdown ocean, from the sunset light there */
  {
    const sunL = [1, 1, 1];
    const upL = new T.Vector3(Math.sin(TH_L), Math.cos(TH_L), 0);
    sunTransJS(RE + 3, upL.dot(SUN_IN), sunL);
    const m = Math.max(sunL[0], 1e-4);
    oceanMat.uniforms.uSkyH.value.set((2.2 * sunL[0]) / m, (1.5 * sunL[1]) / m + 0.05, (0.9 * sunL[2]) / m + 0.08);
    oceanMat.uniforms.uSkyA.value.set(0.16, 0.17, 0.26);
    oceanMat.uniforms.uSkyZ.value.set(0.05, 0.1, 0.22);
  }
  const atmoMats = [skyMat, earthMat, cloudMat, capMat, oceanMat];
  function frame(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    realT += dt;
    if (bakeJobs.length) {
      bakeStep();
      bakeStep();
      if (!bakeJobs.length) {
        earth.visible = true;
        clouds.visible = true;
        ready = true;
        cb.onReady();
      } else cb.onProgress(1 - bakeJobs.length / bakeTotal);
    }
    /* the effective warp eases toward its target in log space */
    const wT = targetWarp();
    if (wT <= 0) wCur = 0;
    else {
      if (wCur <= 0) wCur = Math.min(wT, 1);
      wCur = Math.exp(lerp(Math.log(wCur), Math.log(wT), Math.min(1, dt * 3)));
      if (Math.abs(wCur - wT) < 0.01 * wT) wCur = wT;
    }
    const tPrev = simT;
    if (S.launched && wCur > 0) {
      const tNext = simT + dt * wCur;
      while (evIdx < events.length && events[evIdx].t <= tNext) fireEvent(events[evIdx++]);
      simT = tNext;
    }
    boosterState(simT, bs);
    shipState(simT, ss);
    const f = curFocus();
    thF = f === "ship" ? ss.th : bs.th;
    worldRoot.rotation.z = thF;
    worldRoot.updateMatrixWorld(true);
    sunD.copy(SUN_IN).applyAxisAngle(Zax, thF);
    place(boosterG, bs);
    place(shipG, ss);
    if (S.launched && simT > T_IGN && simT < 12 && !opts.reducedMotion) {
      const jA = 0.035 * clamp(bs.eng / 33, 0, 1) * (1 - smoothstep(4, 12, simT));
      const jx = (Math.random() - 0.5) * jA;
      const jz = (Math.random() - 0.5) * jA;
      boosterG.position.x += jx;
      boosterG.position.z += jz;
      shipG.position.x += jx;
      shipG.position.z += jz;
    }
    shipGone = S.launched && simT > SH.tImpact + 0.6;
    shipG.visible = !shipGone;
    boosterG.updateMatrixWorld(true);
    shipG.updateMatrixWorld(true);
    if (hsrDeb.sep && hsr.parent === scene) {
      integrateHSR(simT);
      placeHSR();
    }
    applyMechanisms();
    if (S.launched && simT > tPrev) emitWorld(Math.max(tPrev, simT - 3), simT);
    emitLocal(dt);
    updatePlumes();
    updatePlasma();
    /* camera: blend the target between vehicles when the focus changes nearby, cut when far */
    focusPoint(f, camTgt);
    if (lastFocus === null) {
      lastFocus = f;
      focus = f;
    }
    if (f !== lastFocus) {
      const oldP = focusPoint(lastFocus, tmpV);
      if (oldP.distanceTo(camTgt) < 5000 && S.cam !== "ground") blend = { from: lastFocus, t0: realT };
      else {
        blend = null;
        if (S.cam !== "ground") cutTo(f);
      }
      lastFocus = f;
      focus = f;
    }
    if (blend) {
      const kb = easeInOut((realT - blend.t0) / 1.4);
      if (kb >= 1) blend = null;
      else camTgt.copy(focusPoint(blend.from, tmpV2).lerp(camTgt, kb));
    }
    camera.position.sub(shake);
    if (
      !isFinite(camera.position.x + camera.position.y + camera.position.z) ||
      !isFinite(controls.target.x + controls.target.y + controls.target.z)
    )
      cutTo(f);
    const gm = S.cam === "ground" ? groundCam(gPos) : null;
    if (gm) {
      controls.enabled = false;
      controls.autoRotate = false;
      camera.position.copy(gPos);
      camera.up.copy(tmpV.copy(gPos).sub(CENTER).normalize());
      const dist = gPos.distanceTo(camTgt);
      camera.fov = clamp((2 * Math.atan(FRAME_R[f] / dist)) / D2R, 0.5, 50);
      camera.updateProjectionMatrix();
      camera.lookAt(camTgt);
      controls.target.copy(camTgt);
      camWasGround = true;
    } else {
      if (camWasGround) {
        camWasGround = false;
        cutTo(f);
      }
      const delta = tmpV2.copy(camTgt).sub(controls.target);
      camera.position.add(delta);
      controls.target.copy(camTgt);
      if (tween) {
        tween.t += dt;
        const kk = easeInOut(tween.t / tween.dur);
        const spc = new T.Spherical(
          lerp(tween.s0.radius, tween.s1.radius, kk),
          lerp(tween.s0.phi, tween.s1.phi, kk),
          tween.s0.theta + tween.dT * kk,
        );
        camera.position.setFromSpherical(spc).add(controls.target);
        camera.lookAt(controls.target);
        if (tween.t >= tween.dur) {
          tween = null;
          controls.enabled = true;
          controls.update();
        }
      } else {
        controls.enabled = true;
        controls.autoRotate = S.autoOrbit;
        controls.update();
      }
    }
    const camDist = camera.position.distanceTo(camTgt);
    const bh = Math.max(bs.h, 0);
    let shk =
      S.launched && simT > T_IGN && simT < 40
        ? 0.09 * (bs.eng / 33) * bs.thr * (1 - smoothstep(500, 6000, bh)) * clamp(260 / Math.max(camDist, 40), 0, 1.5)
        : 0;
    if (gm) shk *= 0.25;
    if (opts.reducedMotion) shk = 0;
    shake.set((Math.random() - 0.5) * shk, (Math.random() - 0.5) * shk, (Math.random() - 0.5) * shk);
    camera.position.add(shake);
    camera.updateMatrixWorld(true);
    /* atmosphere, lighting */
    const camRel = camRelV.copy(camera.position).sub(CENTER);
    const camAlt = camRel.length() - RE;
    const fh = f === "ship" ? ss.h : bs.h;
    const lightAlt = gm ? Math.max(camAlt, 0) : Math.max(fh + FOCUS_OFF[f], 0);
    const upV = gm ? tmpV.copy(camRel).normalize() : tmpV.set(0, 1, 0);
    const sunMu = upV.dot(sunD);
    sunTransJS(RE + lightAlt + 20, sunMu, sunT);
    const mx = Math.max(sunT[0], sunT[1], sunT[2], 1e-4);
    const lum = 0.3 * sunT[0] + 0.55 * sunT[1] + 0.15 * sunT[2];
    sun.color.setRGB(sunT[0] / mx, sunT[1] / mx, sunT[2] / mx);
    sun.intensity = 3.4 * Math.min(1, lum * 1.15);
    sun.position.copy(camTgt).addScaledVector(sunD, 1500);
    sun.target.position.copy(camTgt);
    sun.target.updateMatrixWorld();
    const ext = Math.abs(thF) * RE < 4000 && fh < 3000 ? 135 : 80;
    if (shc.right !== ext) {
      shc.left = -ext;
      shc.right = ext;
      shc.top = ext;
      shc.bottom = -ext;
      shc.updateProjectionMatrix();
    }
    const sp01 = smoothstep(3000, 50000, camAlt);
    hemi.color.setRGB(lerp(0.3, 0.012, sp01), lerp(0.42, 0.016, sp01), lerp(0.62, 0.03, sp01));
    hemi.groundColor.setRGB(lerp(0.12, 0.1, sp01), lerp(0.13, 0.17, sp01), lerp(0.1, 0.3, sp01));
    hemi.intensity = lerp(0.85, 0.5, sp01) * clamp(lum * 1.4 + 0.15, 0.15, 1);
    const warm = 1 - smoothstep(0.05, 0.4, sunMu);
    const hzK = 0.35 + 0.65 * lum;
    const hz = [
      lerp(lerp(0.66, 0.8, warm), 0.45, sp01) * hzK,
      lerp(lerp(0.72, 0.62, warm), 0.58, sp01) * hzK,
      lerp(lerp(0.82, 0.58, warm), 0.78, sp01) * hzK,
    ];
    fog.color.setRGB(hz[0], hz[1], hz[2]).convertSRGBToLinear();
    fog.density = 1.6e-5 * Math.exp(-Math.max(camAlt, 0) / 7500);
    updateEnv(Math.max(lightAlt, 0), Math.min(1, lum * 1.2), warm, realT);
    /* auto exposure: brighter at dawn and dusk near the ground, neutral in space */
    const kLight = lum * Math.max(sunMu, 0) + 0.035 * smoothstep(-0.15, 0.1, sunMu);
    const expo = lerp(clamp(Math.pow(0.9 / (kLight + 0.01), 0.6), 1, 3.4), 1, smoothstep(8000, 45000, lightAlt));
    expoS += (expo - expoS) * Math.min(1, dt * 1.5);
    renderer.toneMappingExposure = Math.pow(expoS, 0.45);
    atmoMats.forEach(function (m) {
      m.uniforms.uExposure.value = expoS;
      m.uniforms.uSun.value.copy(sunD);
      m.uniforms.uCamRel.value.copy(camRel);
    });
    capMat.uniforms.uTime.value = realT;
    oceanMat.uniforms.uTime.value = realT;
    cloudMat.uniforms.uBelow.value = camAlt < CLOUD_ALT ? 1 : 0;
    cloudMat.side = camAlt < CLOUD_ALT ? T.BackSide : T.FrontSide;
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    stars.quaternion.copy(worldRoot.quaternion);
    starMat.uniforms.uTime.value = realT;
    starMat.uniforms.uVis.value = smoothstep(25000, 90000, camAlt) * 0.95;
    const dPad = Math.abs(thF) * RE;
    const dLand = Math.abs(thF - TH_L) * RE;
    cap.visible = dPad < 900000;
    padGroup.visible = dPad < 400000;
    shadowCatcher.visible = dPad < 30000;
    oceanCap.visible = dLand < 900000;
    landGroup.visible = dLand < 120000;
    earthMat.uniforms.uSiteCos.value = cap.visible ? SITE_COS : 2;
    earthMat.uniforms.uSiteCos2.value = oceanCap.visible ? SITE_COS : 2;
    /* splashdown ocean: foam patch and the landing-burn glow on the water */
    const sx = (ss.th - TH_L) * RE;
    const ou = oceanMat.uniforms;
    const tt = S.launched ? simT : T_START;
    const foam =
      tt < SH.tF
        ? 0
        : tt < SH.tSplash
          ? 0.55 * (1 - smoothstep(12, 110, ss.h))
          : 1 - 0.65 * smoothstep(SH.tSplash + 40, SH.tSplash + 200, tt);
    ou.uFoam.value = foam;
    ou.uFoamC.value.set(sx + (tt > SH.tImpact ? 24 : 0), 0);
    ou.uFoamR.value = tt > SH.tImpact ? 95 : 48;
    ou.uGlowP.value.set(sx, 0, 0);
    ou.uGlowI.value =
      (shipGone ? 0 : (ss.sl / 3) * ss.thr * (1 - smoothstep(20, 320, ss.h)) * 9) +
      (tt > SH.tImpact && tt < SH.tImpact + 14 ? 14 * (1 - (tt - SH.tImpact) / 14) : 0);
    /* particles */
    sunV.copy(sunD).transformDirection(camera.matrixWorldInverse);
    const sunK = Math.min(1, lum * 1.3);
    sunCol.set((sunT[0] / mx) * sunK, (sunT[1] / mx) * sunK, (sunT[2] / mx) * sunK);
    ambCol.set(lerp(0.36, 0.05, sp01), lerp(0.42, 0.06, sp01), lerp(0.54, 0.1, sp01));
    fogCol.set(hz[0], hz[1], hz[2]);
    const fogD = 1.2e-5 * Math.exp(-Math.max(camAlt, 0) / 7500);
    const lowB = 1 - smoothstep(0, 4000, bh);
    const bFl = S.launched && simT >= T_IGN ? (bs.eng / 33) * bs.thr : 0;
    padSmoke.mat.uniforms.uFogD.value = fogD;
    padSmoke.mat.uniforms.uFlameI.value = 2.4 * bFl * lowB;
    boosterG.localToWorld(padSmoke.mat.uniforms.uFlameW.value.set(0, -12, 0));
    landSteam.mat.uniforms.uFogD.value = fogD;
    landSteam.mat.uniforms.uFlameI.value = shipGone ? 0 : 1.6 * (ss.sl / 3) * ss.thr * (1 - smoothstep(0, 600, ss.h));
    shipG.localToWorld(landSteam.mat.uniforms.uFlameW.value.set(0, -8, 0));
    landSpray.mat.uniforms.uFogD.value = fogD;
    padSpray.mat.uniforms.uFogD.value = fogD;
    worldPuffs.forEach(function (p) {
      p.mat.uniforms.uTime.value = simT;
      p.flush();
    });
    localPuffs.forEach(function (p) {
      p.mat.uniforms.uTime.value = realT;
      p.flush();
    });
    renderer.render(scene, camera);
    statusAcc += dt;
    if (ready && statusAcc > 0.12) {
      statusAcc = 0;
      cb.onStatus(snapshot());
    }
  }

  function setCam(c: CamMode) {
    if (c === S.cam) return;
    S.cam = c;
    if (c === "chase") cutTo(focus);
    else if (!groundCam(gPos)) toast = { key: "nocam", at: realT, id: "nocam:" + Math.round(realT) };
  }
  function restart() {
    simT = T_START;
    S.launched = false;
    S.paused = false;
    evIdx = 0;
    log = [];
    toast = null;
    wCur = 0;
    if (hsr.parent !== boosterG) {
      scene.remove(hsr);
      boosterG.add(hsr);
    }
    hsr.position.copy(hsrHome);
    hsr.quaternion.identity();
    hsr.visible = true;
    hsrDeb.sep = false;
    hsrSplash = false;
    shipGone = false;
    shipG.visible = true;
    trailPrev = null;
    rcsBursts = [];
    allPuffs.forEach((p) => p.clear());
    boosterState(simT, bs);
    shipState(simT, ss);
    thF = 0;
    worldRoot.rotation.z = 0;
    place(boosterG, bs);
    place(shipG, ss);
    worldRoot.updateMatrixWorld(true);
    boosterG.updateMatrixWorld(true);
    shipG.updateMatrixWorld(true);
    blend = null;
    lastFocus = null;
    focus = curFocus();
    camWasGround = false;
    if (S.cam !== "ground") cutTo(focus);
  }
  function jumpTo(tgt: number) {
    if (!S.launched) {
      S.launched = true;
      S.paused = false;
    }
    if (tgt <= simT) return;
    while (evIdx < events.length && events[evIdx].t <= tgt) fireEvent(events[evIdx++]);
    simT = tgt;
    trailPrev = null;
    wCur = 1;
  }
  boosterState(simT, bs);
  shipState(simT, ss);
  place(boosterG, bs);
  place(shipG, ss);
  worldRoot.updateMatrixWorld(true);
  boosterG.updateMatrixWorld(true);
  shipG.updateMatrixWorld(true);
  focus = curFocus();
  cutTo(focus);
  camInit = true;
  raf = requestAnimationFrame(frame);

  return {
    snapshot: snapshot,
    primary: function () {
      if (!S.launched) {
        S.launched = true;
        S.paused = false;
        simT = T_START;
      } else S.paused = !S.paused;
      return snapshot();
    },
    restart: function () {
      restart();
      return snapshot();
    },
    skip: function () {
      const t = nextSkip();
      if (t !== null) {
        jumpTo(t);
        S.paused = false;
      }
      return snapshot();
    },
    setWarp: function (w: number) {
      S.warpUser = w;
      return snapshot();
    },
    toggleAuto: function () {
      S.auto = !S.auto;
      return snapshot();
    },
    setFollow: function (f: Follow) {
      S.follow = f;
      return snapshot();
    },
    setCam: function (c: CamMode) {
      setCam(c);
      return snapshot();
    },
    toggleOrbit: function () {
      S.autoOrbit = !S.autoOrbit;
      if (S.cam !== "chase") setCam("chase");
      return snapshot();
    },
    resetCamera: function () {
      if (S.cam !== "chase") setCam("chase");
      else startReset();
      return snapshot();
    },
    setQuality: function (q: Quality) {
      const nq: Quality = q === "balanced" ? "balanced" : "high";
      if (nq !== S.quality) {
        S.quality = nq;
        resize();
      }
    },
    dispose: function () {
      disposed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", resize);
      controls.dispose();
      scene.traverse(function (o) {
        const mesh = o as T.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material)
          (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(function (m) {
            const sm = m as T.MeshStandardMaterial;
            if (sm.map) sm.map.dispose();
            if (sm.alphaMap) sm.alphaMap.dispose();
            m.dispose();
          });
      });
      bakeQuad.geometry.dispose();
      bakeMat.dispose();
      rtAlbedo.dispose();
      rtAux.dispose();
      if (envRT) envRT.dispose();
      pmrem.dispose();
      envMesh.geometry.dispose();
      envMat.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}
