import type { Metadata, Viewport } from "next";
import { DICTIONARIES } from "@/i18n/dictionary";
import { condensed, mono, sans } from "./fonts";
import "./globals.css";

const en = DICTIONARIES.en;

export const metadata: Metadata = {
  title: en.title,
  description: en.description,
};

export const viewport: Viewport = {
  themeColor: "#03050b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${condensed.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
