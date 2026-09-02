import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import { Providers } from "@/components/providers";
import { CookieConsent } from "@/components/app/cookie-consent";
import { getInitialPreferences } from "@/lib/preferences";
import { auth } from "@/lib/auth";
import { directionOf, isAutoLocale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/i18n-server";

// One interface voice across native and web. Archivo supplies a warm, highly
// legible grotesque for controls, headings and reading text; hierarchy comes
// from weight, measure and spacing rather than switching to an editorial font.
// JetBrains Mono stays for labels/metadata + the dot/ASCII signature layer.
const sans = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
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
    // Must track --background in globals.css EXACTLY (light `50 22% 96%` →
    // #f7f6f3). This is the colour the OS paints the browser chrome, the iOS
    // status bar and the PWA splash with, so any drift from the page's own
    // ground shows up as a seam between the bar and the paper it continues.
    { media: "(prefers-color-scheme: light)", color: "#f7f6f3" },
    // `.dark --background: 30 7% 9%` → #191715, the warm charcoal ground.
    { media: "(prefers-color-scheme: dark)", color: "#191715" },
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
      className={`${sans.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <Providers
          defaultTheme={theme}
          session={session}
          locale={locale}
          autoDetect={isAutoLocale(uiLocale)}
        >
          {children}
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
