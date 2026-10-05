import { TAU, clamp, easeInOut, lerp, linTab, makeMono, smoothstep, type Table } from "./math";

const D2R = Math.PI / 180;

/** Earth radius, m. */
export const RE = 6371000;
export const MU_E = 3.986004418e14;
export const G0 = 9.80665;
/** Height of the orbital launch mount deck above the ground, m. */
export const H_OLM = 22;
/** Super Heavy length (base to hot-stage ring top), m. */
export const L_B = 71;
/* Mission events, seconds from lift-off. */
export const T_IGN = -3.0;
export const T_BMECO = 157;
export const T_SHIPIGN = 158.6;
export const T_SEP = 160.5;
export const T_BB0 = 168;
export const T_SECO = 515;
/** Suborbital trajectory: apogee and (virtual) perigee altitude, m. */
export const APO_ALT = 215000;
const PERI_ALT = -45000;
/** Entry interface, m. */
export const H_EI = 120000;
/** Altitude where the ship flips for the landing burn, m. */
const H_FLIP = 420;
/** Height of the catch point above the pad, m. */
export const CS_BASE = 34;
/** Starbase latitude. */
export const LAT = 25.99 * D2R;

/* stack speed (m/s) to staging and flight-path angle (deg) to ship cutoff */
const STACK_V: Table = [
  [0, 0],
  [10, 30],
  [20, 85],
  [30, 150],
  [40, 220],
  [50, 300],
  [60, 380],
  [70, 470],
  [80, 580],
  [90, 700],
  [100, 840],
  [110, 990],
  [120, 1150],
  [130, 1300],
  [140, 1420],
  [150, 1510],
  [157, 1560],
  [160.5, 1565],
];
const GAM_BASE: Table = [
  [-10, 90],
  [14, 90],
  [25, 86],
  [40, 78],
  [60, 66],
  [80, 56],
  [100, 46],
  [120, 39],
  [140, 33],
  [160.5, 28],
  [200, 18],
  [250, 10],
  [300, 5],
  [350, 2.2],
  [400, 1.0],
  [450, 0.6],
  [515, 0.4],
];

/** Super Heavy throttle during the ascent, %. */
export function boosterThrottle(t: number): number {
  if (t < T_IGN) return 0;
  if (t < 0) return 100 * smoothstep(T_IGN, -0.4, t);
  if (t < 46) return 100;
  if (t < 52) return lerp(100, 82, (t - 46) / 6);
  if (t < 66) return 82;
  if (t < 72) return lerp(82, 100, (t - 66) / 6);
  if (t < T_BMECO) return 100;
  return 70;
}

/** Raptors running on Super Heavy during the ascent. */
export function boosterEnginesAscent(t: number): number {
  if (t < T_IGN) return 0;
  if (t < -2.2) return 3;
  if (t < -1.4) return 13;
  if (t < T_BMECO) return 33;
  if (t < T_SEP + 1.5) return 3;
  return 0;
}

/** Interpolated flight state at one moment of the powered ascent. */
export interface AscentSample {
  /** Altitude above the mount, m. */
  h: number;
  /** Downrange distance along the surface, m. */
  s: number;
  /** Speed, m/s. */
  v: number;
  /** Flight-path angle, rad. */
  gam: number;
  /** Acceleration, g. */
  gf: number;
  /** Dynamic pressure, Pa. */
  q: number;
  /** Booster throttle, %. */
  bthr: number;
  /** Ship throttle, %. */
  sthr: number;
}

export interface Ascent {
  DT: number;
  t0: number;
  N: number;
  H: Float64Array;
  S: Float64Array;
  V: Float64Array;
  GAM: Float64Array;
  GF: Float64Array;
  Q: Float64Array;
  BTHR: Float64Array;
  STHR: Float64Array;
  tMaxQ: number;
  qMax: number;
  sample<O extends AscentSample>(t: number, o: O): O;
}

export function newAscentSample(): AscentSample {
  return { h: 0, s: 0, v: 0, gam: 0, gf: 0, q: 0, bthr: 0, sthr: 0 };
}

