"use client";

import * as React from "react";
import { toast } from "sonner";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyGlyph, Failure, Loading, formatShareDate, useCopied } from "@/components/share/share-dialog-parts";
import { parseShareEmails, SHARE_PEOPLE_LIMITS, type SharePersonView } from "@/lib/share-people-core";
import { cn } from "@/lib/utils";

/*
 * Share › Specific people (src/lib/share-people-core.ts).
 *
 * Opening it reads (GET /api/share/people) and creates nothing. Invite is the
 * one press that makes the share, and only if it has none yet; every address
 * after that joins the same share and snapshot. Each person has a Remove, and
 * Stop sharing revokes the whole share (DELETE /api/share/{id}, the same
 * tombstone as a link), after which nobody on the list can open it.
 *
 * What the owner sees of a person is what they typed: the address and when it
 * was added. Never whether it has an account, or has opened it — the server
 * does not know the first and does not keep the second.
 *
 * Addresses are checked here as they are on the server (the same parser), so
 * a typo is named under the field before anything is sent.
 */

export const SHARE_PEOPLE_COPY = {
  label: "Add people",
  placeholder: "Email addresses, separated by commas",
  hint: "They’ll get an email, and can open it only when signed in with that address.",
  invite: "Invite",
  listLabel: "People with access",
  you: "You",
  owner: "Owner",
  empty: "Only you can open it until you add someone.",
  remove: (email: string) => `Remove ${email}`,
  removed: (email: string) => `${email} no longer has access.`,
  invited: (count: number) => (count === 1 ? "Added 1 person. They’ll get an email." : `Added ${count} people. They’ll get an email.`),
  already: "Everyone you entered already has access.",
  invalid: (entries: string[]) =>
    entries.length === 1 ? `“${entries[0]}” isn’t an email address.` : `These aren’t email addresses: ${entries.join(", ")}.`,
  none: "Add an email address.",
  tooMany: `Add up to ${SHARE_PEOPLE_LIMITS.perRequest} people at a time.`,
  snapshot: (iso: string) => `Snapshot · ${formatShareDate(iso)}`,
  copyLink: "Copy link",
  copied: "Copied",
  stop: "Stop sharing",
  stopping: "Stopping…",
  stopped: "Sharing stopped. Nobody you added can open it now.",
  loadFailed: "Couldn’t load who has access. Please try again.",
  inviteFailed: "Couldn’t add them. Please try again.",
  removeFailed: "Couldn’t remove them. Please try again.",
  stopFailed: "Couldn’t stop sharing.",
} as const;

export interface PeopleShareInfo {
  id: string;
  url: string;
  snapshotAt: string;
}

type Target = { conversationId: string } | { artifactId: string };

function query(target: Target): string {
  return "conversationId" in target
    ? `conversationId=${encodeURIComponent(target.conversationId)}`
    : `artifactId=${encodeURIComponent(target.artifactId)}`;
}

