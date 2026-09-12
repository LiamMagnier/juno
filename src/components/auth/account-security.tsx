"use client";

import * as React from "react";
import { toast } from "sonner";
import Image from "next/image";
import { KeyRound, Loader2, LogOut, Mail, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { signOutToSignIn } from "@/lib/sign-out";

/**
 * Everything about getting into this account, and keeping other people out.
 *
 * Lives next to the auth form rather than inside the Account settings section
 * because it is the same subject: the sign-in form and this panel are the two
 * ends of one flow, and the rules (what needs a password, what needs a code,
 * what invalidates a session) are easier to keep consistent when they are read
 * together.
 *
 * Every error here is an inline, typed message on the field that caused it —
 * through the `Field` primitive, for the same SC 3.3.1 reason it exists. A
 * toast is used only for the thing that belongs to no field: the network.
 */

interface SecurityStatus {
  enabled: boolean;
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  hasPassword: boolean;
}

interface Enrolment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

type ServerError = { error?: string; field?: string };

export function AccountSecuritySection({ email }: { email: string }) {
  const [status, setStatus] = React.useState<SecurityStatus | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/account/mfa");
      if (!res.ok) return;
      setStatus((await res.json()) as SecurityStatus);
    } catch {
      // Leaves the rows in their loading state rather than inventing one.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsGroup title="Sign-in" description="How you get into this account, and how you keep other people out.">
      <TwoStepRow status={status} email={email} onChanged={refresh} />
      <PasswordRow hasPassword={status?.hasPassword ?? true} email={email} />
      <EmailRow currentEmail={email} hasPassword={status?.hasPassword ?? true} />
      <SettingRow
        label="This session"
        description="Sign out on this device. Other devices stay signed in."
        control={
          <Button variant="outline" size="sm" onClick={() => void signOutToSignIn()} className="gap-1.5">
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        }
      />
      <SignOutEverywhereRow />
    </SettingsGroup>
  );
}

// ----------------------------------------------------------------------------
// Two-step verification
// ----------------------------------------------------------------------------

function TwoStepRow({
  status,
  email,
  onChanged,
}: {
  status: SecurityStatus | null;
  email: string;
  onChanged: () => Promise<void>;
}) {
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [disableOpen, setDisableOpen] = React.useState(false);

  const description = !status
    ? "A code from your authenticator app, on top of your password."
    : status.enabled
      ? `On. ${status.recoveryCodesRemaining} of 10 recovery codes left.`
      : "A code from your authenticator app, on top of your password.";

  return (
    <>
      <SettingRow
        label={
          <span className="flex items-center gap-2">
            Two-step verification
            {status?.enabled && <Badge variant="secondary">On</Badge>}
          </span>
        }
        description={description}
        control={
          status?.enabled ? (
            <Button variant="outline" size="sm" onClick={() => setDisableOpen(true)}>
              Turn off…
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSetupOpen(true)} disabled={!status}>
              <ShieldCheck className="size-3.5" />
              Set up…
            </Button>
          )
        }
      />
      <TwoStepSetupDialog
        open={setupOpen}
        email={email}
        onOpenChange={setSetupOpen}
        onDone={() => void onChanged()}
      />
      <TwoStepDisableDialog open={disableOpen} onOpenChange={setDisableOpen} onDone={() => void onChanged()} />
    </>
  );
}

