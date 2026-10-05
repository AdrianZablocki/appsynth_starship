import type { Dictionary } from "@/i18n/dictionary";
import type { Snapshot } from "@/sim/createSim";
import { PulseIcon } from "./icons";
import styles from "./LaunchSimulator.module.css";

/** Latest mission events, newest first. */
export function EventLog({ t, log }: { t: Dictionary; log: Snapshot["log"] }) {
  return (
    <section className={`${styles.glass} ${styles.log}`} aria-label={t.eventsLabel}>
      <h2 className={styles.logHead}>
        <PulseIcon stroke="var(--accent)" />
        {t.eventsLabel}
      </h2>
      {log.length === 0 ? (
        <p className={`${styles.logRow} ${styles.logEmpty}`}>{t.logEmpty}</p>
      ) : (
        <ol className={styles.logList}>
          {log.slice(0, 6).map((e) => (
            <li key={e.key + e.met} className={styles.logRow}>
              <span className={styles.logMet}>{e.met}</span>
              <span>{t.events[e.key][0]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
