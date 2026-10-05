import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, detectLocale, type Locale } from "@/i18n/dictionary";

const noSubscribe = () => () => {};

/** Browser locale on the client; the default locale during SSR and hydration. */
export function useBrowserLocale(): Locale {
  return useSyncExternalStore(
    noSubscribe,
    () => detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language]),
    () => DEFAULT_LOCALE,
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_MOTION);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}
