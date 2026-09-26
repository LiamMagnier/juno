import { notFound } from "next/navigation";
import { DownloadView } from "@/components/download/download-view";
import type { AppDownload } from "@/lib/app-downloads";

/**
 * Dev-only: the download page with a published, not-yet-notarized Mac build,
 * the state production shows but a machine without a feed token never sees.
 * `?state=notarized` drops the Gatekeeper note. 404s outside development.
 */
const MAC: AppDownload = {
  platform: "macos",
  label: "macOS",
  url: "https://github.com/example/juno/releases/download/v1.7.0/Juno.dmg",
  urlExpiresAt: null,
  version: "1.7.0",
  size: 38_500_000,
  sha256: "c9ccfa763911e93b5351ff99d7d5eef1a57dc8f7d070a1adaabe9a1eff6b729d",
  available: true,
  notarized: false,
};

export default async function DownloadDevPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state } = await searchParams;
  const downloads: AppDownload[] = [
    { ...MAC, notarized: state === "notarized" },
    { platform: "windows", label: "Windows", url: null, urlExpiresAt: null, version: null, size: null, sha256: null, available: false, notarized: null, note: "Not published yet" },
    { platform: "ios", label: "iPhone & iPad", url: null, urlExpiresAt: null, version: null, size: null, sha256: null, available: false, notarized: null, note: "On the App Store soon" },
  ];
  return <DownloadView downloads={downloads} />;
}
