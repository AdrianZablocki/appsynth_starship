import type { Locale } from "@/i18n/dictionary";
import type { EventKey } from "@/sim/createSim";

const cache = new Map<string, Intl.NumberFormat>();

/** Fixed-decimal number in the locale's notation (decimal comma and digit grouping of PL/DE/FR). */
export function fixed(locale: Locale, value: number, digits: number): string {
  const key = locale + digits;
  let nf = cache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    cache.set(key, nf);
  }
  return nf.format(value);
}

/** Decimals for each number in an event's subtitle (`{v}`, then `{w}`). */
export const EVENT_DIGITS: Partial<Record<EventKey, number[]>> = {
  maxq: [1],
  sep: [0, 0],
  bbend: [0],
  seco: [0],
  ei: [0],
  peak: [1],
  flip: [0],
};

/** Fills `{v}` and `{w}` of an event subtitle. */
export function eventValues(locale: Locale, key: EventKey, values: number[] | undefined): Record<string, string> {
  const digits = EVENT_DIGITS[key];
  const out: Record<string, string> = {};
  if (!values || !digits) return out;
  ["v", "w"].forEach((name, i) => {
    if (values[i] !== undefined && digits[i] !== undefined) out[name] = fixed(locale, values[i], digits[i]);
  });
  return out;
}
