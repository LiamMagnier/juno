import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { CookieConsent } from "@/components/app/cookie-consent";
import { getInitialPreferences } from "@/lib/preferences";
import { auth } from "@/lib/auth";

// Newsreader: an editorial serif used as the overall UI typeface (variable font
// with optical sizing, so it reads cleanly from 11px labels to display headings).
// JetBrains Mono stays for labels/metadata + the dot/ASCII signature layer.
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", display: "swap", style: ["normal", "italic"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const APP_DESCRIPTION = "Juno — a thoughtful AI assistant for chat, code, and creativity.";

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
    images: [{ url: "/juno-mark.png", width: 512, height: 512, alt: "Juno" }],
  },
  twitter: {
    card: "summary",
    title: "Juno",
    description: APP_DESCRIPTION,
    images: ["/juno-mark.png"],
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
  const [{ accent, theme }, session] = await Promise.all([getInitialPreferences(), auth()]);

  return (
    <html
      lang="en"
      data-accent={accent}
      suppressHydrationWarning
      className={`${serif.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <Providers defaultTheme={theme} session={session}>
          {children}
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
