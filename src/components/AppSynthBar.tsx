import styles from "./AppSynthBar.module.css";

type BarLocale = "en" | "pl" | "de" | "fr";

// Kept here rather than in the example's dictionary so the bar can be copied between examples as is.
const COPY: Record<BarLocale, { lead: string; cta: string }> = {
  en: { lead: "Built by our AI agents", cta: "See what they can build for you" },
  pl: { lead: "Zbudowane przez naszych agentów AI", cta: "Zobacz, co mogą zbudować dla Ciebie" },
  de: { lead: "Gebaut von unseren KI-Agenten", cta: "Sehen Sie, was sie für Sie bauen können" },
  fr: { lead: "Créé par nos agents IA", cta: "Découvrez ce qu’ils peuvent créer pour vous" },
};

interface Props {
  locale: BarLocale;
  /** Example name sent as `utm_source`, e.g. "rocketengine". */
  source: string;
}

/** Thin link bar to appsynth.eu above the example; its height is `--appsynth-bar-h` from globals.css. */
export function AppSynthBar({ locale, source }: Props) {
  const t = COPY[locale];
  const href = `https://appsynth.eu/?utm_source=${source}&utm_medium=example&utm_campaign=examples`;

  return (
    <a className={styles.bar} href={href} target="_blank" rel="noopener">
      <span className={styles.brand}>AppSynth</span>
      <span className={styles.lead}>{t.lead}</span>
      <span className={styles.cta}>
        {t.cta} <span aria-hidden="true">→</span>
      </span>
    </a>
  );
}
