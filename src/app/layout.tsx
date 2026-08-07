import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import { Providers } from "@/components/providers";
import { CookieConsent } from "@/components/app/cookie-consent";
import { getInitialPreferences } from "@/lib/preferences";
import { auth } from "@/lib/auth";
import { directionOf, isAutoLocale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/i18n-server";

// Two faces, two jobs. Archivo is the interface voice — a grotesque with a
// variable weight axis and real tabular figures, for controls, menus, tables and
// anything at UI size. Newsreader is now reserved for display and continuous
// reading: hero, headings, page titles, greetings and the assistant's prose.
//
// `axes: ["opsz"]` on Newsreader is REQUIRED, not decorative: Google Fonts serves
// the default axis set unless axes are requested, so the `font-optical-sizing:
// auto` that globals.css has always declared was a silent no-op.
//
// JetBrains Mono stays for labels/metadata + the dot/ASCII signature layer.
const sans = Archivo({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", display: "swap", style: ["normal", "italic"], axes: ["opsz"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const APP_DESCRIPTION =
  "Every frontier AI model — Claude, GPT, Gemini and a dozen more labs — in one calm workspace, metered by what answers actually cost.";

export const metadata: Metadata = {
  title: { default: "Juno", template: "%s · Juno" },
  description: APP_DESCRIPTION,
  applicationName: "Juno",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  openGraph: {
    siteName: "Juno",
    type: "website",
    locale: "en_US",
    title: "Juno",
    description: APP_DESCRIPTION,
    // Static 1200×630 card generated from the design tokens (see public/og.png).
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Juno — every frontier AI model, one honest subscription" }],
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
    { media: "(prefers-color-scheme: light)", color: "#faf9f6" },
    { media: "(prefers-color-scheme: dark)", color: "#16140f" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [{ accent, theme, uiLocale }, session] = await Promise.all([getInitialPreferences(), auth()]);
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
        <Providers defaultTheme={theme} session={session} locale={locale} autoDetect={isAutoLocale(uiLocale)}>
          {children}
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
