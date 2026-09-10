import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { THEME_COLOR } from "@/components/ui/theme-color";
import { getInitialPreferences } from "@/lib/preferences";
import { auth } from "@/lib/auth";
import { directionOf, isAutoLocale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/i18n-server";

// One interface voice across native and web. Inter is the quiet, neutral
// grotesque every calm product interface has converged on (its metrics are
// the closest open face to the custom sans Claude and ChatGPT set); hierarchy
// comes from weight, measure and spacing rather than switching to an
// editorial font.
// JetBrains Mono stays for labels/metadata + the dot/ASCII signature layer.
// Newsreader is the one human moment — the empty-chat greeting — and is loaded
// in roman and italic so the name can be set in true italics, not a slant.
//
// `weight` is stated on each: without it next/font ships the whole variable
// axis, and the three faces together were the largest thing a signed-out
// visitor downloaded. The interface uses exactly regular, medium and semibold
// (bold appears at four sites and is a rendering of 600 here); the serif is
// set at 400 and 500 only; the mono at 400/500 plus the odd 600 badge.
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});
const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const APP_DESCRIPTION =
  "Every frontier AI model — Claude, GPT, Gemini and a dozen more labs — in one calm workspace, metered by what answers actually cost.";

export const metadata: Metadata = {
  title: { default: "Juno", template: "%s · Juno" },
  description: APP_DESCRIPTION,
  applicationName: "Juno",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  openGraph: {
    siteName: "Juno",
    type: "website",
    locale: "en_US",
    title: "Juno",
    description: APP_DESCRIPTION,
    // Static 1200×630 card generated from the design tokens (see public/og.png).
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Juno — every frontier AI model, one honest subscription",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Juno",
    description: APP_DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    // The OS paints the browser chrome, the iOS status bar and the PWA splash
    // with this, so any drift from --background shows as a seam between the
    // bar and the paper it continues. One shared pair (theme-color.ts) rather
    // than a hex restated here: this file, the manifest and global-error.tsx
    // had drifted into three different "backgrounds".
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [{ accent, theme, uiLocale }, session] = await Promise.all([
    getInitialPreferences(),
    auth(),
  ]);
  // Reads headers() only, so serialising it behind the preferences costs no I/O.
  const locale = await getRequestLocale(uiLocale);

  return (
    <html
      lang={locale}
      dir={directionOf(locale)}
      data-accent={accent}
      suppressHydrationWarning
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <Providers
          defaultTheme={theme}
          session={session}
          locale={locale}
          autoDetect={isAutoLocale(uiLocale)}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
