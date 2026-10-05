import { Barlow, Barlow_Semi_Condensed, IBM_Plex_Mono } from "next/font/google";

export const sans = Barlow({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"], variable: "--font-sans" });
export const condensed = Barlow_Semi_Condensed({
  subsets: ["latin", "latin-ext"],
  weight: ["600", "700"],
  variable: "--font-condensed",
});
export const mono = IBM_Plex_Mono({ subsets: ["latin", "latin-ext"], weight: ["400", "500"], variable: "--font-mono" });
