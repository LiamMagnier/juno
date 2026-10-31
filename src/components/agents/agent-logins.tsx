"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound } from "@/components/ui/icons";
import {
  deleteAgentCredential,
  fetchAgentCredentials,
  saveAgentCredential,
  type SaveAgentCredentialInput,
} from "@/components/agents/agents-transport";
import type { ClientAgentCredential } from "@/lib/computer/vault-policy";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Saved logins in the agent's profile (docs/design/agents-v2/VAULT.md): what
 * is saved, by name and site, never a value, and a way to add or remove one.
 * Rendered only while saved logins are on for this server and the agent has
 * a computer; the route says which by answering `credentials: null`.
 *
 * Hairline rows, no cards, no status pills: the state is in the sentence.
 */

const LOGINS_COPY = {
  title: "Saved logins",
  intro: "It can sign in to these sites on its computer without the model ever seeing the password. You are asked the first time each one is used.",
  empty: "No saved logins.",
  add: "Add login",
  save: "Save login",
  cancel: "Cancel",
  remove: "Remove",
  name: "Name",
  site: "Site",
  sitePlaceholder: "https://github.com",
  username: "Username",
  password: "Password",
  totp: "Two-step setup key (optional)",
  sealed: `Sealed before it is stored. ${PRODUCT_NAME} shows it to no one, not you and not the model, and types it only on exactly this site.`,
  loadFailed: "Couldn’t load the saved logins.",
  approvedLine: "Approved",
  notApprovedLine: "Asks before its first use",
  withCodesLine: "with two-step codes",
  usedLine: "Last used",
} as const;

/** "Oct 30", in the reader's own calendar. */
function usedOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AgentLogins({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [logins, setLogins] = React.useState<ClientAgentCredential[] | null | undefined>(undefined);
  const [failed, setFailed] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const outcome = await fetchAgentCredentials(agentId);
    if (outcome.kind === "ok") {
      setFailed(false);
      setLogins(outcome.value);
    } else {
      setFailed(true);
    }
  }, [agentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Off on this server: nothing to show, and nothing hidden behind a control.
  if (logins === null) return null;
  if (logins === undefined && !failed) return null;

  const save = async (input: SaveAgentCredentialInput) => {
    setBusy("add");
    const outcome = await saveAgentCredential(agentId, input);
    setBusy(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That didn’t work. Try again.");
      return;
    }
    setAdding(false);
    await load();
  };

  const remove = async (login: ClientAgentCredential) => {
    setBusy(login.id);
    const outcome = await deleteAgentCredential(agentId, login.id);
    setBusy(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That didn’t work. Try again.");
      return;
    }
    await load();
  };

  return (
    <section aria-labelledby={`logins-${agentId}`}>
      <h3 id={`logins-${agentId}`} className="mb-3 text-ui font-medium text-muted-foreground">
        {LOGINS_COPY.title}
      </h3>
      <p className="text-ui text-muted-foreground">{LOGINS_COPY.intro}</p>
      {failed && !logins ? (
        <p role="alert" className="mt-3 text-ui text-muted-foreground">
          {LOGINS_COPY.loadFailed}
        </p>
      ) : null}
      {logins && logins.length === 0 && !adding ? <p className="mt-3 text-ui text-muted-foreground">{LOGINS_COPY.empty}</p> : null}
      {logins && logins.length > 0 ? (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {logins.map((login) => (
            <li key={login.id} className="group flex items-center gap-3 py-2">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-foreground" translate="no">
                  {login.label}
                </span>
                <span className="block truncate text-ui text-muted-foreground">
                  <span translate="no">{login.origin}</span>
                  {login.hasTotp ? <> {LOGINS_COPY.withCodesLine}</> : null}
                  {" · "}
                  {login.lastUsedAt ? (
                    <>
                      {LOGINS_COPY.usedLine} {usedOn(login.lastUsedAt)}
                    </>
                  ) : login.approved
                      ? LOGINS_COPY.approvedLine
                      : LOGINS_COPY.notApprovedLine}
                </span>
              </span>
              <button
                type="button"
                disabled={busy === login.id}
                aria-label={`Remove ${login.label} from ${agentName}’s saved logins`}
                onClick={() => void remove(login)}
                className="text-ui text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
              >
                {LOGINS_COPY.remove}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <AddLoginForm busy={busy === "add"} onCancel={() => setAdding(false)} onSave={save} />
      ) : logins ? (
        <Button type="button" size="sm" variant="outline" className="mt-3 rounded-full" onClick={() => setAdding(true)}>
          {LOGINS_COPY.add}
        </Button>
      ) : null}
    </section>
  );
}

function AddLoginForm({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (input: SaveAgentCredentialInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [origin, setOrigin] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [totpSecret, setTotpSecret] = React.useState("");
  const ready = Boolean(label.trim() && origin.trim() && username.trim() && password);
  return (
    <form
      className="mt-3 grid gap-3 border-y border-border py-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        void onSave({
          label: label.trim(),
          origin: origin.trim(),
          username: username.trim(),
          password,
          ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}),
        });
      }}
    >
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {LOGINS_COPY.name}
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="GitHub" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {LOGINS_COPY.site}
        <Input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder={LOGINS_COPY.sitePlaceholder} inputMode="url" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {LOGINS_COPY.username}
        <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {LOGINS_COPY.password}
        <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {LOGINS_COPY.totp}
        <Input type="password" value={totpSecret} onChange={(event) => setTotpSecret(event.target.value)} autoComplete="off" />
      </label>
      <p className="text-caption text-muted-foreground">{LOGINS_COPY.sealed}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ready || busy} loading={busy}>
          {LOGINS_COPY.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {LOGINS_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}
