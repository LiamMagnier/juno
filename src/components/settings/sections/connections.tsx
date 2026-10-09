"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow, SettingsGroup, SettingsInlineError } from "@/components/settings/setting-row";
import { useSettingsResource } from "@/components/settings/use-settings-resource";
import { BRAND } from "@/lib/brand/names";
import type { ByokProvider, ProviderKeyView } from "@/lib/code-v2/byok";

/**
 * Connections → API keys (Alevr Code v2 SPEC §2, BYOK).
 *
 * Minimal and functional: one row per lab, its state in words (never a
 * coloured pill or dot), and Add / Replace, Test and Remove. A key is checked
 * with the lab before it is stored, and the page never sees it again: only
 * its last four characters come back. The web lane restyles this pane.
 */
interface ProvidersBody {
  keys: ProviderKeyView[];
  providers: { id: ByokProvider; label: string; docsUrl: string }[];
  usage: { provider: ByokProvider; requests: number; inputTokens: number; outputTokens: number; estCostUsd: number }[];
}

function parse(body: unknown): ProvidersBody {
  const b = body as Partial<ProvidersBody> | null;
  if (!b || !Array.isArray(b.keys) || !Array.isArray(b.providers) || !Array.isArray(b.usage)) throw new Error("bad body");
  return b as ProvidersBody;
}

const URL = "/api/provider-keys";

function stateLine(key: ProviderKeyView | undefined, usage: ProvidersBody["usage"][number] | undefined): string {
  if (!key) return "Not connected.";
  if (key.status === "invalid") return `Refused by the provider${key.statusDetail ? ` (${key.statusDetail})` : ""}. Replace or re-test it.`;
  const parts = [`Key ending ${key.keyHint}`];
  if (usage && usage.requests > 0) {
    parts.push(`${usage.requests.toLocaleString()} requests in 30 days, about $${usage.estCostUsd.toFixed(2)} at list price`);
  }
  return parts.join(" · ");
}

function ProviderRow({
  provider,
  keyView,
  usage,
  onChanged,
}: {
  provider: ProvidersBody["providers"][number];
  keyView: ProviderKeyView | undefined;
  usage: ProvidersBody["usage"][number] | undefined;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState<null | "save" | "test" | "remove">(null);
  const [note, setNote] = React.useState<string | null>(null);
  const inputId = `byok-${provider.id}`;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setNote(null);
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, key: draft }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!res.ok) {
        setNote([body.error ?? "Couldn't save this key.", body.detail].filter(Boolean).join(" "));
        return;
      }
      setDraft("");
      setEditing(false);
      setNote("Saved. The provider accepted this key.");
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      const res = await fetch(`${URL}/${provider.id}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { result?: string; detail?: string | null; error?: string };
      if (!res.ok) setNote(body.error ?? "Couldn't test this key.");
      else if (body.result === "valid") setNote("The provider accepted this key.");
      else if (body.result === "invalid") setNote(`The provider refused this key. ${body.detail ?? ""}`.trim());
      else setNote(`Couldn't reach the provider. ${body.detail ?? ""}`.trim());
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setNote(null);
    try {
      const res = await fetch(`${URL}/${provider.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) setNote("Couldn't remove this key.");
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingRow
      label={provider.label}
      description={stateLine(keyView, usage)}
      control={
        <>
          {keyView && (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={test}>
              {busy === "test" ? "Testing…" : "Test"}
            </Button>
          )}
          {keyView && (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={remove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : keyView ? "Replace" : "Add key"}
          </Button>
        </>
      }
    >
      {editing && (
        <form onSubmit={save} className="flex flex-col gap-2 @[34rem]/pane:flex-row @[34rem]/pane:items-center">
          <label htmlFor={inputId} className="sr-only">
            {provider.label} API key
          </label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your API key"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" size="sm" disabled={busy !== null || draft.trim().length === 0}>
            {busy === "save" ? "Checking…" : "Save"}
          </Button>
        </form>
      )}
      {(editing || note) && (
        <p className="mt-2 text-ui text-muted-foreground" role="status">
          {note ?? (
            <>
              Make one in your{" "}
              <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {provider.label} console
              </a>
              . It is checked with the provider, then stored encrypted.
            </>
          )}
        </p>
      )}
    </SettingRow>
  );
}

export function ConnectionsSection() {
  const { data, error, reload } = useSettingsResource(URL, parse);
  if (!data) {
    return error ? <SettingsInlineError onRetry={reload}>Couldn&rsquo;t load your API keys.</SettingsInlineError> : null;
  }
  return (
    <SettingsGroup
      title="API keys"
      description={`${BRAND.code.label} runs on your own key whenever you have one for that provider. The provider bills you directly, and those runs don't count against your plan.`}
    >
      {data.providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          keyView={data.keys.find((k) => k.provider === provider.id)}
          usage={data.usage.find((u) => u.provider === provider.id)}
          onChanged={reload}
        />
      ))}
    </SettingsGroup>
  );
}