/** Tabulates the ascent from T−10 s to ship cutoff; four passes tune the final flight-path angle to hit the target trajectory. */
export function buildAscent(): Ascent {
  const vF = makeMono(
    STACK_V.map((r) => r[0]),
    STACK_V.map((r) => r[1]),
  );
  const DT = 0.1;
  const t0 = -10;
  const N = Math.round((T_SECO - t0) / DT) + 1;
  const H = new Float64Array(N);
  const S = new Float64Array(N);
  const V = new Float64Array(N);
  const GAM = new Float64Array(N);
  const GF = new Float64Array(N);
  const Q = new Float64Array(N);
  const BTHR = new Float64Array(N);
  const STHR = new Float64Array(N);
  const gam = GAM_BASE.map((r) => [r[0], r[1]] as [number, number]);
  const acc = new Float64Array(N);
  let vSeco = 7760;
  let k: number;
  let t: number;
  for (let iter = 0; iter < 4; iter++) {
    let mB = 3675e3;
    let mS = 1620e3;
    let a2 = 0;
    for (k = 0; k < N; k++) {
      t = t0 + k * DT;
      const bn = boosterEnginesAscent(t);
      const bthr = boosterThrottle(t);
      const FB = (bn * 2.26e6 * bthr) / 100;
      let sthr = t >= T_SHIPIGN && t < T_SECO ? 100 : 0;
      const FS = (14.9e6 * sthr) / 100;
      let m: number;
      let a: number;
      if (t < T_SEP) {
        m = mB + mS;
        a = (FB + (t >= T_SHIPIGN ? 0.25 * FS : 0)) / m;
      } else {
        m = mS;
        a = FS / m;
        if (a > 3.5 * G0) {
          sthr *= (3.5 * G0) / a;
          a = 3.5 * G0;
        }
      }
      BTHR[k] = bn > 0 ? bthr : 0;
      STHR[k] = sthr;
      GF[k] = t < 0 ? 1 : a / G0;
      acc[k] = a2;
      if (t >= T_SEP) a2 += a * DT;
      mB -= ((bn * 650 * bthr) / 100) * DT;
      if (t >= T_SHIPIGN) mS -= ((6 * 690 * sthr) / 100) * DT;
    }
    const vSep = vF(T_SEP);
    let hh = 0;
    let s = 0;
    for (k = 0; k < N; k++) {
      t = t0 + k * DT;
      const v = t <= 0 ? 0 : t < T_SEP ? vF(t) : vSep + ((vSeco - vSep) * acc[k]) / acc[N - 1];
      const g = linTab(gam, t) * D2R;
      V[k] = v;
      GAM[k] = g;
      H[k] = hh;
      S[k] = s;
      Q[k] = 0.5 * 1.225 * Math.exp(-hh / 8500) * v * v;
      hh = Math.max(0, hh + v * Math.sin(g) * DT);
      s += ((v * Math.cos(g) * RE) / (RE + H_OLM + hh)) * DT;
    }
    const r = RE + H_OLM + H[N - 1];
    const ra = RE + APO_ALT;
    const rp = RE + PERI_ALT;
    const sma = (ra + rp) / 2;
    const e = (ra - rp) / (ra + rp);
    vSeco = Math.sqrt(MU_E * (2 / r - 1 / sma));
    const hAng = Math.sqrt(MU_E * sma * (1 - e * e));
    gam[gam.length - 1][1] = Math.acos(clamp(hAng / (r * vSeco), -1, 1)) / D2R;
  }
  let qMax = 0;
  let tMaxQ = 60;
  for (k = 0; k < N; k++) {
    t = t0 + k * DT;
    if (t > 0 && t < T_SEP && Q[k] > qMax) {
      qMax = Q[k];
      tMaxQ = t;
    }
  }
  return {
    DT,
    t0,
    N,
    H,
    S,
    V,
    GAM,
    GF,
    Q,
    BTHR,
    STHR,
    tMaxQ,
    qMax,
    sample(tt, o) {
      const f = clamp((tt - t0) / DT, 0, N - 1);
      const i = Math.min(N - 2, Math.floor(f));
      const w = f - i;
      o.h = lerp(H[i], H[i + 1], w);
      o.s = lerp(S[i], S[i + 1], w);
      o.v = lerp(V[i], V[i + 1], w);
      o.gam = lerp(GAM[i], GAM[i + 1], w);
      o.gf = lerp(GF[i], GF[i + 1], w);
      o.q = lerp(Q[i], Q[i + 1], w);
      o.bthr = lerp(BTHR[i], BTHR[i + 1], w);
      o.sthr = lerp(STHR[i], STHR[i + 1], w);
      return o;
    },
  };
}

