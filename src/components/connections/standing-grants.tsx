"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

interface StandingGrant { id: string; connectorId: string; projectId: string | null; toolName: string; action: string; createdAt: string }

/** Real broker grants, with revocation visible on the row where it happened. */
export function StandingGrants() {
  const [grants, setGrants] = React.useState<StandingGrant[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/approvals/grants", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json() as { grants: StandingGrant[] };
      setGrants(data.grants);
    } catch { setError("Couldn’t load standing approvals. Retry to review them."); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const revoke = async (grant: StandingGrant) => {
    setBusy(grant.id); setError(null);
    try {
      const response = await fetch(`/api/approvals/grants/${encodeURIComponent(grant.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? null);
    } catch { setError("Couldn’t revoke this approval. It is still in effect; try again."); }
    finally { setBusy(null); }
  };
  return <section className="mt-10 border-t border-border pt-6" aria-labelledby="standing-approvals-title">
    <h2 id="standing-approvals-title" className="text-heading">Standing approvals</h2>
    <p className="mt-1 text-caption text-muted-foreground">Actions you chose to allow without asking. Your action approval policy can still require confirmation.</p>
    {error ? <p role="alert" className="mt-3 text-ui text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => void load()}>Retry</Button></p> : null}
    {grants === null && !error ? <p className="mt-4 text-ui text-muted-foreground" role="status">Loading approvals…</p> : grants?.length === 0 ? <p className="mt-4 text-ui text-muted-foreground">No standing approvals.</p> : <ul className="mt-3">{grants?.map((grant) => <li key={grant.id} className="flex items-center justify-between gap-4 border-b border-border py-4">
      <div className="min-w-0"><p className="break-words text-ui">{grant.action} in {grant.connectorId}</p><p className="mt-1 text-caption text-muted-foreground">{grant.projectId ? "This project" : "Your account"} · {grant.toolName}</p></div>
      <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void revoke(grant)}>{busy === grant.id ? "Revoking…" : "Revoke"}</Button>
    </li>)}</ul>}
  </section>;
}
