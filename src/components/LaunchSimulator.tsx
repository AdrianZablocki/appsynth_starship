"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DICTIONARIES, fill, type Dictionary, type Locale } from "@/i18n/dictionary";
import { useBrowserLocale } from "@/lib/browser";
import { eventValues } from "@/lib/format";
import type { Quality, Sim, Snapshot } from "@/sim/createSim";
import { AppSynthBar } from "./AppSynthBar";
import { ControlConsole, type ConsoleActions } from "./ControlConsole";
import { MissionHud } from "./MissionHud";
import { SpinnerIcon, WarningIcon } from "./icons";
import styles from "./LaunchSimulator.module.css";

type Load =
  | { stage: "engine" | "scene" }
  | { stage: "earth"; progress: number }
  | { stage: "ready" }
  | { stage: "error"; reason: "network" | "webgl" | "other"; detail?: string };

const INITIAL_SNAPSHOT: Snapshot = {
  met: "T−00:00:15",
  phase: "hold",
  tone: "hold",
  launched: false,
  paused: false,
  b: { spd: 0, alt: 0, status: "fueled", eng: 0 },
  s: { spd: 0, alt: 0, status: "fueled", sl: 0, vac: 0 },
  warpUser: 1,
  warpEff: 0,
  auto: true,
  follow: "auto",
  cam: "chase",
  autoOrbit: false,
  tl: 0,
  ticks: [],
  log: [],
  toast: null,
  canSkip: true,
};

/** Phones and small tablets get lower resolution, smaller shadow maps and fewer particles. */
function pickQuality(): Quality {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return coarse || Math.min(screen.width, screen.height) < 800 ? "balanced" : "high";
}

function loadingText(t: Dictionary, load: Load): string {
  if (load.stage === "engine") return t.loadingEngine;
  if (load.stage === "earth") return fill(t.loadingEarth, { p: String(Math.round(load.progress * 100)) });
  return t.loadingScene;
}

export function LaunchSimulator() {
  const browserLocale = useBrowserLocale();
  // `null` means the visitor hasn't chosen yet, so the browser language applies.
  const [pickedLocale, setPickedLocale] = useState<Locale | null>(null);
  const [load, setLoad] = useState<Load>({ stage: "engine" });
  const [snap, setSnap] = useState<Snapshot>(INITIAL_SNAPSHOT);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim | null>(null);

  const locale = pickedLocale ?? browserLocale;
  const t = DICTIONARIES[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.title;
  }, [locale, t.title]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let sim: Sim | null = null;

    (async () => {
      let mod: typeof import("@/sim/createSim");
      try {
        mod = await import("@/sim/createSim");
      } catch {
        if (alive) setLoad({ stage: "error", reason: "network" });
        return;
      }
      if (!alive) return;
      setLoad({ stage: "scene" });
      // Building the scene blocks the main thread for a moment; let the loading text paint first.
      timer = window.setTimeout(() => {
        if (!alive || !canvasRef.current) return;
        try {
          sim = mod.createSim(
            canvasRef.current,
            {
              quality: pickQuality(),
              reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            },
            {
              onStatus: (s) => alive && setSnap(s),
              onProgress: (progress) => alive && setLoad({ stage: "earth", progress }),
              onReady: () => {
                if (!alive || !sim) return;
                setLoad({ stage: "ready" });
                setSnap(sim.snapshot());
              },
            },
          );
          simRef.current = sim;
        } catch (e) {
          console.error(e);
          const detail = e instanceof Error ? e.message : String(e);
          setLoad({ stage: "error", reason: /webgl/i.test(detail) ? "webgl" : "other", detail });
        }
      }, 40);
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
      sim?.dispose();
      simRef.current = null;
    };
  }, []);

  const actions = useMemo<ConsoleActions>(() => {
    // Every control returns the fresh snapshot so the UI reacts without waiting for the next status tick.
    const run = (fn: (s: Sim) => Snapshot) => {
      const sim = simRef.current;
      if (sim) setSnap(fn(sim));
    };
    return {
      primary: () => run((s) => s.primary()),
      restart: () => run((s) => s.restart()),
      skip: () => run((s) => s.skip()),
      setWarp: (w) => run((s) => s.setWarp(w)),
      toggleAuto: () => run((s) => s.toggleAuto()),
      setFollow: (f) => run((s) => s.setFollow(f)),
      setCam: (c) => run((s) => s.setCam(c)),
      toggleOrbit: () => run((s) => s.toggleOrbit()),
      resetCamera: () => run((s) => s.resetCamera()),
    };
  }, []);

  const toast = snap.toast;

  return (
    <>
      <AppSynthBar locale={locale} source="starship" />
      <main className={styles.sim}>
        <canvas ref={canvasRef} className={styles.canvas} aria-label={t.canvasLabel} />
        <div className={styles.vignette} aria-hidden="true" />

        <div className={styles.hud}>
          <MissionHud t={t} locale={locale} onLocaleChange={setPickedLocale} snap={snap} />
          <ControlConsole t={t} snap={snap} actions={actions} />
        </div>

        <div className={styles.toastWrap} aria-live="polite">
          {toast && (
            <div key={toast.id} className={`${styles.glass} ${styles.toast}`}>
              <span className={styles.toastTitle}>{t.events[toast.key][0]}</span>
              <span className={styles.toastSub}>
                {fill(t.events[toast.key][1], eventValues(locale, toast.key, toast.values))}
              </span>
            </div>
          )}
        </div>

        {load.stage !== "ready" && load.stage !== "error" && (
          <div className={styles.overlay}>
            <div className={`${styles.glass} ${styles.notice}`} role="status" aria-live="polite">
              <SpinnerIcon className={styles.spin} stroke="var(--accent)" />
              <div className={styles.noticeText}>
                <span className={styles.noticeTitle}>{t.loadingTitle}</span>
                <span className={styles.noticeSub}>{loadingText(t, load)}</span>
              </div>
            </div>
          </div>
        )}

        {load.stage === "error" && (
          <div className={styles.overlay}>
            <div className={`${styles.glass} ${styles.notice}`} role="alert">
              <WarningIcon />
              <div className={styles.noticeText}>
                <span className={styles.noticeTitle}>{t.errorTitle}</span>
                <span className={styles.noticeSub}>
                  {load.reason === "network" ? t.errorNetwork : load.reason === "webgl" ? t.errorWebgl : load.detail}
                </span>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