/** Super Heavy state after staging. */
export interface BoosterSample {
  /** Angle from the pad around the Earth's centre, rad. */
  th: number;
  /** Altitude, m. */
  h: number;
  /** Horizontal and vertical speed, m/s. */
  vh: number;
  vv: number;
  /** Speed, m/s. */
  v: number;
  /** Pitch of the vehicle axis from local horizontal (downrange), rad. */
  psi: number;
  /** Raptors running. */
  eng: number;
  /** Acceleration, g. */
  gf: number;
}

export interface BoosterReturn {
  /** Boostback target horizontal speed, m/s. */
  vxT: number;
  /** End of the boostback burn. */
  tBBe: number;
  /** Landing burn ignition. */
  tIgn: number;
  /** Landing burn drops from 13 to 3 engines. */
  tLB2: number;
  tCatch: number;
  tEnd: number;
  /** Highest point after staging, m. */
  apogee: number;
  sample<O extends BoosterSample>(t: number, o: O): O;
}

interface ReturnSim {
  t: number;
  x: number;
  y: number;
  vh: number;
  vv: number;
  h: number;
  tBBe: number | null;
  crashed?: boolean;
}

/** Super Heavy return: flip, boostback (shooting for the tower), drag-limited fall, landing burn, catch. */
export function buildBooster(A: Ascent): BoosterReturn {
  const s0 = A.sample(T_SEP, newAscentSample());
  const th0 = s0.s / RE;
  const r0 = RE + H_OLM + s0.h;
  const X0 = r0 * Math.sin(th0);
  const Y0 = r0 * Math.cos(th0);
  const vr0 = s0.v * Math.sin(s0.gam);
  const vt0 = s0.v * Math.cos(s0.gam);
  const VX0 = vr0 * Math.sin(th0) + vt0 * Math.cos(th0);
  const VY0 = vr0 * Math.cos(th0) - vt0 * Math.sin(th0);
  const PHI = 4 * D2R;
  const ABB = 30;
  const CDA_M = 115 / 240e3;
  const HT = CS_BASE;
  const A1 = 24;
  const DT = 0.05;
  type Rec = (
    t: number,
    x: number,
    y: number,
    vh: number,
    vv: number,
    h: number,
    phase: number,
    tBBe: number | null,
    fa: number,
  ) => void;
  function sim(vxT: number, rec?: Rec): ReturnSim | null {
    let x = X0;
    let y = Y0;
    let vx = VX0;
    let vy = VY0;
    let t = T_SEP;
    let phase = 0;
    let tBBe: number | null = null;
    let n = 0;
    while (t < T_SEP + 1500) {
      const r = Math.sqrt(x * x + y * y);
      const ux = x / r;
      const uy = y / r;
      const ex = uy;
      const ey = -ux;
      const vh = vx * ex + vy * ey;
      const vv = vx * ux + vy * uy;
      const h = r - RE;
      if (phase === 0 && t >= T_BB0) phase = 1;
      let bscale = 1;
      if (phase === 1) {
        const dvh = -ABB * Math.cos(PHI) * DT;
        if (vh + dvh <= vxT) {
          bscale = clamp((vh - vxT) / -dvh, 0, 1);
          tBBe = t + bscale * DT;
        }
      }
      if (phase === 2 && vv < 0 && h < 2600 && h <= HT + 60 + (vv * vv - 324) / (2 * A1))
        return { t, x, y, vh, vv, h, tBBe };
      if (h < 0) return { t, x, y, vh, vv, h, tBBe, crashed: true };
      const g = -MU_E / (r * r);
      let ax = g * ux;
      let ay = g * uy;
      let fa = 0;
      if (phase === 1) {
        const dx = -Math.cos(PHI) * ex + Math.sin(PHI) * ux;
        const dy = -Math.cos(PHI) * ey + Math.sin(PHI) * uy;
        ax += ABB * bscale * dx;
        ay += ABB * bscale * dy;
        fa = ABB;
      }
      const v = Math.sqrt(vx * vx + vy * vy);
      const rho = 1.225 * Math.exp(-h / 7200);
      const D = 0.5 * rho * v * v * CDA_M;
      if (v > 1) {
        ax -= (D * vx) / v;
        ay -= (D * vy) / v;
        fa += D;
      }
      if (rec && n % 2 === 0) rec(t, x, y, vh, vv, h, phase, tBBe, fa);
      vx += ax * DT;
      vy += ay * DT;
      x += vx * DT;
      y += vy * DT;
      t += DT;
      n++;
      if (phase === 1 && bscale < 1) phase = 2;
    }
    return null;
  }
  /* where the landing burn would put the booster, given its state at ignition */
  function predictS1(r: ReturnSim) {
    const a1p = (r.vv * r.vv - 324) / (2 * (r.h - (HT + 60)));
    const T1p = (Math.abs(r.vv) - 18) / a1p;
    return Math.atan2(r.x, r.y) * RE + (r.vh * T1p) / 2;
  }
  /* bisect the boostback cutoff speed so the landing burn ends over the tower */
  let lo = -2000;
  let hi = 600;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const res = sim(mid);
    const sI = res && !res.crashed ? predictS1(res) : 1e9;
    if (sI > 0) hi = mid;
    else lo = mid;
  }
  const vxT = (lo + hi) / 2;
  const TT: number[] = [];
  const TH: number[] = [];
  const HH: number[] = [];
  const VH: number[] = [];
  const VV: number[] = [];
  const PSI: number[] = [];
  const ENG: number[] = [];
  const GF: number[] = [];
  const gSep = s0.gam;
  const push = (t: number, th: number, h: number, vh: number, vv: number, psi: number, eng: number, gf: number) => {
    TT.push(t);
    TH.push(th);
    HH.push(h);
    VH.push(vh);
    VV.push(vv);
    PSI.push(psi);
    ENG.push(eng);
    GF.push(gf);
  };
  const res = sim(vxT, (t, x, y, vh, vv, h, phase, tBBe, fa) => {
    let psi: number;
    let eng: number;
    if (phase === 0) {
      psi = lerp(gSep, Math.PI - PHI, easeInOut((t - T_SEP) / (T_BB0 - T_SEP)));
      eng = t < T_SEP + 1.5 ? 3 : 0;
    } else if (phase === 1) {
      psi = Math.PI - PHI;
      eng = 13;
    } else {
      const pt = clamp(Math.atan2(-vv, -vh), 15 * D2R, 165 * D2R);
      psi = lerp(Math.PI - PHI, pt, easeInOut((t - (tBBe ?? t)) / 15));
      eng = 0;
    }
    push(t, Math.atan2(x, y), h, vh, vv, psi, eng, fa / G0);
  });
  if (!res || res.tBBe === null) throw new Error("Super Heavy return trajectory did not converge.");
  const tBBe = res.tBBe;
  const tIgn = res.t;
  const sI0 = Math.atan2(res.x, res.y) * RE;
  const hI = res.h;
  const vhI = res.vh;
  const vvI = res.vv;
  const psiI = PSI[PSI.length - 1];
  /* landing burn: constant deceleration to 18 m/s at 60 m above the catch point, then 3 engines down to the arms */
  const a1 = (vvI * vvI - 324) / (2 * (hI - (HT + 60)));
  const T1 = (Math.abs(vvI) - 18) / a1;
  const s1 = sI0 + (vhI * T1) / 2;
  const a2 = 324 / 120;
  const T2 = 18 / a2;
  const T3 = 1.8;
  const T4 = 1.4;
  const tLB2 = tIgn + T1;
  const tCatch = tIgn + T1 + T2 + T3;
  const tEnd = tCatch + T4;
  const tLast = TT[TT.length - 1];
  for (let t = tLast + 0.1; t <= tEnd + 0.05; t += 0.1) {
    const tau = Math.max(0, t - tIgn);
    if (tau < T1) {
      push(
        t,
        (sI0 + vhI * tau - 0.5 * (vhI / T1) * tau * tau) / RE,
        hI + vvI * tau + 0.5 * a1 * tau * tau,
        vhI * (1 - tau / T1),
        vvI + a1 * tau,
        lerp(psiI, 90 * D2R, easeInOut(tau / (0.8 * T1))),
        13,
        (a1 + 9.81) / G0,
      );
    } else if (tau < T1 + T2) {
      const u = tau - T1;
      push(
        t,
        lerp(s1, 0, easeInOut(u / T2)) / RE,
        HT + 60 - 18 * u + 0.5 * a2 * u * u,
        0,
        -18 + a2 * u,
        90 * D2R,
        3,
        (a2 + 9.81) / G0,
      );
    } else if (tau < T1 + T2 + T3) {
      push(t, 0, HT, 0, 0, 90 * D2R, 3, 1);
    } else {
      const w = (tau - T1 - T2 - T3) / T4;
      push(t, 0, HT - 1.0 * easeInOut(w), 0, 0, 90 * D2R, w < 0.3 ? 3 : 0, 1);
    }
  }
  let apogee = 0;
  for (const h of HH) apogee = Math.max(apogee, h);
  return {
    vxT,
    tBBe,
    tIgn,
    tLB2,
    tCatch,
    tEnd,
    apogee,
    sample(t, o) {
      const n = TT.length;
      if (t >= TT[n - 1]) {
        const k = n - 1;
        o.th = TH[k];
        o.h = HH[k];
        o.vh = 0;
        o.vv = 0;
        o.psi = PSI[k];
        o.eng = 0;
        o.gf = 1;
        o.v = 0;
        return o;
      }
      const f = clamp((t - TT[0]) / 0.1, 0, n - 1);
      const i = Math.min(n - 2, Math.floor(f));
      const wv = f - i;
      o.th = lerp(TH[i], TH[i + 1], wv);
      o.h = lerp(HH[i], HH[i + 1], wv);
      o.vh = lerp(VH[i], VH[i + 1], wv);
      o.vv = lerp(VV[i], VV[i + 1], wv);
      o.psi = lerp(PSI[i], PSI[i + 1], wv);
      o.eng = wv < 0.5 ? ENG[i] : ENG[i + 1];
      o.gf = lerp(GF[i], GF[i + 1], wv);
      o.v = Math.sqrt(o.vh * o.vh + o.vv * o.vv);
      return o;
    },
  };
}

