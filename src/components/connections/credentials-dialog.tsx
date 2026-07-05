"use client";

import * as React from "react";
import { AlertCircle, ExternalLink, KeyRound, Music2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectorStatus } from "@/components/connections/server-card";

/*
 * Connect dialog for credentials-kind connectors. Apple Calendar/Mail take an
 * Apple ID + app-specific password (posted to /credentials, validated live);
 * Apple Music loads MusicKit JS, runs the Apple consent popup, and posts the
 * resulting Music-User-Token. Raw credentials go straight to our server —
 * they're stored encrypted and never handed to the model.
 */

const MUSICKIT_SRC = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";

interface MusicKitInstance {
  authorize(): Promise<string>;
}

interface MusicKitGlobal {
  configure(config: { developerToken: string; app: { name: string; build: string } }): Promise<MusicKitInstance>;
  getInstance(): MusicKitInstance;
}

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

function loadMusicKit(): Promise<MusicKitGlobal> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${MUSICKIT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    const settle = () => {
      if (window.MusicKit) resolve(window.MusicKit);
      else reject(new Error("MusicKit failed to initialize."));
    };
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", () => reject(new Error("Couldn’t load MusicKit from Apple’s CDN.")), { once: true });
    if (!existing) {
      script.src = MUSICKIT_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.MusicKit) {
      settle();
    }
  });
}

function HelpSteps() {
  return (
    <div className="rounded-2xl border border-border/50 bg-muted/20 p-3.5 text-caption text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" />
        Juno signs in with an app-specific password — never your main Apple ID password.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-4">
        <li>
          Open{" "}
          <a
            href="https://account.apple.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-foreground/85 underline decoration-border underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground"
          >
            account.apple.com
            <ExternalLink className="size-3" />
          </a>
        </li>
        <li>Go to Sign-In &amp; Security → App-Specific Passwords (requires two-factor authentication)</li>
        <li>Generate one named “Juno” and paste it below</li>
      </ol>
    </div>
  );
}

export function CredentialsDialog({
  connector,
  onOpenChange,
  onConnected,
}: {
  connector: ConnectorStatus | null;
  onOpenChange: (open: boolean) => void;
  onConnected: (connector: ConnectorStatus, accountLabel: string | null) => void;
}) {
  const [appleId, setAppleId] = React.useState("");
  const [appPassword, setAppPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isMusic = connector?.id === "apple-music";

  React.useEffect(() => {
    setAppleId("");
    setAppPassword("");
    setError(null);
    setBusy(false);
  }, [connector?.id]);

  const postCredentials = async (target: ConnectorStatus, body: object) => {
    const r = await fetch(`/api/connectors/${target.id}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as { message?: string; accountLabel?: string };
    if (!r.ok) throw new Error(data.message ?? "Apple didn’t accept those credentials.");
    return data.accountLabel ?? null;
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connector || busy) return;
    setBusy(true);
    setError(null);
    try {
      const accountLabel = await postCredentials(connector, { appleId: appleId.trim(), appPassword: appPassword.trim() });
      onConnected(connector, accountLabel ?? appleId.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const authorizeMusic = async () => {
    if (!connector || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/connectors/apple-music/dev-token");
      const data = (await r.json().catch(() => ({}))) as { token?: string; message?: string };
      if (!r.ok || !data.token) throw new Error(data.message ?? "Apple Music isn’t set up on this server yet.");
      const musicKit = await loadMusicKit();
      const instance = await musicKit.configure({ developerToken: data.token, app: { name: "Juno", build: "1.0" } });
      const musicUserToken = await instance.authorize();
      if (!musicUserToken) throw new Error("Apple Music sign-in was cancelled.");
      const accountLabel = await postCredentials(connector, { musicUserToken });
      onConnected(connector, accountLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!connector} onOpenChange={(open) => !open && !busy && onOpenChange(open)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {connector?.label}</DialogTitle>
          <DialogDescription>
            {isMusic
              ? "Sign in with Apple to let Juno work with your Apple Music library. Apple hands back a music user token — Juno stores it encrypted and never sees your password."
              : `Juno connects to ${connector?.label ?? "iCloud"} over iCloud with an app-specific password, stored encrypted on the server.`}
          </DialogDescription>
        </DialogHeader>

        {isMusic ? (
          <>
            {error && (
              <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button className="gap-1.5" onClick={authorizeMusic} disabled={busy}>
                <Music2 className="h-3.5 w-3.5" /> {busy ? "Waiting for Apple…" : "Sign in with Apple Music"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submitPassword} className="grid gap-4">
            <HelpSteps />
            <div className="grid gap-1.5">
              <Label htmlFor="credentials-apple-id">Apple ID</Label>
              <Input
                id="credentials-apple-id"
                type="email"
                autoComplete="username"
                placeholder="you@icloud.com"
                value={appleId}
                onChange={(e) => setAppleId(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="credentials-app-password">App-specific password</Label>
              <Input
                id="credentials-app-password"
                type="password"
                autoComplete="off"
                placeholder="xxxx-xxxx-xxxx-xxxx"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            {error && (
              <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !appleId.trim() || !appPassword.trim()}>
                {busy ? "Verifying…" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
