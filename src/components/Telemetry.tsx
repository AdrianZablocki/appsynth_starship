import { fill, type Dictionary, type Locale } from "@/i18n/dictionary";
import { fixed } from "@/lib/format";
import type { BoosterStatus, ShipStatus, Snapshot } from "@/sim/createSim";
import styles from "./LaunchSimulator.module.css";

interface Dot {
  x: string;
  y: string;
  /** Diameter, px. */
  s: number;
}

/** Engine layout seen from below, as percentages of the map disc (vehicle radius 4.9 m = 50%). */
function dot(r: number, deg: number, s: number): Dot {
  const a = (deg * Math.PI) / 180;
  return {
    x: (50 + (r * Math.cos(a) * 50) / 4.9).toFixed(2) + "%",
    y: (50 - (r * Math.sin(a) * 50) / 4.9).toFixed(2) + "%",
    s,
  };
}
/* Super Heavy: 3 centre, 10 inner ring, 20 outer ring, in the order they light */
const B_DOTS: Dot[] = [
  ...[0, 1, 2].map((k) => dot(1.05, 90 + k * 120, 6)),
  ...Array.from({ length: 10 }, (_, k) => dot(2.45, 18 + k * 36, 6)),
  ...Array.from({ length: 20 }, (_, k) => dot(3.87, k * 18, 6)),
];
/* Starship: 3 sea-level Raptors, then 3 Raptor Vacuums */
const S_DOTS: Dot[] = [...[90, 210, 330].map((d) => dot(1.3, d, 9)), ...[30, 150, 270].map((d) => dot(3.05, d, 16))];

/* statuses shown in the warm colour (engines firing, plasma, the catch and the splashdown) */
const HOT_B = new Set<BoosterStatus>(["engineStart", "ascent", "hotStaging", "boostback", "landingBurn", "caught"]);
const HOT_S = new Set<ShipStatus>(["hotStaging", "sixEngine", "relight", "plasma", "landingBurn", "splashdown"]);

function warpText(t: Dictionary, s: Snapshot): string {
  if (!s.launched) return t.ready;
  if (s.paused) return t.pausedWarp;
  if (s.auto && s.warpEff > s.warpUser) return fill(t.autoWarp, { n: String(s.warpEff) });
  if (s.warpEff <= 1) return t.realTime;
  return fill(t.timeWarp, { n: String(s.warpEff) });
}

const alt = (locale: Locale, km: number) => fixed(locale, km, km < 10 ? 2 : 1);

interface VehicleProps {
  t: Dictionary;
  locale: Locale;
  name: string;
  focused: boolean;
  dots: Dot[];
  lit: (i: number) => boolean;
  engines: number;
  total: number;
  spd: number;
  alt: number;
  status: string;
  hot: boolean;
}

function Vehicle({ t, locale, name, focused, dots, lit, engines, total, spd, alt: km, status, hot }: VehicleProps) {
  return (
    <div className={styles.veh} data-focus={focused}>
      <div className={styles.vehHead}>
        <span className={styles.vehName}>{name}</span>
        <span className={styles.vehEng} data-on={engines > 0}>
          {engines} / {total} {t.raptors}
        </span>
      </div>
      <div className={styles.vehBody}>
        <div className={styles.emap} aria-hidden="true">
          {dots.map((d, i) => (
            <span
              key={i}
              className={styles.edot}
              data-on={lit(i)}
              style={{ left: d.x, top: d.y, width: d.s, height: d.s }}
            />
          ))}
        </div>
        <dl className={styles.vehStats}>
          <div className={styles.stat}>
            <dt>{t.speed}</dt>
            <dd>
              {fixed(locale, spd, 0)}
              <span className={styles.unit}>km/h</span>
            </dd>
          </div>
          <div className={styles.stat}>
            <dt>{t.altitude}</dt>
            <dd>
              {alt(locale, km)}
              <span className={styles.unit}>km</span>
            </dd>
          </div>
        </dl>
      </div>
      <span className={styles.vehStatus} data-hot={hot}>
        {status}
      </span>
    </div>
  );
}

/** Mission clock, warp state and a card per vehicle with its engine map, speed, altitude and status. */
export function Telemetry({ t, locale, snap: s }: { t: Dictionary; locale: Locale; snap: Snapshot }) {
  const focusB = s.follow === "booster" || (s.follow === "auto" && s.phase === "booster");
  const focusS = s.follow === "ship" || (s.follow === "auto" && s.phase === "ship");

  return (
    <section className={`${styles.glass} ${styles.telemetry}`} aria-label={t.telemetryLabel}>
      <div className={styles.metHead}>
        <span className={styles.eyebrow}>{t.met}</span>
        <span className={styles.warp} data-fast={s.warpEff > 1}>
          {warpText(t, s)}
        </span>
      </div>
      <span className={styles.met}>{s.met}</span>
      <div className={styles.vehs}>
        <Vehicle
          t={t}
          locale={locale}
          name="Super Heavy"
          focused={focusB}
          dots={B_DOTS}
          lit={(i) => i < s.b.eng}
          engines={s.b.eng}
          total={33}
          spd={s.b.spd}
          alt={s.b.alt}
          status={t.boosterStatus[s.b.status]}
          hot={HOT_B.has(s.b.status)}
        />
        <Vehicle
          t={t}
          locale={locale}
          name="Starship"
          focused={focusS}
          dots={S_DOTS}
          lit={(i) => (i < 3 ? i < s.s.sl : i - 3 < s.s.vac)}
          engines={s.s.sl + s.s.vac}
          total={6}
          spd={s.s.spd}
          alt={s.s.alt}
          status={t.shipStatus[s.s.status]}
          hot={HOT_S.has(s.s.status)}
        />
      </div>
    </section>
  );
}
