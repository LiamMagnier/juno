"use client";

import * as React from "react";
import Link from "next/link";
import { PublicFrame, PublicBrand } from "@/components/public/public-frame";
import { PublicThemeToggle } from "@/components/public/theme-toggle";
import { ContinuumMark } from "@/components/brand/continuum-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCodeInput, PAIRING_CODE_INPUT_LENGTH as CODE_LENGTH } from "@/lib/code-v2/pairing-code";

type Summary = { id: string; deviceName: string; expiresAt: string };
export type RemotePairStep =
  | { kind: "code" }
  | { kind: "confirm"; summary: Summary }
  | { kind: "paired"; deviceName: string }
  | { kind: "denied"; deviceName: string };

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/**
 * The Computer tab of a Mac's "Control this Mac remotely" sheet, on the web:
 * type the code the Mac shows, see which Mac it is, approve or deny.
 * Approving sets this browser's pairing cookie (server side, httpOnly); from
 * then on Code on the web can drive that Mac until it is removed there.
 */
export function RemotePairBrowser({ initialStep, initialCode = "" }: { initialStep?: RemotePairStep; initialCode?: string } = {}) {
  const [step, setStep] = React.useState<RemotePairStep>(initialStep ?? { kind: "code" });
  const [code, setCode] = React.useState(initialCode);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const field = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (step.kind === "code") field.current?.focus();
  }, [step.kind]);

  const complete = code.replace("-", "").length === CODE_LENGTH;

  async function inspect(event: React.FormEvent) {
    event.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/api/code/pairing/inspect", { code });
    setBusy(false);
    if (!ok) return setError(String(data.message ?? data.error ?? "That code did not work. Check it and try again."));
    setStep({ kind: "confirm", summary: data as unknown as Summary });
  }

  async function decide(approve: boolean) {
    if (step.kind !== "confirm" || busy) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await post(approve ? "/api/code/pairing/approve" : "/api/code/pairing/deny", { code });
    setBusy(false);
    if (!ok) {
      setError(String(data.message ?? data.error ?? "Alevr could not finish pairing. Show a new code on your Mac."));
      setStep({ kind: "code" });
      setCode("");
      return;
    }
    setStep(approve ? { kind: "paired", deviceName: step.summary.deviceName } : { kind: "denied", deviceName: step.summary.deviceName });
  }

  return (
    <PublicFrame className="alevr-public-state alv">
      <header className="alevr-access-header">
        <PublicBrand />
        <PublicThemeToggle />
      </header>
      <main className="alv-state">
        <div className="alv-state-copy">
          <div className="alv-state-identifier alv-enter" aria-hidden="true">
            <ContinuumMark size={56} />
          </div>
          {step.kind === "code" && (
            <>
              <h1 className="alv-display alv-enter">Pair this browser with your Mac</h1>
              <p className="alv-lede alv-enter">
                On your Mac, open Alevr › Settings › Connections › Control this Mac remotely, choose Computer, and type the code it shows.
              </p>
              <form onSubmit={inspect} className="alv-state-actions alv-enter mx-auto flex w-full max-w-sm flex-col items-stretch gap-3">
                <label htmlFor="pair-code" className="sr-only">
                  Pairing code
                </label>
                <Input
                  id="pair-code"
                  ref={field}
                  value={code}
                  onChange={(e) => setCode(formatCodeInput(e.target.value))}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="XXXX-XXXX"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "pair-error" : undefined}
                  className="h-14 text-center font-mono text-[1.5rem] tracking-[0.3em]"
                />
                <Button type="submit" size="lg" disabled={!complete || busy}>
                  {busy ? "Checking…" : "Continue"}
                </Button>
              </form>
            </>
          )}
          {step.kind === "confirm" && (
            <>
              <h1 className="alv-display alv-enter">Allow this browser to control Alevr on {step.summary.deviceName}?</h1>
              <p className="alv-lede alv-enter">
                It can start and steer Code sessions, answer approvals and see changes, in the folders your Mac shares. Remove it on your Mac at any time.
              </p>
              <div className="alv-state-actions alv-enter">
                <Button size="lg" onClick={() => decide(true)} disabled={busy}>
                  {busy ? "Approving…" : "Approve"}
                </Button>
                <Button size="lg" variant="ghost" onClick={() => decide(false)} disabled={busy}>
                  Deny
                </Button>
              </div>
            </>
          )}
          {step.kind === "paired" && (
            <>
              <h1 className="alv-display alv-enter">This browser can now control {step.deviceName}</h1>
              <p className="alv-lede alv-enter">Open Code to start or follow a session on your Mac.</p>
              <div className="alv-state-actions alv-enter">
                <Button asChild size="lg">
                  <Link href="/code">Open Code</Link>
                </Button>
              </div>
            </>
          )}
          {step.kind === "denied" && (
            <>
              <h1 className="alv-display alv-enter">Not paired</h1>
              <p className="alv-lede alv-enter">{step.deviceName} will tell you it was denied. Show a new code on your Mac to try again.</p>
              <div className="alv-state-actions alv-enter">
                <Button size="lg" variant="ghost" onClick={() => setStep({ kind: "code" })}>
                  Enter another code
                </Button>
              </div>
            </>
          )}
          {error && (
            <p id="pair-error" role="alert" className="mt-4 text-ui text-destructive">
              {error}
            </p>
          )}
        </div>
      </main>
    </PublicFrame>
  );
}
