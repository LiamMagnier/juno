"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings/setting-row";
import { checkUsername, derivedHandle, USERNAME_MAX } from "@/lib/username";
import { cn } from "@/lib/utils";

/** How long typing must pause before the name is checked. */
const CHECK_DEBOUNCE_MS = 350;

/** The query a link adds to land on this row with the field open (the profile's Edit). */
export const USERNAME_FOCUS_PARAM = "username";

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "current" }
  | { state: "taken"; message: string }
  | { state: "invalid"; message: string }
  | { state: "error"; message: string };

/**
 * Settings › Account › Username: the @handle on the profile.
 *
 * At rest the row reads like every other: the handle, and one button. Change
 * opens the field in the row itself (no dialog: it is one short value), with
 * the "@" drawn inside the field so what you type is exactly what follows it.
 * Typing is checked after a short pause: the rules first, in the browser,
 * then whether anyone has it (GET /api/account/username?check=). The answer
 * is one quiet line of text under the field, never a pill or a dot:
 * Available, Taken, or what the rules say about it. Enter saves when the
 * name is available; Esc puts the field away.
 *
 * Until a name is chosen the profile shows one derived from the email, and
 * the row says so, so "Choose" is an invitation rather than a gap.
 */
export function UsernameRow({
  user,
}: {
  user: { username?: string | null; name: string | null; email: string | null };
}) {
  const router = useRouter();
  const [username, setUsername] = React.useState<string | null>(user.username ?? null);
  React.useEffect(() => setUsername(user.username ?? null), [user.username]);
  const fallback = derivedHandle(user);

  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [check, setCheck] = React.useState<Check>({ state: "idle" });
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const changeRef = React.useRef<HTMLButtonElement>(null);
  const fieldId = "account-username";
  const messageId = "account-username-status";

  const open = React.useCallback(() => {
    setValue(username ?? "");
    setCheck(username ? { state: "current" } : { state: "idle" });
    setEditing(true);
  }, [username]);

  const close = React.useCallback(() => {
    setEditing(false);
    setCheck({ state: "idle" });
    // Focus goes back to the button that opened the field, not to the page.
    requestAnimationFrame(() => changeRef.current?.focus());
  }, []);

  // Open with focus when a link asked for this row (`?focus=username`, the
  // profile's Edit), then drop the parameter so a later visit opens at rest.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("focus") !== USERNAME_FOCUS_PARAM) return;
    open();
    rowRef.current?.scrollIntoView({ block: "center" });
    params.delete("focus");
    const query = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Live feedback, debounced: the rules in the browser, then the server.
  React.useEffect(() => {
    if (!editing) return;
    const typed = value.trim();
    if (!typed) {
      setCheck({ state: "idle" });
      return;
    }
    const local = checkUsername(typed);
    if (local.ok && local.username === username) {
      setCheck({ state: "current" });
      return;
    }
    setCheck({ state: "checking" });
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!local.ok) {
        setCheck({ state: "invalid", message: local.message });
        return;
      }
      try {
        const res = await fetch(`/api/account/username?check=${encodeURIComponent(local.username)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = (await res.json().catch(() => ({}))) as {
          available?: boolean;
          problem?: string;
          message?: string;
          error?: string;
        };
        if (!res.ok) {
          setCheck({ state: "error", message: body.error ?? "Couldn’t check that name." });
        } else if (body.available) {
          setCheck({ state: "available" });
        } else if (body.problem === "taken") {
          setCheck({ state: "taken", message: body.message ?? "That username is taken." });
        } else {
          setCheck({ state: "invalid", message: body.message ?? "That name isn’t allowed." });
        }
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") setCheck({ state: "error", message: "Couldn’t check that name." });
      }
    }, CHECK_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editing, value, username]);

  // Esc closes the field, and only the field: caught on the window in the
  // capture phase, ahead of the settings modal's and page's own Esc.
  React.useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement !== inputRef.current || saving) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, saving, close]);

  const canSave = check.state === "available" && !saving;

  const save = async () => {
    if (!canSave) return;
    const local = checkUsername(value);
    if (!local.ok) return;
    setSaving(true);
    try {
      const res = await fetch("/api/account/username", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: local.username }),
      });
      const body = (await res.json().catch(() => ({}))) as { username?: string; error?: string; problem?: string };
      if (!res.ok) {
        if (body.problem === "taken") setCheck({ state: "taken", message: body.error ?? "That username is taken." });
        else if (res.status === 400) setCheck({ state: "invalid", message: body.error ?? "That name isn’t allowed." });
        else toast.error(body.error ?? "Couldn’t change your username.");
        return;
      }
      const next = body.username ?? local.username;
      setUsername(next);
      setEditing(false);
      setCheck({ state: "idle" });
      toast.success(`Your username is now @${next}.`);
      requestAnimationFrame(() => changeRef.current?.focus());
      router.refresh();
    } catch {
      toast.error("Couldn’t change your username.");
    } finally {
      setSaving(false);
    }
  };

  const message = statusText(check);
  const invalid = check.state === "taken" || check.state === "invalid";

  return (
    <div ref={rowRef} id="username" className="scroll-mt-24">
      <SettingRow
        label="Username"
        htmlFor={editing ? fieldId : undefined}
        description={
          username ? (
            <span translate="no">@{username}</span>
          ) : (
            <>
              Not chosen yet. Your profile shows <span translate="no">@{fallback}</span>.
            </>
          )
        }
        control={
          editing ? null : (
            <Button
              ref={changeRef}
              variant="outline"
              size="sm"
              onClick={open}
              aria-label={username ? "Change username" : "Choose a username"}
            >
              {username ? "Change" : "Choose"}
            </Button>
          )
        }
      >
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-56">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-ui text-muted-foreground"
                >
                  @
                </span>
                <input
                  ref={inputRef}
                  id={fieldId}
                  name="username"
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/^@+/, "").toLowerCase())}
                  maxLength={USERNAME_MAX + 1}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  translate="no"
                  disabled={saving}
                  aria-invalid={invalid || undefined}
                  aria-describedby={messageId}
                  placeholder={fallback}
                  className={cn(
                    "flex h-9 w-full rounded-field border border-foreground/[0.14] bg-foreground/[0.025] py-1 pl-7 pr-3.5 text-ui text-foreground shadow-none dark:border-white/[0.12] dark:bg-white/[0.03]",
                    "transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft motion-reduce:transition-none",
                    "placeholder:text-muted-foreground/70 hover:border-foreground/25 focus-visible:bg-background",
                    "focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_hsl(var(--primary)/0.16)] focus-visible:outline-none",
                    "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(var(--destructive)/0.16)]",
                    "disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11"
                  )}
                />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Button type="button" variant="ghost" onClick={close} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSave} loading={saving}>
                  Save
                </Button>
              </div>
            </div>
            <p
              id={messageId}
              role="status"
              aria-live="polite"
              className={cn(
                "min-h-[1.25rem] text-caption transition-colors duration-fast",
                invalid || check.state === "error" ? "text-destructive-ink" : "text-muted-foreground"
              )}
            >
              {message}
            </p>
          </form>
        ) : null}
      </SettingRow>
    </div>
  );
}

function statusText(check: Check): string {
  switch (check.state) {
    case "idle":
      return "Letters, numbers, dots, underscores and hyphens.";
    case "checking":
      return "Checking…";
    case "available":
      return "Available";
    case "current":
      return "This is your username.";
    case "taken":
      return check.message;
    case "invalid":
      return `Not allowed. ${check.message}`;
    case "error":
      return check.message;
  }
}