/** Starship after cutoff: tabulated coast (1 s steps) and entry (0.25 s steps) in the Earth-centred plane, then the landing. */
export interface ShipFlight {
  /* coast samples: position, velocity, unwrapped angle */
  CX: number[];
  CY: number[];
  CVX: number[];
  CVY: number[];
  CTH: number[];
  /* entry samples, plus heating rate and deceleration (g) */
  RX: number[];
  RY: number[];
  RVX: number[];
  RVY: number[];
  RTH: number[];
  RQ: number[];
  RG: number[];
  tApo: number;
  /** Entry interface. */
  tEI: number;
  qMax: number;
  gMax: number;
  /** Peak heating. */
  tPeak: number;
  /** Subsonic. */
  tSub: number;
  /** Flip and landing burn ignition. */
  tF: number;
  thLand: number;
  /* state at the flip */
  vF: number;
  hF: number;
  vhF: number;
  vvF: number;
  gamF: number;
  /* landing burn: flip time, height at burn start, deceleration, burn time */
  T0: number;
  h1: number;
  aL: number;
  T1: number;
  tL1: number;
  tSplash: number;
  tTip: number;
  tImpact: number;
  /** Splashdown point, angle from the pad. */
  thSplash: number;
}

/** Starship: cutoff → ballistic coast → lifting entry with drag → belly flop → flip and landing burn. */
export function buildShip(A: Ascent): ShipFlight {
  const k0 = A.N - 1;
  const th = A.S[k0] / RE;
  const r = RE + H_OLM + A.H[k0];
  const v = A.V[k0];
  const g = A.GAM[k0];
  let x = r * Math.sin(th);
  let y = r * Math.cos(th);
  const vr = v * Math.sin(g);
  const vt = v * Math.cos(g);
  let vx = vr * Math.sin(th) + vt * Math.cos(th);
  let vy = vr * Math.cos(th) - vt * Math.sin(th);
  const CX: number[] = [];
  const CY: number[] = [];
  const CVX: number[] = [];
  const CVY: number[] = [];
  const CTH: number[] = [];
  const RX: number[] = [];
  const RY: number[] = [];
  const RVX: number[] = [];
  const RVY: number[] = [];
  const RTH: number[] = [];
  const RQ: number[] = [];
  const RG: number[] = [];
  let t = T_SECO;
  let tApo: number | null = null;
  let prevVr = 1;
  let thU = th;
  function grav(px: number, py: number): [number, number] {
    const r2 = px * px + py * py;
    const rr = Math.sqrt(r2);
    const kk = -MU_E / (r2 * rr);
    return [kk * px, kk * py];
  }
  function unwrap(prev: number, nx: number, ny: number) {
    let d = Math.atan2(nx, ny) - (prev % TAU);
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return prev + d;
  }
  /* RK4 coast to entry interface */
  for (let n = 0; n < 30000; n++) {
    const rr = Math.sqrt(x * x + y * y);
    const vrr = (x * vx + y * vy) / rr;
    thU = unwrap(thU, x, y);
    CX.push(x);
    CY.push(y);
    CVX.push(vx);
    CVY.push(vy);
    CTH.push(thU);
    if (n > 0 && prevVr > 0 && vrr <= 0 && tApo === null) tApo = t;
    prevVr = vrr;
    if (n > 10 && rr - RE <= H_EI && vrr < 0) break;
    const dt = 1;
    const a1 = grav(x, y);
    const x2 = x + (vx * dt) / 2;
    const y2 = y + (vy * dt) / 2;
    const vx2 = vx + (a1[0] * dt) / 2;
    const vy2 = vy + (a1[1] * dt) / 2;
    const a2 = grav(x2, y2);
    const x3 = x + (vx2 * dt) / 2;
    const y3 = y + (vy2 * dt) / 2;
    const vx3 = vx + (a2[0] * dt) / 2;
    const vy3 = vy + (a2[1] * dt) / 2;
    const a3 = grav(x3, y3);
    const x4 = x + vx3 * dt;
    const y4 = y + vy3 * dt;
    const vx4 = vx + a3[0] * dt;
    const vy4 = vy + a3[1] * dt;
    const a4 = grav(x4, y4);
    x += (dt / 6) * (vx + 2 * vx2 + 2 * vx3 + vx4);
    y += (dt / 6) * (vy + 2 * vy2 + 2 * vy3 + vy4);
    vx += (dt / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
    vy += (dt / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
    t += dt;
  }
  const tEI = t;
  /* entry: drag plus a little lift (L/D 0.2 above Mach ~3), midpoint steps of 0.05 s, sampled every 0.25 s */
  const CDA_M = 525 / 120e3;
  const dtR = 0.05;
  let qMax = 0;
  let gMax = 0;
  let tPeak = t;
  let tSub: number | null = null;
  function acc(px: number, py: number, pvx: number, pvy: number, out: number[]) {
    const rr2 = Math.sqrt(px * px + py * py);
    const h = rr2 - RE;
    const ux = px / rr2;
    const uy = py / rr2;
    const vv2 = Math.sqrt(pvx * pvx + pvy * pvy);
    const rho = 1.225 * Math.exp(-Math.max(h, 0) / 7200);
    const gg = -MU_E / (rr2 * rr2);
    const D = 0.5 * rho * vv2 * vv2 * CDA_M;
    const LD = vv2 > 1100 ? 0.2 : vv2 > 450 ? (0.2 * (vv2 - 450)) / 650 : 0;
    const dvx = -pvx / vv2;
    const dvy = -pvy / vv2;
    const dot = (ux * pvx + uy * pvy) / (vv2 * vv2);
    const nx = ux - dot * pvx;
    const ny = uy - dot * pvy;
    const nl = Math.sqrt(nx * nx + ny * ny) || 1;
    out[0] = gg * ux + D * dvx + (LD * D * nx) / nl;
    out[1] = gg * uy + D * dvy + (LD * D * ny) / nl;
    out[2] = D * Math.sqrt(1 + LD * LD);
    out[3] = Math.sqrt(rho) * vv2 * vv2 * vv2;
  }
  const ac = [0, 0, 0, 0];
  const am = [0, 0, 0, 0];
  for (let n = 0; n < 200000; n++) {
    const hh = Math.sqrt(x * x + y * y) - RE;
    acc(x, y, vx, vy, ac);
    if (n % 5 === 0) {
      thU = unwrap(thU, x, y);
      RX.push(x);
      RY.push(y);
      RVX.push(vx);
      RVY.push(vy);
      RTH.push(thU);
      RQ.push(ac[3]);
      RG.push(ac[2] / G0);
      if (ac[3] > qMax) {
        qMax = ac[3];
        tPeak = t;
      }
      if (ac[2] / G0 > gMax) gMax = ac[2] / G0;
      if (tSub === null && Math.sqrt(vx * vx + vy * vy) < 330 && hh < 40000) tSub = t;
    }
    if (hh <= H_FLIP && n % 5 === 0) break;
    const xm = x + (vx * dtR) / 2;
    const ym = y + (vy * dtR) / 2;
    const vxm = vx + (ac[0] * dtR) / 2;
    const vym = vy + (ac[1] * dtR) / 2;
    acc(xm, ym, vxm, vym, am);
    x += vxm * dtR;
    y += vym * dtR;
    vx += am[0] * dtR;
    vy += am[1] * dtR;
    t += dtR;
  }
  const tF = t;
  const vF = Math.sqrt(vx * vx + vy * vy);
  const rF = Math.sqrt(x * x + y * y);
  const hF = rF - RE;
  const vhF = (y * vx - x * vy) / rF;
  const vvF = (x * vx + y * vy) / rF;
  /* flip and landing burn: engines light at tF, ship pitches upright, constant-deceleration burn, 2 m/s final descent */
  const T0 = 1.6;
  const h1 = hF - vF * T0;
  const aL = (vF * vF - 4) / (2 * (h1 - 3));
  const T1 = (vF - 2) / aL;
  const tL1 = tF + T0 + T1;
  const tSplash = tL1 + 1.5;
  const tTip = tSplash + 1.2;
  const tImpact = tTip + 3.4;
  return {
    CX,
    CY,
    CVX,
    CVY,
    CTH,
    RX,
    RY,
    RVX,
    RVY,
    RTH,
    RQ,
    RG,
    tApo: tApo ?? T_SECO,
    tEI,
    qMax,
    gMax,
    tPeak,
    tSub: tSub ?? t - 60,
    tF,
    thLand: thU,
    vF,
    hF,
    vhF,
    vvF,
    gamF: Math.atan2(vvF, vhF),
    T0,
    h1,
    aL,
    T1,
    tL1,
    tSplash,
    tTip,
    tImpact,
    thSplash: thU + (vhF * 1.7) / RE,
  };
}

function chapmanJS(X: number, h: number, c: number): number {
  const cc = Math.sqrt(X + h);
  if (c >= 0) return (cc / (cc * c + 1)) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(1 - c * c, 0)) * (X + h);
  if (x0 < X) return 1e7;
  return 2 * Math.sqrt(x0) * Math.exp(X - x0) - (cc / (1 - cc * c)) * Math.exp(-h);
}

/** Sunlight transmittance (rgb) at radius r for a sun at cosine mu above the horizon; matches sunTrans() in the shaders. */
export function sunTransJS(r: number, mu: number, out: number[]): number[] {
  const h = Math.max(r - RE, 0);
  const odR = 8000 * chapmanJS(RE / 8000, h / 8000, mu);
  const odM = 1200 * chapmanJS(RE / 1200, h / 1200, mu);
  const cz = Math.sqrt(Math.max(1 - ((r * r) / (6396000 * 6396000)) * (1 - mu * mu), 0));
  const odO = r < 6411000 || mu < 0 ? 15000 / Math.max(cz, 0.035) : 0;
  out[0] = Math.exp(-(5.8e-6 * odR + 23.1e-6 * odM + 0.65e-6 * odO));
  out[1] = Math.exp(-(13.5e-6 * odR + 23.1e-6 * odM + 1.881e-6 * odO));
  out[2] = Math.exp(-(33.1e-6 * odR + 23.1e-6 * odM + 0.085e-6 * odO));
  return out;
}
