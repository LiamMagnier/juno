"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";

interface VerificationStatus {
  email: string | null;
  verified: boolean;
  canResend: boolean;
}

/**
 * "Confirm your email address" — shown until the address is verified.
 *
 * Self-contained on purpose: it fetches its own state from the rate-limited
 * `/api/account/verification` rather than reading a field from the app
 * bootstrap, so it can be dropped into the shell without widening the
 * bootstrap payload or the context type. It renders nothing at all until it
 * knows the address is unverified, so the common case costs one background
 * request and no layout.
 *
 * The wording says what is actually blocked. A vague "please verify" next to a
 * composer that then refuses to send is the version of this that generates
 * support mail; naming the consequence up front is the version that doesn't.
 */
export function VerifyEmailBanner() {
  const [status, setStatus] = React.useState<VerificationStatus | null>(null);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/account/verification");
        if (!res.ok) return;
        const data = (await res.json()) as VerificationStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // A banner that fails to load is silent, never an error surface.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resend = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/account/verification", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; verified?: boolean };
      if (!res.ok) throw new Error(data.error ?? "Could not send the link.");
      if (data.verified) {
        setStatus((prev) => (prev ? { ...prev, verified: true } : prev));
        return;
      }
      toast.success(data.message ?? "A new link is on its way.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the link.");
    } finally {
      setSending(false);
    }
  };

  if (!status || status.verified) return null;

  return (
    <div
      role="status"
      // shrink-0 so it keeps its height wherever it is mounted: the app shell's
      // <main> is a flex column, and without this the banner is the element
      // that gets squeezed when the page below it wants the space.
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning/10 px-4 py-2.5 text-body text-foreground"
    >
      <MailWarning className="size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1">
        Confirm{" "}
        <span className="font-medium">{status.email ?? "your email address"}</span> to start sending messages — we
        emailed you a link.
      </p>
      {status.canResend && (
        <Button variant="outline" size="sm" onClick={() => void resend()} disabled={sending} className="gap-1.5">
          {sending && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
          Resend link
        </Button>
      )}
    </div>
  );
}