/** One letter for the avatar: the address's first, which is all the owner gave. */
function initial(email: string): string {
  return (email.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
}

/** One row of the list: the owner's own, or a person with Remove. */
export function PersonRow({
  email,
  detail,
  onRemove,
  removing = false,
  fresh = false,
}: {
  email: string;
  detail: string;
  onRemove?: () => void;
  removing?: boolean;
  /** Just added in this sitting: it rises into place rather than appearing. */
  fresh?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center gap-3 py-1.5 transition-opacity duration-fast ease-out-soft",
        removing && "opacity-50",
        fresh && "motion-safe:animate-rise-in",
      )}
    >
      <Avatar size="sm" aria-hidden>
        <AvatarFallback>{initial(email)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground">{email}</p>
        <p className="truncate text-caption text-muted-foreground">{detail}</p>
      </div>
      {onRemove && (
        <IconButton
          variant="ghost"
          size="sm"
          label={SHARE_PEOPLE_COPY.remove(email)}
          onClick={onRemove}
          disabled={removing}
          aria-busy={removing || undefined}
          className="danger-hover"
        >
          <ActionIcons.dismiss className="size-4" aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

/** Who has access: the owner first, then each person, oldest first. */
export function PeopleList({
  people,
  removing,
  removed,
  fresh,
  onRemove,
}: {
  people: SharePersonView[];
  removing: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  fresh: ReadonlySet<string>;
  onRemove: (person: SharePersonView) => void;
}) {
  const shown = people.filter((p) => !removed.has(p.id));
  return (
    <section aria-labelledby="share-people-list" className="space-y-1">
      <h3 id="share-people-list" className="text-caption font-medium text-muted-foreground">
        {SHARE_PEOPLE_COPY.listLabel}
      </h3>
      <ul>
        <li>
          <PersonRow email={SHARE_PEOPLE_COPY.you} detail={SHARE_PEOPLE_COPY.owner} />
        </li>
        {people.map((person) => (
          <li key={person.id}>
            {/* The row folds away once the server has let them go, so the
                list closes over the gap instead of jumping. */}
            <Collapse open={!removed.has(person.id)}>
              <PersonRow
                email={person.email}
                detail={`Added ${formatShareDate(person.addedAt)}`}
                onRemove={() => onRemove(person)}
                removing={removing.has(person.id)}
                fresh={fresh.has(person.id)}
              />
            </Collapse>
          </li>
        ))}
      </ul>
      {shown.length === 0 && (
        <p className="text-caption text-muted-foreground" role="status">
          {SHARE_PEOPLE_COPY.empty}
        </p>
      )}
    </section>
  );
}

type Status = "loading" | "ready" | "error" | "blocked";

/** Specific people: read on open; Invite, Remove and Stop sharing are the only writes. */
export function SharePeoplePanel({ target, open }: { target: Target; open: boolean }) {
  const [status, setStatus] = React.useState<Status>("loading");
  const [share, setShare] = React.useState<PeopleShareInfo | null>(null);
  const [people, setPeople] = React.useState<SharePersonView[]>([]);
  const [draft, setDraft] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [stopped, setStopped] = React.useState(false);
  const [blockedReason, setBlockedReason] = React.useState("");
  const [removing, setRemoving] = React.useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(new Set());
  const [copied, copy] = useCopied();
  const targetQuery = query(target);

  const load = React.useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch(`/api/share/people?${targetQuery}`, { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { share: PeopleShareInfo | null; people: SharePersonView[] };
      setShare(data.share);
      setPeople(data.people);
      setRemoved(new Set());
      setFresh(new Set());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [targetQuery]);

  React.useEffect(() => {
    if (open) void load();
    else {
      setStatus("loading");
      setShare(null);
      setPeople([]);
      setDraft("");
      setFieldError(null);
      setStopped(false);
    }
  }, [open, load]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    const { emails, invalid } = parseShareEmails(draft);
    if (invalid.length) return setFieldError(SHARE_PEOPLE_COPY.invalid(invalid.slice(0, 3)));
    if (!emails.length) return setFieldError(SHARE_PEOPLE_COPY.none);
    if (emails.length > SHARE_PEOPLE_LIMITS.perRequest) return setFieldError(SHARE_PEOPLE_COPY.tooMany);
    setFieldError(null);
    setInviting(true);
    try {
      const res = await fetch("/api/share/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...("conversationId" in target ? { kind: "CHAT" } : { kind: "ARTIFACT" }), ...target, emails }),
      });
      const body = (await res.json().catch(() => null)) as
        | { share?: PeopleShareInfo; people?: SharePersonView[]; added?: number; error?: string; code?: string }
        | null;
      if (res.status === 403 && body?.code === "share_taken_down") {
        setBlockedReason(body.error ?? "This can’t be shared.");
        setStatus("blocked");
        return;
      }
      if (!res.ok || !body?.share || !body.people) {
        // The server's own sentence for a request it refused (an address,
        // too many, too many today); a fixed one for anything else.
        if (res.status === 400 || res.status === 429) setFieldError(body?.error ?? SHARE_PEOPLE_COPY.inviteFailed);
        else toast.error(SHARE_PEOPLE_COPY.inviteFailed);
        return;
      }
      const before = new Set(people.map((p) => p.id));
      setShare(body.share);
      setPeople(body.people);
      setFresh(new Set(body.people.filter((p) => !before.has(p.id)).map((p) => p.id)));
      setRemoved(new Set());
      setStopped(false);
      setDraft("");
      toast.success(body.added ? SHARE_PEOPLE_COPY.invited(body.added) : SHARE_PEOPLE_COPY.already);
    } catch {
      toast.error(SHARE_PEOPLE_COPY.inviteFailed);
    } finally {
      setInviting(false);
    }
  };

  const remove = async (person: SharePersonView) => {
    setRemoving((s) => new Set(s).add(person.id));
    try {
      const res = await fetch(`/api/share/people/${encodeURIComponent(person.id)}`, { method: "DELETE" });
      // Already gone is the outcome that was asked for.
      if (!res.ok && res.status !== 404) throw new Error("remove failed");
      setRemoved((s) => new Set(s).add(person.id));
      toast.success(SHARE_PEOPLE_COPY.removed(person.email));
    } catch {
      toast.error(SHARE_PEOPLE_COPY.removeFailed);
    } finally {
      setRemoving((s) => {
        const next = new Set(s);
        next.delete(person.id);
        return next;
      });
    }
  };

  const stop = async () => {
    if (!share) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(share.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("revoke failed");
      setShare(null);
      setPeople([]);
      setStopped(true);
      toast.success(SHARE_PEOPLE_COPY.stopped);
    } catch {
      toast.error(SHARE_PEOPLE_COPY.stopFailed);
    } finally {
      setStopping(false);
    }
  };

  if (status === "loading") return <Loading label="Checking who has access" />;
  if (status === "error") return <Failure message={SHARE_PEOPLE_COPY.loadFailed} onRetry={() => void load()} />;
  if (status === "blocked") return <Failure message={blockedReason} />;

  const fieldId = "share-people-emails";
  const describedBy = fieldError ? `${fieldId}-error` : `${fieldId}-hint`;

  return (
    <div className="space-y-4 motion-safe:animate-fade-in">
      <form onSubmit={(e) => void invite(e)} className="space-y-2" noValidate>
        <Label htmlFor={fieldId}>{SHARE_PEOPLE_COPY.label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={fieldId}
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={SHARE_PEOPLE_COPY.placeholder}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (fieldError) setFieldError(null);
            }}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={describedBy}
            className="aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:border-destructive"
          />
          <Button type="submit" loading={inviting} disabled={!draft.trim()} className="shrink-0">
            {SHARE_PEOPLE_COPY.invite}
          </Button>
        </div>
        {fieldError ? (
          <p id={`${fieldId}-error`} role="alert" className="flex items-center gap-1.5 text-caption text-destructive motion-safe:animate-rise-in">
            <StatusIcons.error className="size-3.5 shrink-0" aria-hidden />
            {fieldError}
          </p>
        ) : (
          <p id={`${fieldId}-hint`} className="text-caption text-muted-foreground">
            {stopped ? SHARE_PEOPLE_COPY.stopped : SHARE_PEOPLE_COPY.hint}
          </p>
        )}
      </form>

      <PeopleList people={people} removing={removing} removed={removed} fresh={fresh} onRemove={(p) => void remove(p)} />

      {share && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <p className="font-mono text-caption tabular-nums text-muted-foreground">{SHARE_PEOPLE_COPY.snapshot(share.snapshotAt)}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void copy(share.url)} disabled={stopping}>
              <CopyGlyph copied={copied} />
              <span aria-live="polite">{copied ? SHARE_PEOPLE_COPY.copied : SHARE_PEOPLE_COPY.copyLink}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void stop()}
              disabled={stopping}
              aria-busy={stopping}
              className="text-destructive danger-hover"
            >
              {stopping ? SHARE_PEOPLE_COPY.stopping : SHARE_PEOPLE_COPY.stop}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
