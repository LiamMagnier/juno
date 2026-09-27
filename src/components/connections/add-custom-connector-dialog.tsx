"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, KeyRound, ShieldCheck, SlidersHorizontal } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SkillDialogContent, SkillDialogStep } from "@/components/skills/skill-dialog-shell";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SkillDialogContent className="max-w-lg" aria-describedby={undefined}>
        {open ? <AddCustomConnectorFlow /> : null}
      </SkillDialogContent>
    </Dialog>
  );
}

function AddCustomConnectorFlow() {
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
      setRefusal(err instanceof CustomConnectorError ? err.message : "Juno couldn't check that server. Try again.");
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
        <SkillDialogStep key="address" className="p-5 sm:p-6">
          <div className="pr-10">
            <DialogTitle>Add an MCP server</DialogTitle>
            <DialogDescription className="mt-1 text-ui">
              Paste the server’s address. Juno checks it before anything is saved.
            </DialogDescription>
          </div>

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
            <Button type="submit" className="h-10 sm:w-28" disabled={!address.trim()} loading={checking}>
              Check
            </Button>
          </form>

          {/* One line of motion while a stranger's server answers: the address
              itself, shimmering, so the wait names what it is waiting on. */}
          <div aria-live="polite" className="min-h-0">
            {checking ? (
              <p className="mt-3 truncate text-caption text-muted-foreground motion-safe:animate-fade-in">
                <span className="shimmer-text">Looking for a server at {hostOf(address)}…</span>
              </p>
            ) : refusal !== null ? (
              <WorkStateNote tone="error" className="mt-3 motion-safe:animate-rise-in">
                {refusal}
              </WorkStateNote>
            ) : null}
          </div>

          <p className="mt-5 text-caption leading-5 text-muted-foreground">
            Servers sign in with OAuth, so Juno never sees your password. Only add servers you trust: their tools can
            read and act on whatever you connect them to.
          </p>
        </SkillDialogStep>
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
          You’ll sign in on <span className="font-medium text-foreground">{ready.authHost}</span> and approve Juno there.
        </>
      ),
    },
    { icon: SlidersHorizontal, text: "Then choose which of its tools Juno may use." },
    { icon: ShieldCheck, text: "Juno asks before any tool that changes something, as it does for every app." },
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
