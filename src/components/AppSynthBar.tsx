import styles from "./AppSynthBar.module.css";

type BarLocale = "en" | "pl" | "de" | "fr";

// Kept here rather than in the example's dictionary so the bar can be copied between examples as is.
const LEAD: Record<BarLocale, string> = {
  en: "Built with AI agents",
  pl: "Zbudowane z agentami AI",
  de: "Mit KI-Agenten gebaut",
  fr: "Créé avec des agents IA",
};

interface Props {
  locale: BarLocale;
  /** Example name sent as `utm_source`, e.g. "rocketengine". */
  source: string;
}

/** Thin link bar to appsynth.eu above the example; its height is `--appsynth-bar-h` from globals.css. */
export function AppSynthBar({ locale, source }: Props) {
  const href = `https://appsynth.eu/?utm_source=${source}&utm_medium=example&utm_campaign=examples`;

  return (
    <a className={styles.bar} href={href} target="_blank" rel="noopener">
      <span className={styles.brand}>AppSynth</span>
      <span className={styles.lead}>{LEAD[locale]}</span>
      <span className={styles.arrow} aria-hidden="true">→</span>
    </a>
  );
}
