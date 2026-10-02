"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { KeyRound, Link2, Plug, Search } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { DialogCloseButton, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhaseOrb } from "@/components/effects/phase-orb";
import type { UserMcpServerStatus } from "@/components/connections/types";
import { ease, transition, duration } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Add (or edit) a user-registered remote MCP server: name, Streamable HTTP
 * URL, optional Authorization header. Test runs a real MCP handshake and lists
 * the tools it finds; Save persists the row.
 *
 * Motion: the panel is the skill-dialog-shell recipe with the DRAWER curve
 * (ease.drawer) rather than the modal spring, per
 * docs/design/PREMIUM_REWORK_PASS.md W1. Test uses PhaseOrb (a live status
 * orb), never a bare spinner.
 */

type TestState = "idle" | "testing" | "ok" | "error";

export function AddMcpServerDialog({
  open,
  onOpenChange,
  onSaved,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (server: UserMcpServerStatus) => void;
  /** Non-null when renaming / re-pointing an existing row. */
  editing?: UserMcpServerStatus | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [authHeader, setAuthHeader] = React.useState("");
  const [clearAuth, setClearAuth] = React.useState(false);
  const [testState, setTestState] = React.useState<TestState>("idle");
  const [testTools, setTestTools] = React.useState<string[]>([]);
  const [testError, setTestError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const isEdit = !!editing;

  React.useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setUrl(editing?.url ?? "");
    // Never prefill the secret. An edit keeps the stored header unless the
    // field is typed into; the placeholder says so.
    setAuthHeader("");
    setClearAuth(false);
    setTestState(editing?.status === "ok" ? "ok" : editing?.status === "error" ? "error" : "idle");
    setTestTools(editing?.tools ?? []);
    setTestError(editing?.lastError ?? null);
    setSaving(false);
    setSaveError(null);
  }, [open, editing]);

  const runTest = async () => {
    if (testState === "testing" || !url.trim()) return;
    setTestState("testing");
    setTestError(null);
    setTestTools([]);
    try {
      const endpoint = isEdit
        ? `/api/mcp/servers/${encodeURIComponent(editing!.id)}/test`
        : "/api/mcp/servers/test";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ...(clearAuth ? { authHeader: null } : authHeader.trim()
            ? { authHeader: authHeader.trim() } : isEdit ? {} : { authHeader: null }),
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        result?: { ok: boolean; toolNames?: string[]; error?: string };
        error?: string;
      };
      if (!r.ok) throw new Error(data.error ?? "Couldn’t test that server.");
      const result = data.result;
      if (!result) throw new Error("No test result came back.");
      if (result.ok) {
        setTestState("ok");
        setTestTools(result.toolNames ?? []);
      } else {
        setTestState("error");
        setTestError(result.error ?? "Could not reach that MCP server.");
      }
    } catch (err) {
      setTestState("error");
      setTestError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !name.trim() || !url.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(isEdit ? `/api/mcp/servers/${encodeURIComponent(editing!.id)}` : "/api/mcp/servers", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          // Omit when blank on edit so the stored header is kept; send null only
          // when the field is used to clear. Create always sends the field.
          ...(clearAuth ? { authHeader: null } : authHeader.trim()
            ? { authHeader: authHeader.trim() } : isEdit ? {} : { authHeader: null }),
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { server?: UserMcpServerStatus; error?: string };
      if (!r.ok || !data.server) throw new Error(data.error ?? "Couldn’t save that server.");
      onSaved(data.server);
      onOpenChange(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const canSave = name.trim().length > 0 && url.trim().length > 0 && !saving;
  const busy = testState === "testing" || saving;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content asChild>
          <motion.div
            initial={{ opacity: 0, y: reduce ? 0 : 12, scale: reduce ? 1 : 0.98 }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              transition: { duration: duration.base, ease: ease.drawer },
            }}
            exit={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.98, transition: transition.exit }}
            style={{ borderRadius: 20 }}
            className="surface-float fixed left-[50%] top-[50%] z-modal flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md flex-col overflow-hidden rounded-panel outline-none [translate:-50%_-50%]"
          >
            <div className="flex items-start gap-3 border-b border-border/60 p-5 pb-4">
              <span className="surface-inset flex size-10 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                <Plug className="size-5" />
              </span>
              <div className="min-w-0 flex-1 pr-8">
                <DialogPrimitive.Title className="text-heading">
                  {isEdit ? "Edit MCP server" : "Add MCP server"}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-ui text-muted-foreground">
                  {`Point ${PRODUCT_NAME} at a remote MCP server. ${PRODUCT_NAME} stores any Authorization header encrypted and never shows it again.`}
                </DialogPrimitive.Description>
              </div>
              <DialogCloseButton className="static shrink-0" />
            </div>

            <form onSubmit={save} className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5">
              <div className="grid gap-1.5">
                <Label htmlFor="user-mcp-name">Name</Label>
                <Input
                  id="user-mcp-name"
                  placeholder="Linear"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  maxLength={80}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="user-mcp-url">Server URL</Label>
                <Input
                  id="user-mcp-url"
                  type="url"
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    // A new URL is a new endpoint: the last test is no longer
                    // evidence about it.
                    if (testState !== "testing") setTestState("idle");
                    setTestError(null);
                    setTestTools([]);
                  }}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-caption text-muted-foreground">https anywhere, or http on localhost for development.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="user-mcp-auth">
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    Authorization header
                  </span>
                </Label>
                <Input
                  id="user-mcp-auth"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    isEdit && editing?.hasAuthHeader ? "Stored header kept unless you type" : "Bearer … (optional)"
                  }
                  value={authHeader}
                  onChange={(e) => {
                    setAuthHeader(e.target.value);
                    setClearAuth(false);
                    setTestState("idle");
                    setTestError(null);
                  }}
                  disabled={busy}
                />
                <p className="text-caption text-muted-foreground">
                  {isEdit && editing?.hasAuthHeader && !clearAuth
                    ? "Leave blank to keep the stored credential."
                    : "Leave blank for a server that needs no credential."}
                </p>
                {isEdit && editing?.hasAuthHeader && (
                  <Button type="button" variant="ghost" size="sm" className="justify-self-start" disabled={busy}
                    onClick={() => {
                      setClearAuth(!clearAuth);
                      setAuthHeader("");
                      setTestState("idle");
                      setTestError(null);
                    }}>
                    {clearAuth ? "Keep stored credential" : "Remove stored credential"}
                  </Button>
                )}
              </div>

              <div className="surface-inset rounded-field p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void runTest()}
                    disabled={busy || !url.trim()}
                  >
                    <Search className="size-3.5" />
                    Test connection
                  </Button>
                  <TestStatus state={testState} error={testError} />
                </div>
                {testState === "ok" && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    {testTools.length === 0 ? (
                      <p className="text-caption text-muted-foreground">Connected, but this server offers no tools.</p>
                    ) : (
                      <>
                        <p className="text-caption text-muted-foreground">
                          {testTools.length} {testTools.length === 1 ? "tool" : "tools"} found
                        </p>
                        <ul className="mt-1.5 flex flex-wrap gap-1.5">
                          {testTools.slice(0, 24).map((tool) => (
                            <li
                              key={tool}
                              className="rounded-control bg-muted px-2 py-0.5 font-mono text-micro text-foreground/80"
                            >
                              {tool}
                            </li>
                          ))}
                          {testTools.length > 24 && (
                            <li className="text-micro text-muted-foreground">+{testTools.length - 24} more</li>
                          )}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>

              {saveError && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-field border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui text-destructive motion-safe:animate-fade-in"
                >
                  <StatusIcons.error className="mt-0.5 size-4 shrink-0" />
                  {saveError}
                </p>
              )}

              <div className="mt-auto flex justify-end gap-2 border-t border-border/60 pt-4">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSave}>
                  <Link2 className="size-4" />
                  {saving ? "Saving…" : isEdit ? "Save changes" : "Add server"}
                </Button>
              </div>
            </form>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

/** Live status for the Test row: PhaseOrb while probing, words once settled. */
function TestStatus({ state, error }: { state: TestState; error: string | null }) {
  if (state === "idle") return null;
  if (state === "testing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground">
        <PhaseOrb state="connecting" />
        Connecting…
      </span>
    );
  }
  if (state === "ok") {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground motion-safe:animate-fade-in">
        <StatusIcons.success className="size-3.5 text-foreground" />
        Connected
      </span>
    );
  }
  return (
    <span
      role="alert"
      className={cn("inline-flex min-w-0 items-start gap-1.5 text-caption text-destructive motion-safe:animate-fade-in")}
    >
      <StatusIcons.error className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2">{error ?? "Could not reach that MCP server."}</span>
    </span>
  );
}
