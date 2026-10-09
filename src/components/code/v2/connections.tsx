"use client";

/**
 * Connections (DESIGN §5.13; INTERACTION I-19): the subscriptions the user's
 * Mac reports through the env server (Claude, ChatGPT/Codex, Gemini CLI,
 * Grok, DeepSeek Harness, OpenCode, Antigravity behind its flag), the user's
 * own API keys, and the Alevr plan. States are sentences, never badges.
 * Install and Sign in open the in-app terminal with the vendor's command
 * typed, not run. Health checks never start a login or a session.
 *
 * Used in Settings › Connections and as the first-run sheet in /code.
 */
import * as React from "react";
import Link from "next/link";
import { BYOK_PROVIDER_VALUES, type ByokProvider, type ProviderInstance } from "@/lib/code-v2/contracts";
import { BYOK_LABELS, ByokError, looksLikeKey, maskKey, type ByokClient, type ByokKeyRecord } from "@/lib/code-v2/byok-client";
import {
  ACP_RUNTIMES,
  CONNECTION_ACTION_LABELS,
  connectionAction,
  connectionSentence,
  displayName,
  isExpired,
  isInstanceVisible,
  isSubscriptionKind,
  type FeatureFlags,
} from "@/lib/code-v2/providers-view";
import { formatReset } from "@/lib/code-v2/tier-view";
import { Glyph, InstanceMark, Spinner } from "./primitives";
import type { DeviceInfo } from "./types";
import { cn } from "@/lib/utils";

export interface ConnectionsProps {
  instances: readonly ProviderInstance[];
  device?: DeviceInfo | null;
  flags?: FeatureFlags;
  byok?: ByokClient;
  /** Initial keys (gallery / server-rendered). */
  keys?: ByokKeyRecord[];
  /** "Plus plan", spend this month, cap. */
  alevrPlan?: { name: string; spentUsd?: number; capUsd?: number };
  /** Runs `provider.probe`; resolves with the fresh instance. */
  onProbe?: (instanceId: string) => Promise<ProviderInstance | void>;
  /** Opens the in-app terminal with the vendor's install / login command typed in. */
  /** Resolves with a sentence to show under the row ("typed into a terminal on …"). */
  onSetup?: (instance: ProviderInstance, action: "install" | "login") => Promise<void | string> | void | string;
  onDisconnect?: (instanceId: string) => void;
  /** First-run sheet: a close button and no outer page padding. */
  sheet?: boolean;
  /** Inside Settings: no page title or padding (the pane has its own). */
  embedded?: boolean;
  /** Show the API keys group (Settings keeps its own, with usage). Default true. */
  showKeys?: boolean;
  onClose?: () => void;
}

/** What a held runtime's row says instead of a status or an action. */
const HELD_SENTENCE = "Not available yet. It turns on once Google confirms other apps may run it with your sign-in.";

/** Subscriptions shown before a device reports anything (all rows disabled). */
const PLACEHOLDER_SUBSCRIPTIONS: ProviderInstance[] = [
  { id: "claude-agent:default", kind: "claude-agent", label: "Claude", status: "unknown" },
  { id: "codex:default", kind: "codex", label: "Codex", status: "unknown" },
  { id: "acp:gemini", kind: "acp", label: "Gemini CLI", status: "unknown", acpCommand: ["gemini", "--experimental-acp"] },
  { id: "acp:grok", kind: "acp", label: "Grok", status: "unknown", acpCommand: ["grok"] },
  { id: "acp:dsh", kind: "acp", label: "DeepSeek Harness", status: "unknown", acpCommand: ["dsh"] },
  { id: "acp:opencode", kind: "acp", label: "OpenCode", status: "unknown", acpCommand: ["opencode"] },
  { id: "acp:antigravity", kind: "acp", label: "Antigravity", status: "unknown", acpCommand: ["antigravity"] },
];

