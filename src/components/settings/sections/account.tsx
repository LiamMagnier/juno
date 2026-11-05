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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp } from "@/components/app/app-provider";
import { SaveStatus, useSaveStates } from "@/components/settings/save-status";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { AccountSecuritySection } from "@/components/auth/account-security";
import { UsernameRow } from "@/components/settings/sections/account-username";
import { IconSwap } from "@/components/ui/icon-swap";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { initialsFor } from "@/components/settings/format";


/**
 * Who you are to Juno, how you sign in, and how to leave.
 *
 * The profile says the email once. It used to appear three times on this one
 * section (the page header's lede, under the name, and beside the Change
 * button in Sign-in). "Change name" edits the name here, in a small dialog,
 * through the same write Personalization's field makes; it used to move the
 * reader to another section to do it. The usage dashboard that sat here moved
 * to Plan & usage, beside the budget it spends, and the notification switches
 * live once, in Notifications.
 */
export function AccountSection() {
  const router = useRouter();
  const { user, quota } = useApp();
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

  // The name, edited in place. The same PATCH Personalization's field sends:
  // a User column, server-rendered into the bootstrap, so a refresh is what
  // makes the sidebar and the greeting agree.
  const [nameOpen, setNameOpen] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState(user.name ?? "");
  const [savingName, setSavingName] = React.useState(false);
  const nameChanged = nameDraft.trim() !== (user.name ?? "");
  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = nameDraft.trim();
    if (!nameChanged || savingName) return;
    setSavingName(true);
    const ok = await saves.track("name", async () => {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      }).catch(() => null);
      if (!res?.ok) {
        toast.error("Couldn’t save your name.");
        return false;
      }
      router.refresh();
      return true;
    });
    setSavingName(false);
    if (ok) setNameOpen(false);
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
                  <AvatarFallback className="font-sans text-ui">{initialsFor(user.name, user.email)}</AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute inset-0 flex items-center justify-center rounded-full bg-foreground/60 text-background opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100",
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
              <Badge variant="secondary" className="font-sans" translate="no">
                {plan.name}
              </Badge>
              <SaveStatus state={saves.status("name")} />
            </div>
            <p className="truncate text-ui text-muted-foreground" translate="no">
              {email}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNameDraft(user.name ?? "");
              setNameOpen(true);
            }}
          >
            Change name
          </Button>
        </div>
        <UsernameRow user={user} />
      </SettingsGroup>

      {/* Two-step verification, password, email address and sessions live
          with the sign-in form in components/auth: the same flow, read
          together. */}
      <AccountSecuritySection email={email} />

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

      <Dialog open={nameOpen} onOpenChange={(next) => (savingName ? undefined : setNameOpen(next))}>
        <DialogContent className="max-w-md">
          <form onSubmit={(e) => void saveName(e)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Change your name</DialogTitle>
              <DialogDescription>{`What ${PRODUCT_NAME} calls you in greetings, and the name shown in the sidebar.`}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="account-name">Name</Label>
              <Input
                id="account-name"
                value={nameDraft}
                maxLength={80}
                placeholder="Your name"
                autoComplete="given-name"
                onChange={(e) => setNameDraft(e.target.value)}
                disabled={savingName}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setNameOpen(false)} disabled={savingName}>
                Cancel
              </Button>
              <Button type="submit" disabled={!nameChanged} loading={savingName}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next);
          if (!next) setConfirm("");
        }}
        busy={deleting}
        title="Delete this account?"
        description="Your account and everything in it are deleted: conversations, memories, files and your subscription. It happens at once, and nothing can be recovered."
        confirmLabel="Delete permanently"
        confirmDisabled={!match}
        onConfirm={() => void deleteAccount()}
      >
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
      </ConfirmDialog>
    </>
  );
}