function TwoStepSetupDialog({
  open,
  email,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  email: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [enrolment, setEnrolment] = React.useState<Enrolment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Start the enrolment as the dialog opens, so the QR is already there rather
  // than appearing a beat after the user has read the instructions.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEnrolment(null);
    setRecoveryCodes(null);
    setCode("");
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/account/mfa/start", { method: "POST" });
        const data = (await res.json()) as Enrolment & ServerError;
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Couldn’t start setting up two-step verification.");
          return;
        }
        setEnrolment(data);
      } catch {
        if (!cancelled) setError("Couldn’t reach the server. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/mfa/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json()) as { recoveryCodes?: string[] } & ServerError;
      if (!res.ok) {
        setError(data.error ?? "That code isn’t right.");
        return;
      }
      setRecoveryCodes(data.recoveryCodes ?? []);
      onDone();
    } catch {
      setError("Couldn’t reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        {recoveryCodes ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>
                Each one signs you in once if you lose your authenticator app. This is the only time they are shown —
                they are stored hashed, so nobody, including Juno, can show them to you again.
              </DialogDescription>
            </DialogHeader>
            <ul className="grid grid-cols-2 gap-2 rounded-field border border-border/60 bg-muted/40 p-3 font-mono text-caption text-foreground">
              {recoveryCodes.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(recoveryCodes.join("\n"))
                    .then(() => toast.success("Recovery codes copied."))
                    .catch(() => toast.error("Couldn’t copy — select and copy them by hand."));
                }}
              >
                Copy codes
              </Button>
              <Button onClick={() => onOpenChange(false)}>I&apos;ve saved them</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Set up two-step verification</DialogTitle>
              <DialogDescription>
                Scan this with an authenticator app, then type the 6-digit code it shows to prove it worked.
              </DialogDescription>
            </DialogHeader>
            {enrolment ? (
              <div className="space-y-3">
                <div className="flex justify-center">
                  {/* A server-rendered data URL, so the secret never passes
                      through a third-party script and the CSP needs no image host. */}
                  <Image
                    src={enrolment.qrDataUrl}
                    alt={`QR code enrolling ${email} in two-step verification`}
                    width={200}
                    height={200}
                    unoptimized
                    className="rounded-field border border-border/60 bg-white p-2"
                  />
                </div>
                <p className="text-center text-caption text-muted-foreground">
                  No camera? Enter this key instead:
                  <br />
                  <span className="select-all font-mono text-foreground">{enrolment.secret}</span>
                </p>
                <Field
                  id="mfa-setup-code"
                  label="Code from your app"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  error={error}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>
            ) : (
              <p className="flex items-center gap-2 py-6 text-body text-muted-foreground">
                {error ?? (
                  <>
                    <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> Preparing your code…
                  </>
                )}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void confirm()} disabled={busy || !enrolment || code.trim().length < 6}>
                {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
                Turn on
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TwoStepDisableDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json()) as { ownerAdminLocked?: boolean } & ServerError;
      if (!res.ok) {
        setError(data.error ?? "That code isn’t right.");
        return;
      }
      onDone();
      onOpenChange(false);
      toast.success(
        data.ownerAdminLocked
          ? "Two-step verification is off. The Admin panel stays locked until you turn it back on."
          : "Two-step verification is off."
      );
    } catch {
      setError("Couldn’t reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Turn off two-step verification?</DialogTitle>
          <DialogDescription>
            Your password alone will be enough to sign in again. Confirm with a current code, or one of your unused
            recovery codes.
          </DialogDescription>
        </DialogHeader>
        <Field
          id="mfa-disable-code"
          label="Code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={error}
          placeholder="123456"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
        />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy || code.trim().length < 6}>
            {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------
// Password
// ----------------------------------------------------------------------------

const MIN_PASSWORD = 8;

function PasswordRow({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [errors, setErrors] = React.useState<{ currentPassword?: string; newPassword?: string }>({});
  const [busy, setBusy] = React.useState(false);
  const [resetSending, setResetSending] = React.useState(false);

  const sendReset = async () => {
    setResetSending(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn’t send the reset email.");
      toast.success(data.message ?? "A password-reset link is on its way.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t send the reset email.");
    } finally {
      setResetSending(false);
    }
  };

  const submit = async () => {
    const clientErrors: typeof errors = {};
    if (!current) clientErrors.currentPassword = "Enter your current password.";
    if (next.length < MIN_PASSWORD) clientErrors.newPassword = `Use at least ${MIN_PASSWORD} characters.`;
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await res.json()) as ServerError;
      if (!res.ok) {
        const message = data.error ?? "Couldn’t change your password.";
        setErrors(data.field === "newPassword" ? { newPassword: message } : { currentPassword: message });
        return;
      }
      // Every session was just invalidated, including this one, so there is
      // nowhere to go but the sign-in screen — which is the proof the change
      // took effect rather than a message claiming it did.
      toast.success("Password changed. Signing you back in…");
      await signOutToSignIn();
    } catch {
      setErrors({ currentPassword: "Couldn’t reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Password"
        description={
          hasPassword
            ? "Changing it signs out every other device."
            : "This account signs in with Google or Apple, so it has no password."
        }
        control={
          hasPassword ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
              <KeyRound className="size-3.5" />
              Change…
            </Button>
          ) : null
        }
      />
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (busy) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            setCurrent("");
            setNext("");
            setErrors({});
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
            <DialogDescription>
              Every other signed-in device is signed out when you do this, and so is this one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field
              id="current-password"
              type="password"
              label="Current password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              error={errors.currentPassword}
              autoComplete="current-password"
            />
            <Field
              id="new-password"
              type="password"
              label="New password"
              required
              minLength={MIN_PASSWORD}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              error={errors.newPassword}
              hint={`At least ${MIN_PASSWORD} characters.`}
              autoComplete="new-password"
            />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => void sendReset()} disabled={busy || resetSending}>
              {resetSending && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              Email me a reset link
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              Change password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ----------------------------------------------------------------------------
// Email address
// ----------------------------------------------------------------------------

function EmailRow({ currentEmail, hasPassword }: { currentEmail: string; hasPassword: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [address, setAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<{ email?: string; currentPassword?: string }>({});
  const [busy, setBusy] = React.useState(false);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  const submit = async () => {
    setErrors({});
    setBusy(true);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address.trim(), currentPassword: hasPassword ? password : undefined }),
      });
      const data = (await res.json()) as { message?: string } & ServerError;
      if (!res.ok) {
        const message = data.error ?? "Couldn’t start the change.";
        setErrors(data.field === "currentPassword" ? { currentPassword: message } : { email: message });
        return;
      }
      setSentTo(address.trim());
    } catch {
      setErrors({ email: "Couldn’t reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Email address"
        description="The address you sign in with. A link to the new address confirms the change."
        control={
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-caption text-muted-foreground">{currentEmail}</span>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
              <Mail className="size-3.5" />
              Change…
            </Button>
          </div>
        }
      />
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (busy) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            setAddress("");
            setPassword("");
            setErrors({});
            setSentTo(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change your email address</DialogTitle>
            <DialogDescription>
              {sentTo
                ? "Nothing has changed yet — open the link to finish."
                : "Your current address keeps working until the new one is confirmed."}
            </DialogDescription>
          </DialogHeader>
          {sentTo ? (
            <p className="text-body text-foreground">
              If <span className="font-medium">{sentTo}</span> isn&apos;t already in use here, a confirmation link is on
              its way to it. The link lasts 24 hours.
            </p>
          ) : (
            <div className="space-y-4">
              <Field
                id="new-email"
                type="email"
                label="New email address"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                error={errors.email}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
              />
              {hasPassword && (
                <Field
                  id="email-change-password"
                  type="password"
                  label="Current password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={errors.currentPassword}
                  hint="Your address is how you recover this account, so changing it needs your password."
                  autoComplete="current-password"
                />
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            {sentTo ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={busy || !address.trim()}>
                  {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
                  Send confirmation link
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ----------------------------------------------------------------------------
// Sign out everywhere
// ----------------------------------------------------------------------------

function SignOutEverywhereRow() {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const revoke = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/account/sessions/revoke", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ServerError;
        throw new Error(data.error ?? "Couldn’t sign the other devices out.");
      }
      await signOutToSignIn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t sign the other devices out.");
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Sign out everywhere"
        description="Ends every session on every device, including this one. Use it if you've lost a phone or laptop."
        control={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
            <LogOut className="size-3.5" />
            Sign out everywhere
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sign out of every device?</DialogTitle>
            <DialogDescription>
              Every browser, phone and native app signed in to this account is signed out immediately — this one
              included. Nothing else about the account changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void revoke()} disabled={busy}>
              {busy && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              Sign out everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
