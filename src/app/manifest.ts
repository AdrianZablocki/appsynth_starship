import type { MetadataRoute } from "next";
import { DICTIONARIES } from "@/i18n/dictionary";

const en = DICTIONARIES.en;

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: en.title,
    short_name: "Starship",
    description: en.description,
    start_url: "/",
    display: "standalone",
    background_color: "#03050b",
    theme_color: "#03050b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
