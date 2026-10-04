"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/components/memory/memory-time";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Procedural memory on the Memory page: methods the person's own runs
 * repeated, proposed as skills. Set like the summary and the list — a margin
 * column that names the block, a reading column of hairline-separated items —
 * and absent entirely when there is nothing to propose.
 *
 * A proposal is a question, not a change: nothing happens until the person
 * makes it a skill (it opens in Skills, auto-selection off, to edit) or says
 * it is not one (it is never proposed again).
 */

export interface SkillCandidateView {
  id: string;
  title: string;
  examples: string[];
  tools: string[];
  runCount: number;
  lastSeenAt: string;
}

export interface SkillCandidateTransport {
  load: () => Promise<SkillCandidateView[]>;
  decide: (id: string, action: "accept" | "dismiss") => Promise<{ ok: true; href?: string } | { ok: false; message: string }>;
}

export const fetchSkillCandidateTransport: SkillCandidateTransport = {
  load: async () => {
    const res = await fetch("/api/memory/skill-candidates");
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as { candidates?: SkillCandidateView[] };
    return Array.isArray(data.candidates) ? data.candidates : [];
  },
  decide: async (id, action) => {
    const res = await fetch(`/api/memory/skill-candidates/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = (await res.json().catch(() => ({}))) as { href?: string; error?: string };
    return res.ok ? { ok: true, href: data.href } : { ok: false, message: data.error ?? "That didn’t work. Try again." };
  },
};

export function SkillCandidates({ transport = fetchSkillCandidateTransport }: { transport?: SkillCandidateTransport }) {
  const [candidates, setCandidates] = React.useState<SkillCandidateView[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [made, setMade] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let live = true;
    void transport.load().then((list) => {
      if (live) setCandidates(list);
    });
    return () => {
      live = false;
    };
  }, [transport]);

  if (candidates.length === 0) return null;

  const decide = async (candidate: SkillCandidateView, action: "accept" | "dismiss") => {
    setBusy(candidate.id);
    const outcome = await transport.decide(candidate.id, action);
    setBusy(null);
    if (!outcome.ok) {
      toast.error(outcome.message);
      return;
    }
    if (action === "accept" && outcome.href) setMade((current) => ({ ...current, [candidate.id]: outcome.href! }));
    else setCandidates((current) => current.filter((c) => c.id !== candidate.id));
  };

  return (
    <section aria-labelledby="memory-methods-heading" className="@container/methods mt-16" data-memory-methods="">
      <div className="grid gap-x-14 gap-y-5 @[50rem]/methods:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 id="memory-methods-heading" className="mem-h2 text-foreground">
            Methods you repeat
          </h2>
          <p className="mem-annot mt-2">{`From your own runs. A skill is how ${PRODUCT_NAME} does something; memory stays what it knows.`}</p>
        </div>
        <ul className="min-w-0 divide-y divide-[var(--mem-hair)]">
          {candidates.map((candidate) => {
            const href = made[candidate.id];
            return (
              <li key={candidate.id} className="py-4 first:pt-0">
                <p className="text-body font-medium text-foreground" translate="no">
                  {candidate.title}
                </p>
                <p className="mem-annot mt-1">
                  <span>{`${candidate.runCount} runs`}</span> <span aria-hidden="true">·</span>{" "}
                  <span>last {relativeTime(candidate.lastSeenAt)}</span> <span aria-hidden="true">·</span>{" "}
                  <span>{candidate.tools.join(", ")}</span>
                </p>
                {candidate.examples.length > 0 && (
                  <ul className="mt-2 space-y-1 text-ui text-muted-foreground">
                    {candidate.examples.map((example, i) => (
                      <li key={i} className="line-clamp-2">
                        “{example}”
                      </li>
                    ))}
                  </ul>
                )}
                <div className="-ml-2.5 mt-3 flex flex-wrap gap-1">
                  {href ? (
                    <Button asChild variant="ghost" size="sm" className="px-2.5">
                      <Link href={href}>Open the new skill</Link>
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2.5"
                        loading={busy === candidate.id}
                        onClick={() => void decide(candidate, "accept")}
                      >
                        Make it a skill
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2.5 text-muted-foreground"
                        disabled={busy === candidate.id}
                        onClick={() => void decide(candidate, "dismiss")}
                      >
                        Not a skill
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
