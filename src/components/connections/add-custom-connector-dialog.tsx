"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, KeyRound, ShieldCheck, SlidersHorizontal } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SkillDialogStep } from "@/components/skills/skill-dialog-shell";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import {
  beginCustomConnectorSignIn,
  createCustomConnector,
  CustomConnectorError,
  monogram,
  probeCustomConnector,
  type ProbeResponse,
} from "@/components/connections/custom-connector-api";
import { staggerDelay, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { useReducedMotion } from "@/lib/motion-preference";

type Ready = Extract<ProbeResponse, { ok: true }>;

/**
 * Add your own MCP server, in two steps that change height without jumping
 * (the skills import dialog's shell):
 *
 * 1. ADDRESS. Paste a URL. Juno checks it server-side (is there an MCP server,
 *    does it sign in with OAuth, can Juno register with it) and says why not
 *    in words when it can't, instead of saving something that will never work.
 * 2. READY. The server's monogram and name (editable), where you'll sign in,
 *    and what happens next. Continue saves it and leaves for the server's
 *    consent page; the callback lands back on Connections with the new tile
 *    flashed once.
 *
 * Nothing is saved until Continue. A server already added opens its sign-in
 * again instead of making a copy.
 */
export function AddCustomConnectorDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="surface-float max-w-lg gap-0 p-0 sm:p-0" aria-describedby={undefined}>
        {open ? <AddCustomConnectorFlow onSaved={() => { onSaved?.(); onOpenChange(false); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddCustomConnectorFlow({ onSaved }: { onSaved: () => void }) {
  // The ordinary dialog scrolls as credential fields expand, without a
  // layout transform translating fields outside the visible panel.
  const Step = StaticMcpStep;
  const [authMode, setAuthMode] = React.useState("sign_in");
  const [header, setHeader] = React.useState("");
  const fieldId = React.useId();
  const [address, setAddress] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState<Ready | null>(null);
  const [name, setName] = React.useState("");
  const [leaving, setLeaving] = React.useState(false);
  const inflight = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => inflight.current?.abort(), []);

  const check = async () => {
    const value = address.trim();
    if (!value || checking) return;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setChecking(true);
    setRefusal(null);
    try {
      if (authMode === "token") {
        const response = await fetch("/api/mcp/servers", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ name: name.trim(), url: value, authHeader: header.trim() || null }),
        });
        const body = await response.json();
        if (!response.ok || !body.server) throw new Error(body.error || "Could not save this server.");
        if (!controller.signal.aborted) onSaved();
        return;
      }
      const result = await probeCustomConnector(value, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setRefusal(result.message);
        return;
      }
      setReady(result);
      setName(result.existing?.name ?? result.suggestedName);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setRefusal(err instanceof Error ? err.message : `${PRODUCT_NAME} couldn't check that server. Try again.`);
    } finally {
      if (inflight.current === controller) setChecking(false);
    }
  };

  const signIn = async () => {
    if (!ready || leaving) return;
    setLeaving(true);
    setRefusal(null);
    try {
      const { connector } = await createCustomConnector(ready.url, name.trim() || ready.suggestedName);
      beginCustomConnectorSignIn(connector.id);
    } catch (err) {
      setLeaving(false);
      setRefusal(err instanceof CustomConnectorError ? err.message : "Couldn't add that server. Nothing was saved.");
    }
  };

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {ready === null ? (
        <Step key="address" className="shrink-0 p-5 sm:p-6">
          <div className="pr-10">
            <DialogTitle>Add an MCP server</DialogTitle>
            <DialogDescription className="mt-1 text-ui">
              {`Paste the server’s address. ${PRODUCT_NAME} checks it before anything is saved.`}
            </DialogDescription>
          </div>

          <fieldset className="mt-4" disabled={checking}>
            <legend className="mb-2 text-ui">How this server connects</legend>
            <RadioGroup aria-label="How this server connects" value={authMode} onValueChange={(value) => { setAuthMode(value); setRefusal(null); setHeader(""); }} className="flex flex-wrap gap-4">
              <Label className="flex items-center gap-2"><RadioGroupItem value="sign_in" />Sign in</Label>
              <Label className="flex items-center gap-2"><RadioGroupItem value="token" />Use a token or no sign-in</Label>
            </RadioGroup>
          </fieldset>

          {authMode === "token" ? (
            <div className="mt-4 flex flex-col gap-2">
              <Label htmlFor={`${fieldId}-name`}>Server name</Label>
              <Input id={`${fieldId}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={checking} />
              <Label htmlFor={`${fieldId}-token`}>Authorization header (optional)</Label>
              <Input id={`${fieldId}-token`} type="password" value={header} onChange={(e) => setHeader(e.target.value)} autoComplete="off" spellCheck={false} maxLength={4000} disabled={checking} placeholder="Bearer …" />
            </div>
          ) : null}

          <form
            className="mt-5 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void check();
            }}
          >
            <Input
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                if (refusal) setRefusal(null);
              }}
              placeholder="https://mcp.example.com/mcp"
              aria-label="Server address"
              inputMode="url"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={checking}
              className="h-10 flex-1 font-mono text-ui"
            />
            <Button type="submit" className="h-10 sm:w-28" disabled={!address.trim() || (authMode === "token" && !name.trim())} loading={checking}>
              {authMode === "token" ? "Save server" : "Check"}
            </Button>
          </form>

          {/* While a stranger's server answers, the line names what the wait is
              for. It stays still: the spinner in Check, the button just
              pressed, is the one thing moving. */}
          <div aria-live="polite" className="min-h-0">
            {checking ? (
              <p className="mt-3 truncate text-caption text-muted-foreground motion-safe:animate-fade-in">
                Looking for a server at {hostOf(address)}…
              </p>
            ) : refusal !== null ? (
              <WorkStateNote tone="error" className="mt-3 motion-safe:animate-rise-in">
                {refusal}
              </WorkStateNote>
            ) : null}
          </div>

          <p className="mt-5 text-caption leading-5 text-muted-foreground">
            {authMode === "token" ? "Tokens are stored encrypted. Leave the header blank only when the server needs no sign-in. Only add servers you trust." : `Servers sign in with OAuth, so ${PRODUCT_NAME} never sees your password. Only add servers you trust: their tools can read and act on whatever you connect them to.`}
          </p>
        </Step>
      ) : (
        <SkillDialogStep key="ready" className="p-5 sm:p-6">
          <ReadyStep
            ready={ready}
            name={name}
            onNameChange={setName}
            leaving={leaving}
            refusal={refusal}
            onBack={() => {
              setRefusal(null);
              setReady(null);
            }}
            onContinue={() => void signIn()}
          />
        </SkillDialogStep>
      )}
    </AnimatePresence>
  );
}

const StaticMcpStep = React.forwardRef<HTMLDivElement, { children: React.ReactNode; className?: string }>(function StaticMcpStep({ children, className }, ref) {
  return <div ref={ref} className={cn("flex flex-col", className)}>{children}</div>;
});

function ReadyStep({
  ready,
  name,
  onNameChange,
  leaving,
  refusal,
  onBack,
  onContinue,
}: {
  ready: Ready;
  name: string;
  onNameChange: (name: string) => void;
  leaving: boolean;
  refusal: string | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const facts = [
    {
      icon: KeyRound,
      text: (
        <>
          You’ll sign in on <span className="font-medium text-foreground">{ready.authHost}</span>{` and approve ${PRODUCT_NAME} there.`}
        </>
      ),
    },
    { icon: SlidersHorizontal, text: `Then choose which of its tools ${PRODUCT_NAME} may use.` },
    { icon: ShieldCheck, text: `${PRODUCT_NAME} asks before any tool that changes something, as it does for every app.` },
  ];

  return (
    <>
      <div className="pr-10">
        <DialogTitle>{ready.existing ? "Already added" : "Found it"}</DialogTitle>
        <DialogDescription className="mt-1 text-ui">
          {ready.existing
            ? "This server is already in your connections. Sign in again to reconnect it."
            : "An MCP server that signs in with OAuth. Name it the way you’ll look for it."}
        </DialogDescription>
      </div>

      <div className="surface-inset mt-5 flex items-center gap-3 rounded-card p-3">
        {/* The monogram lands with a small settle, the one moment in the
            flow that is about the server rather than the form. */}
        <motion.span
          initial={reduce ? false : { scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={transition.emphasis}
          className="surface-raised flex size-10 shrink-0 items-center justify-center rounded-field text-ui font-semibold text-foreground"
          aria-hidden="true"
        >
          {monogram(name || ready.suggestedName)}
        </motion.span>
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="custom-connector-name">
            Name
          </label>
          <Input
            id="custom-connector-name"
            value={name}
            onChange={(event) => onNameChange(event.target.value.slice(0, 60))}
            disabled={leaving || !!ready.existing}
            className="h-8 border-transparent bg-transparent px-1.5 text-ui font-medium shadow-none focus-visible:border-border"
          />
          <p className="truncate px-1.5 font-mono text-caption text-muted-foreground" translate="no">
            {ready.host}
          </p>
        </div>
      </div>

      <ul className="mt-4 space-y-2.5">
        {facts.map(({ icon: Icon, text }, index) => (
          <li
            key={index}
            className="flex items-start gap-2.5 text-caption leading-5 text-muted-foreground motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            style={staggerDelay(index + 1, "base")}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ul>

      {refusal !== null ? (
        <WorkStateNote tone="error" className="mt-4 motion-safe:animate-rise-in">
          {refusal}
        </WorkStateNote>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={leaving} className="gap-1.5 px-2.5">
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button onClick={onContinue} loading={leaving} disabled={!name.trim()} className={cn("min-w-40")}>
          {leaving ? "Opening sign-in…" : "Continue to sign in"}
        </Button>
      </div>
    </>
  );
}

function hostOf(value: string): string {
  const text = value.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).host || text;
  } catch {
    return text;
  }
}
