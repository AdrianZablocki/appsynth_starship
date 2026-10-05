export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOut(t: number): number {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function phaseOf(p: number, a: number, b: number): number {
  return easeInOut((p - a) / (b - a));
}

/** Integer hash of a lattice point, in [0, 1). */

export function hash2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise. */

export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), fx), lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), fx), fy);
}

/** Seeded mulberry32 generator, in [0, 1). */

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** Mission clock, e.g. "T+00:08:30". */

export function fmtClock(sec: number): string {
  const neg = sec < 0;
  let s = Math.floor(Math.abs(sec) + (neg ? 0.999 : 0));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return (neg ? "T−" : "T+") + pad2(h) + ":" + pad2(m) + ":" + pad2(s);
}

export function fmtShort(sec: number): string {
  const neg = sec < 0;
  let s = Math.round(Math.abs(sec));
  const m = Math.floor(s / 60);
  s -= m * 60;
  return (neg ? "T−" : "T+") + pad2(m) + ":" + pad2(s);
}

/** Monotone cubic (Fritsch–Carlson) interpolant through (xs, ys). */

export function makeMono(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [];
  const m: number[] = [];
  let i;
  for (i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s2 = a * a + b * b;
    if (s2 > 9) {
      const tau = 3 / Math.sqrt(s2);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  function seg(x: number): number {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return (x: number) => {
    x = clamp(x, xs[0], xs[n - 1]);
    const k = seg(x);
    const h = xs[k + 1] - xs[k];
    const t = (x - xs[k]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[k] +
      (t3 - 2 * t2 + t) * h * m[k] +
      (-2 * t3 + 3 * t2) * ys[k + 1] +
      (t3 - t2) * h * m[k + 1]
    );
  };
}
export type Table = readonly (readonly [number, number])[];

/** Piecewise-linear lookup in a sorted [x, y] table. */

export function linTab(tab: Table, x: number): number {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++)
    if (x <= tab[i][0]) {
      const a = tab[i - 1];
      const b = tab[i];
      return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
    }
  return tab[tab.length - 1][1];
}