function ago(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

function Meter({ label, pct, resetsAt }: { label: string; pct?: number; resetsAt?: string }) {
  return (
    <span className="cv2-meter">
      <span>{label}</span>
      {pct !== undefined && <i style={{ ["--p" as string]: String(Math.min(1, pct / 100)) }} aria-hidden />}
      {pct !== undefined && <span>{Math.round(pct)}%</span>}
      {resetsAt && <span>resets {formatReset(resetsAt)}</span>}
    </span>
  );
}

function SubscriptionRow({
  instance,
  disabled,
  held = false,
  onProbe,
  onSetup,
  onDisconnect,
}: {
  instance: ProviderInstance;
  disabled: boolean;
  /** Listed but not offered yet (a runtime waiting on its vendor-terms check). */
  held?: boolean;
  onProbe?: ConnectionsProps["onProbe"];
  onSetup?: ConnectionsProps["onSetup"];
  onDisconnect?: ConnectionsProps["onDisconnect"];
}) {
  const [busy, setBusy] = React.useState<null | "probe" | "setup">(null);
  const [menu, setMenu] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [setupLine, setSetupLine] = React.useState<string | null>(null);
  const action = connectionAction(instance);
  const expired = isExpired(instance);
  const key = instance.kind === "acp" ? Object.keys(ACP_RUNTIMES).find((k) => instance.acpCommand?.[0]?.endsWith(k) || instance.id.endsWith(k)) : null;
  const note = key === "gemini" ? ACP_RUNTIMES.gemini.note : undefined;
  const probe = async () => {
    setBusy("probe");
    setError(null);
    try {
      await onProbe?.(instance.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach your Mac.");
    } finally {
      setBusy(null);
    }
  };
  const setup = async (a: "install" | "login") => {
    setBusy("setup");
    setError(null);
    try {
      const said = await onSetup?.(instance, a);
      if (typeof said === "string") setSetupLine(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open a terminal on your Mac.");
    } finally {
      setBusy(null);
    }
  };
  const sentence = held
    ? HELD_SENTENCE
    : disabled
      ? "Connect your Mac to check this."
      : connectionSentence(instance);
  return (
    <div className="cv2-li" aria-disabled={disabled || undefined}>
      <span className="cv2-tile">
        <InstanceMark instance={instance} size={18} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="nm">{displayName(instance)}</div>
        <div className={cn("ds", expired && "cv2-sig")} data-checking={busy === "probe"} key={sentence}>
          {expired && !/expired/i.test(sentence) ? "Sign-in expired. " : ""}
          {sentence}
          {note && !sentence.includes(note) ? ` ${note}` : ""}
        </div>
        {!disabled && !held && instance.limits?.length ? (
          <div className="ds2">
            {instance.limits.map((w) => (
              <Meter key={w.id} label={w.label} pct={w.usedPct} resetsAt={w.resetsAt} />
            ))}
          </div>
        ) : null}
        {error && <div className="ds cv2-del">{error}</div>}
        {setupLine && <div className="ds">{setupLine}</div>}
        {!disabled && !held && instance.checkedAt && <div className="ds" style={{ fontSize: 12 }}>Checked {ago(instance.checkedAt)}.</div>}
      </div>
      <div style={{ position: "relative" }}>
        {held ? null : disabled ? (
          <button type="button" className="cv2-btn" disabled>
            {CONNECTION_ACTION_LABELS[action === "manage" ? "re-check" : action]}
          </button>
        ) : action === "install" || action === "sign-in" || action === "sign-in-again" ? (
          <button type="button" className={cn("cv2-btn", expired && "ink")} onClick={() => setup(action === "install" ? "install" : "login")} disabled={busy !== null}>
            {busy === "setup" ? <Spinner size={14} /> : <Glyph name={action === "install" ? "download" : "terminal"} size={14} />}
            {CONNECTION_ACTION_LABELS[action]}
          </button>
        ) : action === "re-check" ? (
          <button type="button" className="cv2-btn" onClick={probe} disabled={busy !== null}>
            {busy === "probe" ? <Spinner size={14} /> : <Glyph name="refresh" size={14} />}
            Re-check
          </button>
        ) : (
          <>
            <button type="button" className="cv2-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              Manage <Glyph name="chevron-down" size={12} />
            </button>
            {menu && (
              <div className="cv2-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" onClick={() => (setMenu(false), void probe())}>
                  <Glyph name="refresh" size={14} /> Re-check
                </button>
                <button type="button" role="menuitem" onClick={() => (setMenu(false), void setup("login"))}>
                  <Glyph name="person-add" size={14} /> Sign in to another account
                </button>
                {onDisconnect && (
                  <button type="button" role="menuitem" onClick={() => (setMenu(false), onDisconnect(instance.id))}>
                    <Glyph name="disconnect" size={14} /> Disconnect
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function KeyRow({
  provider,
  record,
  client,
  onChange,
  onRemoved,
}: {
  provider: ByokProvider;
  record?: ByokKeyRecord;
  client?: ByokClient;
  onChange: (r: ByokKeyRecord | null) => void;
  onRemoved: (r: ByokKeyRecord) => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState<null | "save" | "test" | "remove">(null);
  const [error, setError] = React.useState<string | null>(null);
  const label = BYOK_LABELS[provider];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setBusy("save");
    setError(null);
    try {
      const r = await client.add(provider, value);
      onChange(r);
      setAdding(false);
      setValue("");
    } catch (err) {
      setError(err instanceof ByokError ? err.message : "That key did not work.");
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    if (!client) return;
    setBusy("test");
    setError(null);
    try {
      const r = await client.test(provider);
      if (r.key) onChange(r.key);
      if (!r.valid) setError(r.detail ?? "The lab refused this key.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not test the key.");
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!client || !record) return;
    setBusy("remove");
    try {
      await client.remove(provider);
      onRemoved(record);
      onChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the key.");
    } finally {
      setBusy(null);
    }
  };
  const sentence = record
    ? record.invalid
      ? `Refused by ${label}${record.detail ? ` (${record.detail})` : ""}. Replace or re-test it.`
      : `${record.hint}, added ${new Date(record.addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${record.lastUsedAt ? `, last used ${ago(record.lastUsedAt)}` : ", not used yet"}.`
    : "No key.";
  return (
    <div className="cv2-li">
      <span className="cv2-tile">
        <Glyph name="key" />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="nm">{label}</div>
        <div className={cn("ds", record?.invalid && "cv2-sig")} data-checking={busy === "test"}>
          {sentence}
        </div>
        {adding && (
          <form className="cv2-keyfield" onSubmit={save}>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={`Paste your ${label} key`}
              aria-label={`${label} API key`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="button" className="cv2-btn ghost" onClick={() => (setAdding(false), setValue(""), setError(null))}>
              Cancel
            </button>
            <button type="submit" className="cv2-btn ink" disabled={!value.trim() || busy !== null}>
              {busy === "save" ? <Spinner size={14} /> : null}
              Test and save
            </button>
          </form>
        )}
        {adding && value.trim() && !looksLikeKey(provider, value) && <div className="ds">That does not look like a {label} key ({maskKey(value)}). Alevr will still test it.</div>}
        {error && <div className="ds cv2-del">{error}</div>}
      </div>
      <div className="cv2-row" style={{ gap: 6 }}>
        {record && !adding && (
          <>
            <button type="button" className="cv2-btn ghost" onClick={remove} disabled={busy !== null}>
              Remove
            </button>
            <button type="button" className="cv2-btn" onClick={test} disabled={busy !== null}>
              {busy === "test" && <Spinner size={14} />}
              Re-test
            </button>
          </>
        )}
        {!record && !adding && (
          <button type="button" className="cv2-btn" onClick={() => setAdding(true)} disabled={!client}>
            Add key
          </button>
        )}
      </div>
    </div>
  );
}

export function ConnectionsPanel(props: ConnectionsProps) {
  const { instances, device, flags, byok } = props;
  const [keys, setKeys] = React.useState<ByokKeyRecord[]>(props.keys ?? []);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [undo, setUndo] = React.useState<ByokKeyRecord | null>(null);
  React.useEffect(() => {
    if (!byok || props.keys || props.showKeys === false) return;
    let live = true;
    byok
      .list()
      .then((k) => live && setKeys(k))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : "Could not load your keys."));
    return () => {
      live = false;
    };
  }, [byok, props.keys, props.showKeys]);
  React.useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  const online = !!device?.online;
  const reported = instances.filter((i) => isSubscriptionKind(i.kind));
  const listed = online && reported.length ? reported : PLACEHOLDER_SUBSCRIPTIONS;
  const subs = listed.filter((i) => isInstanceVisible(i, flags));
  // Runtimes behind a terms check (Antigravity) are listed, honestly, rather than missing.
  const held = PLACEHOLDER_SUBSCRIPTIONS.filter((p) => !isInstanceVisible(p, flags)).map((p) => listed.find((i) => i.id === p.id) ?? p);
  const setKey = (provider: ByokProvider, r: ByokKeyRecord | null) => setKeys((ks) => [...ks.filter((k) => k.provider !== provider), ...(r ? [r] : [])]);

  const content = (
    <div className="inner">
      <div className="cv2-row" style={{ gap: 12, alignItems: "flex-start", display: props.embedded ? "none" : undefined }}>
        <div className="cv2-grow">
          <h1 className="cv2-h1">Connections</h1>
          <p className="cv2-lede">Use the plans you already pay for. Alevr starts each vendor&apos;s own agent on your Mac, so your sign-in, billing and limits stay with the vendor.</p>
        </div>
        {props.sheet && props.onClose && (
          <button type="button" className="cv2-iconbtn" aria-label="Close" onClick={props.onClose}>
            <Glyph name="close" />
          </button>
        )}
      </div>
      <div className="cv2-device">
        <Glyph name="laptop" />
        {device ? (
          online ? (
            <span>
              On the web, these run through {device.name}
              {device.lastSeenAt ? `, seen ${ago(device.lastSeenAt)}` : ""}.
            </span>
          ) : (
            <span>
              {device.name} is offline{device.lastSeenAt ? `, last seen ${ago(device.lastSeenAt)}` : ""}. Open Alevr on it to use your subscriptions.
            </span>
          )
        ) : (
          <>
            <span className="cv2-grow">Subscriptions run on your Mac. Open Alevr for Mac to connect them.</span>
            <Link className="cv2-btn" href="/download">
              Download for Mac
            </Link>
          </>
        )}
      </div>

      <section className="cv2-group" aria-labelledby="cv2-subs">
        <h2 className="cv2-gh" id="cv2-subs">
          Subscriptions
        </h2>
        <div className="cv2-list">
          {subs.map((i) => (
            <SubscriptionRow key={i.id} instance={i} disabled={!online} onProbe={props.onProbe} onSetup={props.onSetup} onDisconnect={props.onDisconnect} />
          ))}
          {held.map((i) => (
            <SubscriptionRow key={i.id} instance={i} disabled held />
          ))}
        </div>
      </section>

      {props.showKeys !== false && (
      <section className="cv2-group" aria-labelledby="cv2-keys">
        <h2 className="cv2-gh" id="cv2-keys">
          Your API keys <span className="note">Used by the Alevr engine and never billed by Alevr</span>
        </h2>
        {loadError && <div className="cv2-mute" style={{ marginBottom: 8 }}>{loadError}</div>}
        <div className="cv2-list">
          {BYOK_PROVIDER_VALUES.map((p) => (
            <KeyRow key={p} provider={p} record={keys.find((k) => k.provider === p)} client={byok} onChange={(r) => setKey(p, r)} onRemoved={setUndo} />
          ))}
        </div>
      </section>
      )}

      {props.alevrPlan && (
        <section className="cv2-group" aria-labelledby="cv2-alevr">
          <h2 className="cv2-gh" id="cv2-alevr">
            Alevr
          </h2>
          <div className="cv2-list">
            <div className="cv2-li">
              <span className="cv2-tile">
                <InstanceMark instance={{ id: "alevr", kind: "alevr" }} size={18} />
              </span>
              <div>
                <div className="nm">{props.alevrPlan.name}</div>
                <div className="ds">Alevr models, billed to your plan.</div>
                {props.alevrPlan.spentUsd !== undefined && (
                  <div className="ds2">
                    <Meter
                      label={`$${props.alevrPlan.spentUsd.toFixed(2)}${props.alevrPlan.capUsd ? ` of $${props.alevrPlan.capUsd.toFixed(0)}` : ""} this month`}
                      pct={props.alevrPlan.capUsd ? (props.alevrPlan.spentUsd / props.alevrPlan.capUsd) * 100 : undefined}
                    />
                  </div>
                )}
              </div>
              <Link className="cv2-btn" href="/settings/billing">
                Plan
              </Link>
            </div>
          </div>
        </section>
      )}
      {undo && (
        <div className="cv2-toast" role="status">
          <span>Removed your {BYOK_LABELS[undo.provider]} key.</span>
          <span className="cv2-mute">Paste it again to restore it.</span>
          <button type="button" className="cv2-btn sm ghost" onClick={() => setUndo(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
  if (props.sheet) {
    return (
      <>
        <div className="cv2-scrim" onClick={props.onClose} aria-hidden />
        <div className="cv2-sheet" role="dialog" aria-modal="true" aria-label="Connections">
          <div className="cv2-page">{content}</div>
        </div>
      </>
    );
  }
  if (props.embedded) return <div className="cv2">{content}</div>;
  return <div className="cv2-page">{content}</div>;
}
