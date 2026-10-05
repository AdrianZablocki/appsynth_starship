import type { Dictionary } from "@/i18n/dictionary";
import type { CamMode, Follow, Snapshot } from "@/sim/createSim";
import { OrbitIcon, PauseIcon, PlayIcon, ResetCameraIcon, RestartIcon, SkipIcon } from "./icons";
import styles from "./LaunchSimulator.module.css";

export const WARPS = [1, 4, 16, 64] as const;
const FOLLOWS: Follow[] = ["auto", "booster", "ship"];
const CAMS: CamMode[] = ["chase", "ground"];

export interface ConsoleActions {
  primary(): void;
  restart(): void;
  skip(): void;
  setWarp(w: number): void;
  toggleAuto(): void;
  setFollow(f: Follow): void;
  setCam(c: CamMode): void;
  toggleOrbit(): void;
  resetCamera(): void;
}

interface Props {
  t: Dictionary;
  snap: Snapshot;
  actions: ConsoleActions;
}

const pct = (v: number) => (v * 100).toFixed(2) + "%";

/** Mission timeline and the controls: launch/pause, restart, next event, time warp, followed vehicle, camera. */
export function ControlConsole({ t, snap: s, actions: a }: Props) {
  const idle = !s.launched;
  const playing = s.launched && !s.paused;

  return (
    <div className={`${styles.glass} ${styles.console}`}>
      <div className={styles.timeline} aria-hidden="true">
        <div className={styles.track}>
          <span className={styles.fill} style={{ width: pct(s.tl) }} />
        </div>
        {s.ticks.map((tk) => (
          <span key={tk.id} className={styles.tick} style={{ left: pct(tk.left) }} data-done={tk.done}>
            <span className={styles.dot} />
            <span className={styles.tickLabel} data-minor={tk.minor}>
              {t.ticks[tk.id]}
            </span>
          </span>
        ))}
      </div>

      <div className={styles.controls}>
        <div className={styles.ctlGroup}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} data-idle={idle} onClick={a.primary}>
            {playing ? <PauseIcon /> : <PlayIcon />}
            <span>{idle ? t.launch : s.paused ? t.resume : t.pause}</span>
          </button>
          <button type="button" className={styles.btn} onClick={a.restart} aria-label={t.restartLabel}>
            <RestartIcon />
            <span className={styles.btnText}>{t.restart}</span>
          </button>
          <button type="button" className={styles.btn} onClick={a.skip} disabled={!s.canSkip} aria-label={t.nextLabel}>
            <SkipIcon />
            <span className={styles.btnText}>{t.next}</span>
          </button>

          <div className={`${styles.seg} ${styles.oTime}`} role="group" aria-label={t.timeLabel}>
            <span className={styles.segLabel}>{t.time}</span>
            {WARPS.map((w) => (
              <button
                key={w}
                type="button"
                className={styles.segBtn}
                aria-pressed={s.warpUser === w}
                onClick={() => a.setWarp(w)}
              >
                {w}×
              </button>
            ))}
            <button type="button" className={styles.segBtn} aria-pressed={s.auto} onClick={a.toggleAuto}>
              {t.auto}
            </button>
          </div>
        </div>

        <div className={styles.ctlGroup}>
          <div className={`${styles.seg} ${styles.oFollow}`} role="group" aria-label={t.followLabel}>
            <span className={styles.segLabel}>{t.follow}</span>
            {FOLLOWS.map((f) => (
              <button
                key={f}
                type="button"
                className={styles.segBtn}
                aria-pressed={s.follow === f}
                onClick={() => a.setFollow(f)}
              >
                {t[f]}
              </button>
            ))}
          </div>

          <div className={`${styles.seg} ${styles.oCam}`} role="group" aria-label={t.camLabel}>
            <span className={styles.segLabel}>{t.cam}</span>
            {CAMS.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.segBtn}
                aria-pressed={s.cam === c}
                onClick={() => a.setCam(c)}
              >
                {t[c]}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`${styles.btn} ${styles.oOrbit}`}
            aria-pressed={s.autoOrbit}
            aria-label={t.orbitViewLabel}
            title={t.orbitView}
            onClick={a.toggleOrbit}
          >
            <OrbitIcon className={styles.orbitIcon} />
            <span className={`${styles.btnText} ${styles.optText}`}>{t.orbitView}</span>
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.oReset}`}
            aria-label={t.resetCamera}
            title={t.resetCamera}
            onClick={a.resetCamera}
          >
            <ResetCameraIcon />
            <span className={`${styles.btnText} ${styles.optText}`}>{t.resetCamera}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
