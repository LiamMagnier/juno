"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Loader2 } from "@/components/ui/icons";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/components/app/app-provider";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { openSettings } from "@/components/settings/settings-sections";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { AccountSecuritySection } from "@/components/auth/account-security";
import { IconSwap } from "@/components/ui/icon-swap";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

function initials(name: string | null, email: string | null) {
  return (name || email || "U").slice(0, 2);
}

/**
 * Who you are to Juno, how you sign in, what it may email you, and how to
 * leave.
 *
 * The profile says the email once. It used to appear three times on this one
 * section (the page header's lede, under the name, and beside the Change
 * button in Sign-in). The name is shown, not edited: it is edited in one
 * place, Personalization, where it is what Juno calls you. The usage
 * dashboard that sat here moved to Plan & usage, beside the budget it spends.
 */
export function AccountSection() {
  const router = useRouter();
  const { user, quota, settings, features } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();
  const plan = PLANS[quota.plan];
  const email = user.email ?? "";

  // Portrait upload.
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
      toast.error(err instanceof Error ? err.message : "Couldn’t update the picture.");
    } finally {
      setUploading(false);
    }
  };

  // Deletion: guarded by typing the address, posting to the rate-limited route.
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
        throw new Error(data.error ?? "Couldn’t delete the account.");
      }
      await signOutToSignIn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t delete the account.");
      setDeleting(false);
    }
  };

  return (
    <>
      <SettingsGroup>
        <div className="flex items-center gap-4 py-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                // `.pressable`: the portrait is a control, not a surface, so
                // it dips under the finger like every other control does.
                className="pressable group relative shrink-0 rounded-full disabled:cursor-default motion-reduce:active:scale-100"
                aria-label="Change profile picture"
              >
                <Avatar size="lg" className="coarse:size-14">
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
                    "absolute inset-0 flex items-center justify-center rounded-full bg-scrim text-background opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100",
                    uploading && "opacity-100"
                  )}
                  aria-hidden="true"
                >
                  <IconSwap
                    swapped={uploading}
                    from={<Camera className="size-4" />}
                    to={<Loader2 className={cn("size-4", uploading && "motion-safe:animate-spin")} />}
                  />
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Change picture</TooltipContent>
          </Tooltip>
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
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-body font-semibold text-foreground">{user.name || "You"}</p>
              <Badge variant="secondary" translate="no">
                {plan.name}
              </Badge>
            </div>
            <p className="truncate text-ui text-muted-foreground" translate="no">
              {email}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openSettings("personalization")}>
            Change name
          </Button>
        </div>
      </SettingsGroup>

      {/* Two-step verification, password, email address and sessions live
          with the sign-in form in components/auth: the same flow, read
          together. */}
      <AccountSecuritySection email={email} />

      <SettingsGroup
        title="Email notifications"
        description={features.email ? undefined : "Email isn’t set up on this server yet. Your choices are kept for when it is."}
      >
        <SettingRow
          label="Budget alerts"
          htmlFor="email-budget"
          description="An email when you reach 80% of your monthly budget."
          status={saves.status("emailBudgetAlerts")}
          control={
            <Switch
              id="email-budget"
              checked={settings.emailBudgetAlerts}
              onCheckedChange={(emailBudgetAlerts) =>
                void saves.track("emailBudgetAlerts", () => save({ emailBudgetAlerts }))
              }
            />
          }
        />
        <SettingRow
          label="Weekly digest"
          htmlFor="email-digest"
          description="A recap of your usage every Monday."
          status={saves.status("emailWeeklyDigest")}
          control={
            <Switch
              id="email-digest"
              checked={settings.emailWeeklyDigest}
              onCheckedChange={(emailWeeklyDigest) =>
                void saves.track("emailWeeklyDigest", () => save({ emailWeeklyDigest }))
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup tone="destructive">
        <SettingRow
          label="Delete account"
          tone="destructive"
          description="Chats, memories, files and your subscription, all at once. Export first if you want a copy."
          control={
            <Button variant="destructive-outline" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete account
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
              Your account and everything in it are deleted: conversations, memories, files and your subscription.
              It happens at once, and nothing can be recovered.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm-email" className="text-muted-foreground">
              Type <span className="text-foreground" translate="no">{email}</span> to confirm
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
          <DialogFooter>
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
            <Button variant="destructive" disabled={!match} loading={deleting} onClick={() => void deleteAccount()}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
