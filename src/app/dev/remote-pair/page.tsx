import { notFound } from "next/navigation";
import { RemotePairBrowser, type RemotePairStep } from "@/components/code/remote-pair-browser";

/**
 * Dev-only gallery for the web half of remote control pairing
 * (docs/code-v2/REMOTE-CONTROL.md): the code entry, the Allow / Deny
 * question, and the outcomes, without an account. `?step=` picks one.
 * Not linked from anywhere and 404s outside development.
 */
export default async function RemotePairDevPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { step } = await searchParams;
  const steps: Record<string, RemotePairStep> = {
    code: { kind: "code" },
    confirm: { kind: "confirm", summary: { id: "pt_dev", deviceName: "Studio Mac", expiresAt: new Date(Date.now() + 90_000).toISOString() } },
    paired: { kind: "paired", deviceName: "Studio Mac" },
    denied: { kind: "denied", deviceName: "Studio Mac" },
  };
  return <RemotePairBrowser initialStep={steps[step ?? "code"] ?? steps.code} initialCode={step === "code" ? "K7QM-4MZ" : "K7QM-4MZP"} />;
}
