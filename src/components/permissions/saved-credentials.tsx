"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { PERMISSION_GRANT_LABEL } from "@/lib/permissions/taxonomy";
import { SECRET_REFUSAL_TEXT, type SecretRedemptionRefusal } from "@/lib/secrets/policy";

/**
 * Saved logins — Alevr Secrets in the Permissions page (BRIEF §7).
 *
 * Three things, in the order a person asks them: what is saved (never the
 * value), which tasks may use it right now (and a way to stop that), and every
 * time something used it or was refused. Hairline rows, no cards, no status
 * pills: the state is in the sentence. The access log is mono annotation text
 * because it is a record, not a dashboard.
 *
 * A task is granted a login here, from the login's own row, by choosing one of
 * the person's recent tasks. The grant lasts the task's working day at most and
 * a handful of uses; every fill still asks on the task itself.
 */

interface Credential {
  id: string;
  label: string;
  hosts: string[];
  hasUsername: boolean;
  version: number;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface Grant {
  id: string;
  credentialId: string;
  credentialLabel: string;
  taskKey: string;
  hosts: string[];
  scopes: string[];
  uses: number;
  maxUses: number;
  expiresAt: string;
  revokedAt: string | null;
  stale: boolean;
  createdAt: string;
}

interface AccessEvent {
  id: string;
  credentialLabel: string | null;
  taskKey: string | null;
  host: string | null;
  scope: string | null;
  outcome: string;
  reason: string | null;
  createdAt: string;
}

interface TaskOption {
  id: string;
  title: string;
}

export interface SavedCredentialsData {
  credentials: Credential[];
  grants: Grant[];
  events: AccessEvent[];
}

const OUTCOME_WORD: Record<string, string> = {
  granted: "filled",
  refused: "refused",
  created: "saved",
  rotated: "replaced",
  revoked: "removed",
  grant_created: "granted to a task",
  grant_revoked: "taken back from a task",
};

function when(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [size, unit] of units) if (abs >= size) return rtf.format(Math.round(ms / size), unit);
  return ms >= 0 ? "in under a minute" : "just now";
}

function grantState(grant: Grant): { active: boolean; line: string } {
  if (grant.revokedAt) return { active: false, line: `Taken back ${when(grant.revokedAt)}` };
  if (grant.stale) return { active: false, line: "The login changed after this was granted, so it no longer works" };
  if (new Date(grant.expiresAt).getTime() <= Date.now()) return { active: false, line: `Lapsed ${when(grant.expiresAt)}` };
  if (grant.uses >= grant.maxUses) return { active: false, line: `Used all ${grant.maxUses} fills` };
  return { active: true, line: `${grant.uses} of ${grant.maxUses} fills used · ends ${when(grant.expiresAt)}` };
}

function taskName(taskKey: string | null, tasks: TaskOption[]): string {
  if (!taskKey) return "—";
  const id = taskKey.startsWith("work:") ? taskKey.slice(5) : taskKey;
  return tasks.find((task) => task.id === id)?.title ?? "a task";
}

async function requestJson(url: string, init?: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, body };
}

