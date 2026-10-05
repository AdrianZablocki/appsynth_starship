import { DICTIONARIES, LOCALES, fill, type Dictionary, type Locale } from "@/i18n/dictionary";
import type { PhaseTone, Snapshot } from "@/sim/createSim";
import { EventLog } from "./EventLog";
import { Telemetry } from "./Telemetry";
import { RocketIcon } from "./icons";
import styles from "./LaunchSimulator.module.css";

const LED: Record<PhaseTone, string> = {
  hold: "var(--grey)",
  paused: "var(--amber)",
  count: "var(--amber)",
  burn: "var(--fire)",
  coast: "var(--accent)",
  done: "var(--green)",
};

interface Props {
  t: Dictionary;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  snap: Snapshot;
}

function phaseText(t: Dictionary, s: Snapshot): string {
  if (s.phase === "booster") return fill(t.phases.booster, { v: t.boosterStatus[s.b.status] });
  if (s.phase === "ship") return fill(t.phases.ship, { v: t.shipStatus[s.s.status] });
  return t.phases[s.phase];
}

/** Top row: mission card with the phase light, language switch and event log; telemetry for both vehicles. */
export function MissionHud({ t, locale, onLocaleChange, snap: s }: Props) {
  const pulse = s.tone === "burn" || s.tone === "count";

  return (
    <div className={`${styles.row} ${styles.rowTop}`}>
      <div className={styles.leftCol}>
        <section className={`${styles.glass} ${styles.mission}`} aria-label={t.missionLabel}>
          <span className={styles.badge}>
            <RocketIcon />
          </span>
          <div className={styles.missionText}>
            <span className={styles.kicker}>{t.kicker}</span>
            <h1 className={styles.title}>{t.h1}</h1>
            <span className={styles.phase}>
              <span
                className={`${styles.led} ${pulse ? styles.pulse : ""}`}
                style={{ "--led": LED[s.tone] } as React.CSSProperties}
              />
              <span className={styles.phaseText}>{phaseText(t, s)}</span>
            </span>
            <div className={styles.langs} role="group" aria-label={t.langLabel}>
              {LOCALES.map((code) => (
                <button
                  key={code}
                  type="button"
                  className={styles.lang}
                  lang={code}
                  title={DICTIONARIES[code].name}
                  aria-pressed={code === locale}
                  onClick={() => onLocaleChange(code)}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </section>
        <EventLog t={t} log={s.log} />
      </div>

      <Telemetry t={t} locale={locale} snap={s} />
    </div>
  );
}
