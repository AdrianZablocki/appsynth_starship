import { clamp, lerp } from "./math";

/** Lathe profile point: [radius, height], m. */
export type Pt2 = [number, number];

/** Resamples a lathe profile to near-uniform arc length (keeps v ~ length for tiled textures). */
export function resampleProfile(pts: readonly Pt2[], step: number): Pt2[] {
  const out: Pt2[] = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
  }
  return out;
}

/** Height on the profile at texture coordinate v (0 = base, 1 = top). */
export function profileY(prof: readonly Pt2[], v: number): number {
  const f = clamp(v, 0, 1) * (prof.length - 1);
  const i = Math.min(prof.length - 2, Math.floor(f));
  return lerp(prof[i][1], prof[i + 1][1], f - i);
}

/** Starship hull radius at height y: 9 m barrel, tangent-ogive nose from 33.5 m. */
export function shipRadius(y: number): number {
  if (y <= 0.6) return lerp(4.36, 4.5, y / 0.6);
  if (y <= 33.5) return 4.5;
  const z = y - 33.5;
  const L = 18.5;
  const R = 4.5;
  const rho = (R * R + L * L) / (2 * R);
  return Math.max(0, Math.sqrt(Math.max(rho * rho - z * z, 0)) - (rho - R));
}

/** Starship outline from the aft skirt to the rounded nose tip, 52 m. */
export function shipProfile(): Pt2[] {
  const pts: Pt2[] = [
    [4.36, 0],
    [4.5, 0.6],
    [4.5, 33.5],
  ];
  for (let y = 34.5; y < 50.6; y += 1.0) pts.push([shipRadius(y), y]);
  const yc = 50.55;
  const rc = shipRadius(yc);
  const cy = 51.0;
  for (let k = 1; k <= 8; k++) {
    const a = ((k / 8) * Math.PI) / 2;
    const rr = Math.hypot(rc, cy - yc);
    pts.push([Math.max(0.001, (rr * Math.cos(a) * rc) / rr), cy + (52.0 - cy) * Math.sin(a)]);
  }
  return resampleProfile(pts, 0.35);
}