export function SavedCredentials() {
  const [data, setData] = React.useState<SavedCredentialsData | null>(null);
  const [tasks, setTasks] = React.useState<TaskOption[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(async () => {
    const [secrets, sessions] = await Promise.all([
      requestJson("/api/secrets"),
      requestJson("/api/work/sessions?limit=20"),
    ]);
    if (!secrets.ok) {
      setError("Couldn’t load your saved logins. Nothing has changed; try again.");
      return;
    }
    setError(null);
    setData(secrets.body as unknown as SavedCredentialsData);
    const list = Array.isArray(sessions.body.sessions) ? (sessions.body.sessions as TaskOption[]) : [];
    setTasks(list.map((task) => ({ id: task.id, title: task.title })));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, run: () => Promise<{ ok: boolean; body: Record<string, unknown> }>, failure: string) => {
    setBusy(key);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(typeof result.body.error === "string" ? result.body.error : failure);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const activeGrants = (data?.grants ?? []).filter((grant) => grantState(grant).active);
  const pastGrants = (data?.grants ?? []).filter((grant) => !grantState(grant).active).slice(0, 10);

  return (
    <section className="mt-10" aria-labelledby="saved-logins-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="saved-logins-title" className="text-heading">
            Saved logins
          </h2>
          <p className="mt-1 max-w-prose text-ui text-muted-foreground">
            {`A task can sign in with a login you saved here without ${PRODUCT_NAME}’s model ever seeing it. You choose which task may use which login, only on its own sites, and you are asked before every fill.`}
          </p>
        </div>
        {!adding && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Save a login
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-ui text-muted-foreground">
          {error}
        </p>
      )}

      {adding && (
        <AddCredentialForm
          busy={busy === "add"}
          onCancel={() => setAdding(false)}
          onSave={async (input) => {
            await act(
              "add",
              () => requestJson("/api/secrets", { method: "POST", body: JSON.stringify(input) }),
              "Couldn’t save that login.",
            );
            setAdding(false);
          }}
        />
      )}

      {data === null && !error ? (
        <p className="mt-4 text-ui text-muted-foreground" role="status">
          Loading…
        </p>
      ) : data && data.credentials.length === 0 && !adding ? (
        <p className="mt-4 text-ui text-muted-foreground">
          {`No saved logins. When a task needs one, it asks you to take over and sign in yourself.`}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {data?.credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              tasks={tasks}
              busy={busy}
              onGrant={(workSessionId) =>
                act(
                  `grant:${credential.id}`,
                  () =>
                    requestJson("/api/secrets/grants", {
                      method: "POST",
                      body: JSON.stringify({ credentialId: credential.id, workSessionId }),
                    }),
                  "Couldn’t grant that login to the task.",
                )
              }
              onRotate={(secret) =>
                act(
                  `rotate:${credential.id}`,
                  () => requestJson(`/api/secrets/${encodeURIComponent(credential.id)}`, { method: "PATCH", body: JSON.stringify({ secret }) }),
                  "Couldn’t replace the password.",
                )
              }
              onRemove={() =>
                act(
                  `remove:${credential.id}`,
                  () => requestJson(`/api/secrets/${encodeURIComponent(credential.id)}`, { method: "DELETE" }),
                  "Couldn’t remove that login.",
                )
              }
            />
          ))}
        </ul>
      )}

      {data && (activeGrants.length > 0 || pastGrants.length > 0) && (
        <div className="mt-8">
          <h3 className="text-ui font-medium text-foreground">Tasks allowed to use a login</h3>
          <p className="mt-1 max-w-prose text-caption text-muted-foreground">
            {`Each is “${PERMISSION_GRANT_LABEL.allow_for_task}” for one login on its own sites. Every fill still asks first.`}
          </p>
          <ul className="mt-2 flex flex-col">
            {[...activeGrants, ...pastGrants].map((grant) => {
              const state = grantState(grant);
              return (
                <li key={grant.id} className="flex min-h-[52px] items-center justify-between gap-4 py-2 [&+&]:shadow-[0_-1px_0_hsl(var(--border))]">
                  <div className="min-w-0">
                    <p className={state.active ? "break-words text-ui text-foreground" : "break-words text-ui text-muted-foreground"}>
                      {grant.credentialLabel} — {taskName(grant.taskKey, tasks)}
                    </p>
                    <p className="mt-0.5 font-mono text-caption text-muted-foreground">
                      {grant.hosts.join(", ")} · {state.line}
                    </p>
                  </div>
                  {state.active && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      loading={busy === `revoke:${grant.id}`}
                      onClick={() =>
                        void act(
                          `revoke:${grant.id}`,
                          () => requestJson(`/api/secrets/grants/${encodeURIComponent(grant.id)}`, { method: "DELETE" }),
                          "Couldn’t take that back. The task can still use it; try again.",
                        )
                      }
                    >
                      Take back
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {data && data.events.length > 0 && (
        <div className="mt-8">
          <h3 className="text-ui font-medium text-foreground">Every use</h3>
          <p className="mt-1 max-w-prose text-caption text-muted-foreground">
            Each fill, refusal and change, newest first. Values are never recorded.
          </p>
          <ol className="mt-2 flex flex-col">
            {data.events.slice(0, 40).map((event) => (
              <li key={event.id} className="py-1.5 font-mono text-caption text-muted-foreground [&+&]:shadow-[0_-1px_0_hsl(var(--border))]">
                <span className="text-foreground">{event.credentialLabel ?? "A login"}</span>{" "}
                {OUTCOME_WORD[event.outcome] ?? event.outcome}
                {event.host ? ` on ${event.host}` : ""}
                {event.taskKey ? ` for ${taskName(event.taskKey, tasks)}` : ""}
                {event.reason && event.reason in SECRET_REFUSAL_TEXT
                  ? ` — ${SECRET_REFUSAL_TEXT[event.reason as SecretRedemptionRefusal].replace(/\.$/, "")}`
                  : ""}{" "}
                · <time dateTime={event.createdAt}>{when(event.createdAt)}</time>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CredentialRow({
  credential,
  tasks,
  busy,
  onGrant,
  onRotate,
  onRemove,
}: {
  credential: Credential;
  tasks: TaskOption[];
  busy: string | null;
  onGrant: (workSessionId: string) => Promise<void>;
  onRotate: (secret: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [mode, setMode] = React.useState<"idle" | "grant" | "rotate" | "remove">("idle");
  const [task, setTask] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const disabled = busy !== null;
  const meta = [
    credential.hosts.join(", "),
    credential.hasUsername ? "username and password" : "password only",
    credential.lastUsedAt ? `last filled ${when(credential.lastUsedAt)}` : "never filled",
  ].join(" · ");

  return (
    <li className="py-3 [&+&]:shadow-[0_-1px_0_hsl(var(--border))]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-ui font-medium text-foreground">{credential.label}</p>
          <p className="mt-0.5 font-mono text-caption text-muted-foreground">{meta}</p>
        </div>
        {mode === "idle" && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={disabled || tasks.length === 0} onClick={() => setMode("grant")}>
              Let a task use it
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setMode("rotate")}>
              Replace password
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setMode("remove")}>
              Remove
            </Button>
          </div>
        )}
      </div>

      {mode === "grant" && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!task) return;
            void onGrant(task).then(() => setMode("idle"));
          }}
        >
          <label className="sr-only" htmlFor={`grant-task-${credential.id}`}>
            Task
          </label>
          <select
            id={`grant-task-${credential.id}`}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            className="h-9 min-w-0 flex-1 rounded-field border border-foreground/[0.14] bg-foreground/[0.025] px-3 text-ui text-foreground dark:border-white/[0.12] dark:bg-white/[0.03]"
          >
            <option value="">Choose a task…</option>
            {tasks.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={!task || disabled} loading={busy === `grant:${credential.id}`}>
            {PERMISSION_GRANT_LABEL.allow_for_task}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </form>
      )}

      {mode === "rotate" && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secret) return;
            void onRotate(secret).then(() => {
              setSecret("");
              setMode("idle");
            });
          }}
        >
          <label className="sr-only" htmlFor={`rotate-${credential.id}`}>
            New password
          </label>
          <Input
            id={`rotate-${credential.id}`}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="New password"
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={!secret || disabled} loading={busy === `rotate:${credential.id}`}>
            Replace
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setMode("idle")}>
            Cancel
          </Button>
          <p className="basis-full text-caption text-muted-foreground">
            Tasks granted the old password stop working and have to be granted again.
          </p>
        </form>
      )}

      {mode === "remove" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-ui text-muted-foreground">
            Remove this login? Every task allowed to use it loses access now.
          </p>
          <Button variant="destructive" size="sm" disabled={disabled} loading={busy === `remove:${credential.id}`} onClick={() => void onRemove()}>
            Remove
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("idle")}>
            Keep it
          </Button>
        </div>
      )}
    </li>
  );
}

function AddCredentialForm({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (input: { label: string; hosts: string[]; username: string; secret: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [hosts, setHosts] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const ready = label.trim() && hosts.trim() && secret;
  return (
    <form
      className="mt-4 grid gap-3 border-y border-border py-4 sm:grid-cols-2"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void onSave({
          label: label.trim(),
          hosts: hosts.split(/[\s,]+/).filter(Boolean),
          username: username.trim(),
          secret,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        Name
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="GitHub — work" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        Sites it may be used on
        <Input value={hosts} onChange={(event) => setHosts(event.target.value)} placeholder="github.com, *.github.com" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        Username (optional)
        <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        Password or token
        <Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" />
      </label>
      <p className="text-caption text-muted-foreground sm:col-span-2">
        {`Sealed to your account before it is stored. ${PRODUCT_NAME} shows it to no one — not you, not the model — and fills it only into a password field on these sites.`}
      </p>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={!ready || busy} loading={busy}>
          Save login
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
