import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { getInitialPreferences } from "@/lib/preferences";

// Newsreader: an editorial serif used as the overall UI typeface (variable font
// with optical sizing, so it reads cleanly from 11px labels to display headings).
// JetBrains Mono stays for labels/metadata + the dot/ASCII signature layer.
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", display: "swap", style: ["normal", "italic"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Juno", template: "%s · Juno" },
  description: "Juno — a thoughtful AI assistant for chat, code, and creativity.",
  applicationName: "Juno",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
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
  const { accent, theme } = await getInitialPreferences();

  return (
    <html
      lang="en"
      data-accent={accent}
      suppressHydrationWarning
      className={`${serif.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <Providers defaultTheme={theme}>{children}</Providers>
      </body>
    </html>
  );
}
