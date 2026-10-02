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
    } catch { setError("Couldn’t load what runs without asking."); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  const revoke = async (grant: StandingGrant) => {
    setBusy(grant.id); setError(null);
    try {
      const response = await fetch(`/api/approvals/grants/${encodeURIComponent(grant.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? null);
    } catch { setError("Couldn’t change that. It still runs without asking; try again."); }
    finally { setBusy(null); }
  };
  // Silent when there is nothing to list: each app's details say "Every change asks first".
  if (grants !== null && grants.length === 0 && !error) return null;
  return <section className="mt-10" aria-labelledby="standing-approvals-title">
    <h2 id="standing-approvals-title" className="text-ui font-medium text-muted-foreground">Allowed without asking</h2>
    <p className="mt-1 max-w-prose text-ui text-muted-foreground">Changes you chose to let run without asking. Set one back to Ask first at any time.</p>
    {error ? <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-ui text-muted-foreground">{error} <Button variant="secondary" size="sm" onClick={() => void load()}>Try again</Button></p> : null}
    {grants === null && !error ? <p className="mt-4 text-ui text-muted-foreground" role="status">Loading…</p> : <ul className="mt-2 flex flex-col">{grants?.map((grant) => <li key={grant.id} className="flex min-h-[56px] items-center justify-between gap-4 py-2 [&+&]:shadow-[0_-1px_0_hsl(var(--border))]">
      <div className="min-w-0"><p className="break-words text-ui text-foreground">{grant.action}</p><p className="mt-0.5 text-caption text-muted-foreground">{grant.connectorId}, {grant.projectId ? "in one project" : "everywhere"}</p></div>
      <Button variant="secondary" size="sm" disabled={busy !== null} loading={busy === grant.id} onClick={() => void revoke(grant)}>Ask first</Button>
    </li>)}</ul>}
  </section>;
}
