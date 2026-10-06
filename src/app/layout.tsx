import type { Metadata, Viewport } from "next";
import { DICTIONARIES } from "@/i18n/dictionary";
import { condensed, mono, sans } from "./fonts";
import "./globals.css";

const en = DICTIONARIES.en;

const SITE_URL = "https://starship.appsynth.eu";

// og:image / twitter:image, icons and the manifest link come from the file conventions in this folder.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: en.title,
  description: en.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: en.title,
    title: en.title,
    description: en.description,
    locale: "en_US",
    alternateLocale: ["pl_PL", "de_DE", "fr_FR"],
  },
  twitter: {
    card: "summary_large_image",
    title: en.title,
    description: en.description,
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: en.title,
  description: en.description,
  url: SITE_URL,
  image: `${SITE_URL}/opengraph-image.png`,
  applicationCategory: "EducationalApplication",
  operatingSystem: "Any (WebGL browser)",
  inLanguage: ["en", "pl", "de", "fr"],
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export const viewport: Viewport = {
  themeColor: "#03050b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${condensed.variable} ${mono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
        {children}
      </body>
    </html>
  );
}
