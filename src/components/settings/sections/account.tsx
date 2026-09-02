"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, KeyRound, Loader2, LogOut } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { requiresViewerCredentials } from "@/lib/image-source";
import { signOutToSignIn } from "@/lib/sign-out";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app/app-provider";
import { TileSaveStatus, type TileSaveState } from "@/components/settings/tile";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

function initials(name: string | null, email: string | null) {
  return (name || email || "U").slice(0, 2);
}

/**
 * Who you are to Juno: the portrait, the name, the address you sign in with —
 * then the ways in and out (password, this session), the emails Juno may
 * send, and, last and alone, deletion.
 */
export function AccountSection() {
  const router = useRouter();
  const { user, quota, settings, features } = useApp();
  const save = useSettingsSave();
  const plan = PLANS[quota.plan];
  const email = user.email ?? "";

  // Portrait upload — the same flow the profile page used to own.
  const [avatar, setAvatar] = React.useState<string | null>(user.image ?? null);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/profile/avatar", { method: "POST", body: form });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Upload failed.");
      setAvatar(d.url);
      toast.success("Profile picture updated.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update picture.");
    } finally {
      setUploading(false);
    }
  };

  // Name — saved on blur, with a voice.
  const [name, setName] = React.useState(user.name ?? "");
  const [nameState, setNameState] = React.useState<TileSaveState>("idle");
  const nameTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(nameTimer.current), []);
  const saveName = async () => {
    const value = name.trim();
    if (value === (user.name ?? "")) return;
    clearTimeout(nameTimer.current);
    setNameState("saving");
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: value }),
    });
    setNameState(res.ok ? "saved" : "failed");
    if (res.ok) {
      router.refresh();
      nameTimer.current = setTimeout(() => setNameState("idle"), 4000);
    }
  };

  // Password — there is no in-app change; the reset link is the one path, and
  // it is the same one the sign-in screen offers.
  const [resetSending, setResetSending] = React.useState(false);
  const sendReset = async () => {
    setResetSending(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not send the reset email.");
      toast.success(data.message ?? "A password-reset link is on its way.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the reset email.");
    } finally {
      setResetSending(false);
    }
  };

  // Deletion — guarded by typing the address, posting to the rate-limited route.
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const match = confirm.trim().toLowerCase() === email.toLowerCase() && email.length > 0;
  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail: confirm.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not delete the account.");
      }
      await signOutToSignIn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the account.");
      setDeleting(false);
    }
  };

  return (
    <>
      <SettingsGroup
        title="Profile"
        aside={
          <Button asChild variant="outline" size="sm">
            <Link href="/profile">View activity</Link>
          </Button>
        }
      >
        <div className="flex items-center gap-4 py-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="group relative shrink-0 rounded-full disabled:cursor-default"
            aria-label="Change profile picture"
          >
            <Avatar size="xl">
              {avatar && (
                <AvatarImage
                  src={avatar}
                  alt=""
                  {...(requiresViewerCredentials(avatar) ? { referrerPolicy: "no-referrer" } : {})}
                />
              )}
              <AvatarFallback className="text-body">{initials(user.name, user.email)}</AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "absolute inset-0 flex items-center justify-center rounded-full bg-foreground/60 text-background opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100",
                uploading && "opacity-100"
              )}
              aria-hidden="true"
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadAvatar(f);
              e.target.value = "";
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-semibold text-foreground">{user.name || "You"}</p>
              <Badge variant="secondary">{plan.name}</Badge>
            </div>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{email}</p>
          </div>
        </div>

        <SettingRow
          label="Name"
          htmlFor="account-name"
          description="Shown in the sidebar and on anything you share."
          control={
            <div className="flex items-center gap-2">
              <TileSaveStatus state={nameState} failedMessage="Couldn't save." />
              <Input
                id="account-name"
                value={name}
                maxLength={80}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void saveName()}
                className="w-56"
              />
            </div>
          }
        />
        <SettingRow
          label="Email"
          description="The address you sign in with. It cannot be changed here."
          control={<span className="font-mono text-caption text-muted-foreground">{email}</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="Sign-in" description="How you get into this account, and how you leave it.">
        <SettingRow
          label="Password"
          description="Juno emails you a link to set a new one."
          control={
            <Button variant="outline" size="sm" onClick={() => void sendReset()} disabled={resetSending} className="gap-1.5">
              {resetSending ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              Send reset link
            </Button>
          }
        />
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
      </SettingsGroup>

      <SettingsGroup title="Email notifications" description="What Juno may send to your inbox.">
        <SettingRow
          label="Budget alerts"
          htmlFor="email-budget"
          description="Email me at 80% of my monthly budget."
          control={
            <Switch
              id="email-budget"
              checked={settings.emailBudgetAlerts}
              onCheckedChange={(v) => void save({ emailBudgetAlerts: v })}
            />
          }
        />
        <SettingRow
          label="Weekly digest"
          htmlFor="email-digest"
          description="Usage recap every Monday."
          control={
            <Switch
              id="email-digest"
              checked={settings.emailWeeklyDigest}
              onCheckedChange={(v) => void save({ emailWeeklyDigest: v })}
            />
          }
        />
        {!features.email && (
          <p className="py-3 text-xs text-muted-foreground">
            Email delivery isn&apos;t configured yet — your preferences are saved and take effect once it is.
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup title="Danger zone" description="Irreversible. There is no undo and no grace period.">
        <SettingRow
          label="Delete account"
          tone="destructive"
          description="Chats, memories, files and your subscription — everything, immediately. Export first if you want a copy."
          control={
            <Button variant="destructive-outline" size="sm" className="gap-2" onClick={() => setDeleteOpen(true)}>
              <ActionIcons.delete className="size-4" /> Delete account…
            </Button>
          }
        />
      </SettingsGroup>

      <Dialog
        open={deleteOpen}
        onOpenChange={(next) => {
          if (deleting) return;
          setDeleteOpen(next);
          if (!next) setConfirm("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this account?</DialogTitle>
            <DialogDescription>
              This deletes your account and everything in it — conversations, memories, uploaded files, and your
              subscription. It takes effect immediately, and nothing can be recovered afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-email" className="text-muted-foreground">
              Type <span className="font-mono text-foreground">{email}</span> to confirm
            </Label>
            <Input
              id="delete-confirm-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              placeholder={email}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={deleting}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteOpen(false);
                setConfirm("");
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={!match || deleting} onClick={() => void deleteAccount()}>
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete permanently"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
