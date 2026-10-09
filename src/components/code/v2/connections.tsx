"use client";

/**
 * Connections (TARGET §11): the subscriptions the user's Mac reports (Claude,
 * ChatGPT/Codex, Gemini CLI, Grok, DeepSeek Harness, OpenCode, Antigravity),
 * the user's own API keys, and the Alevr plan, as master/detail inside one card.
 *
 * Portions adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc., MIT License
 * (the Providers settings pane: a list of sources with one status line each on
 * the left, the selected source's details and actions on the right).
 *
 * States are one short line, never badges or progress bars; usage is a number
 * with its reset time. Install and Sign in open the in-app terminal with the
 * vendor's command typed, not run. Health checks never start a login.
 *
 * Used in Settings › Connections and as the first-run sheet in /code.
 */
import * as React from "react";
import Link from "next/link";
import { BYOK_PROVIDER_VALUES, type ByokProvider, type ProviderInstance } from "@/lib/code-v2/contracts";
import { BYOK_LABELS, ByokError, looksLikeKey, maskKey, type ByokClient, type ByokKeyRecord } from "@/lib/code-v2/byok-client";
import {
  ACP_RUNTIMES,
  acpRuntimeKey,
  CONNECTION_ACTION_LABELS,
  connectionAction,
  connectionSentence,
  displayName,
  isExpired,
  isInstanceVisible,
  isSubscriptionKind,
  managedProgress,
  planName,
  type FeatureFlags,
} from "@/lib/code-v2/providers-view";
import { formatReset } from "@/lib/code-v2/tier-view";
import { checkPastedRedirect, managedStep, safeAuthorizationUrl, type ManagedStep } from "@/lib/code-v2/managed-runtime";
import type { ProviderAuthAction, ProviderAuthState, ProviderInstallAction, ProviderInstallState } from "@/lib/code-v2/runtime-lane";
import { ComposerPopover, Glyph, InstanceMark, MenuList, Spinner } from "./primitives";
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
  /** Opens the in-app terminal with the vendor's install / login command typed in; resolves with a sentence to show. */
  onSetup?: (instance: ProviderInstance, action: "install" | "login") => Promise<void | string> | void | string;
  onDisconnect?: (instanceId: string) => void;
  /** Runtimes the env server installs and signs in itself (Antigravity). */
  onManaged?: (instanceId: string, op: ManagedOp) => Promise<{ install?: ProviderInstallState; auth?: ProviderAuthState }>;
  /** First-run sheet: a close button and no outer page padding. */
  sheet?: boolean;
  /** Inside Settings: no page title or padding (the pane has its own). */
  embedded?: boolean;
  /** Show the API keys group (Settings keeps its own, with usage). Default true. */
  showKeys?: boolean;
  /** Which row starts selected ("acp:grok", "key:anthropic", "alevr"). */
  initialSelected?: string;
  onClose?: () => void;
}

export type ManagedOp =
  | { type: "install"; action: ProviderInstallAction; operationId?: string }
  | { type: "auth"; action: ProviderAuthAction; flowId?: string; callbackUrl?: string };

const UNOFFERED_SENTENCE = "Your Mac does not offer this yet. Update Alevr on your Mac to add it.";

/** Subscriptions shown before a device reports anything (all rows disabled). */
const PLACEHOLDER_SUBSCRIPTIONS: ProviderInstance[] = [
  { id: "claude-agent:default", kind: "claude-agent", label: "Claude", status: "unknown" },
  { id: "codex:default", kind: "codex", label: "Codex", status: "unknown" },
  { id: "acp:gemini", kind: "acp", label: "Gemini CLI", status: "unknown", acpCommand: ["gemini", "--experimental-acp"] },
  { id: "acp:grok", kind: "acp", label: "Grok", status: "unknown", acpCommand: ["grok"] },
  { id: "acp:dsh", kind: "acp", label: "DeepSeek Harness", status: "unknown", acpCommand: ["dsh"] },
  { id: "acp:opencode", kind: "acp", label: "OpenCode", status: "unknown", acpCommand: ["opencode"] },
  { id: "acp:antigravity", kind: "acp", label: "Antigravity", status: "unknown", acpCommand: ["antigravity-acp"] },
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

/** The list row's one status line. */
export function rowStatus(instance: ProviderInstance, opts: { disabled?: boolean; held?: boolean } = {}): { text: string; warn: boolean } {
  if (opts.held) return { text: "Update Alevr on your Mac", warn: false };
  if (opts.disabled) return { text: "Connect your Mac to check", warn: false };
  const managed = managedProgress(instance);
  if (managed) return { text: managed.replace(/\.$/, ""), warn: false };
  if (isExpired(instance)) return { text: "Sign-in expired", warn: true };
  switch (instance.status) {
    case "not-installed":
      return { text: "Not installed", warn: false };
    case "signed-out":
      return { text: "Not signed in", warn: false };
    case "error":
      return { text: "Could not start", warn: true };
    case "unknown":
      return { text: "Not checked yet", warn: false };
    case "limited":
      return { text: `${planName(instance.account?.plan) ?? "Plan"} limit reached`, warn: false };
    default: {
      const plan = planName(instance.account?.plan);
      const w = instance.limits?.[0];
      const parts = [plan, w?.usedPct !== undefined ? `${Math.round(w.usedPct)}% of ${/hour/i.test(w.label) ? `${w.label} window` : w.label}` : undefined].filter(Boolean);
      return { text: parts.length ? parts.join(" · ") : instance.account?.tokenSource === "apiKey" ? "Signed in with an API key" : "Ready", warn: false };
    }
  }
}

// ── Subscription detail ─────────────────────────────────────────────────────

function SubscriptionDetail({
  instance,
  disabled,
  held = false,
  onProbe,
  onSetup,
  onDisconnect,
  onManaged,
}: {
  instance: ProviderInstance;
  disabled: boolean;
  held?: boolean;
  onProbe?: ConnectionsProps["onProbe"];
  onSetup?: ConnectionsProps["onSetup"];
  onDisconnect?: ConnectionsProps["onDisconnect"];
  onManaged?: ConnectionsProps["onManaged"];
}) {
  const [busy, setBusy] = React.useState<null | "probe" | "setup" | "managed">(null);
  const [seen, setSeen] = React.useState<{ install?: ProviderInstallState; auth?: ProviderAuthState }>({});
  React.useEffect(() => setSeen({}), [instance.status, instance.id]);
  const [menu, setMenu] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [setupLine, setSetupLine] = React.useState<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const step = !disabled && !held && onManaged ? managedStep(instance, seen) : null;
  const managed = async (op: ManagedOp) => {
    if (!onManaged) return;
    setBusy("managed");
    setError(null);
    try {
      const r = await onManaged(instance.id, op);
      setSeen((s) => ({ ...s, ...r }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Your Mac did not answer.");
    } finally {
      setBusy(null);
    }
  };
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
  const sentence = held ? UNOFFERED_SENTENCE : disabled ? "Connect your Mac to check this." : step ? step.sentence : connectionSentence(instance);
  return (
    <div className="cv2-md-detail" aria-disabled={disabled || undefined}>
      <div className="hd">
        <InstanceMark instance={instance} size={20} />
        <span className="cv2-m">{displayName(instance)}</span>
        {instance.version && !held && <span className="ver cv2-tnum">{instance.version}</span>}
      </div>
      <p className={cn("cv2-ds", expired && "warn")} data-checking={busy === "probe" || undefined} style={{ margin: 0 }}>
        {expired && !/expired/i.test(sentence) ? "Sign-in expired. " : ""}
        {sentence}
        {note && !sentence.includes(note) ? ` ${note}` : ""}
      </p>
      {!disabled && !held && (instance.account?.email || instance.limits?.length || instance.checkedAt) ? (
        <dl className="cv2-kv">
          {instance.account?.email && (
            <>
              <dt>Account</dt>
              <dd className="cv2-trunc">{instance.account.email}</dd>
            </>
          )}
          {planName(instance.account?.plan) && (
            <>
              <dt>Plan</dt>
              <dd>{planName(instance.account?.plan)}</dd>
            </>
          )}
          {instance.limits?.map((w) => (
            <React.Fragment key={w.id}>
              <dt>{/hour/i.test(w.label) ? `${w.label} window` : w.label}</dt>
              <dd>
                {w.usedPct !== undefined ? `${Math.round(w.usedPct)}% used` : "In use"}
                {w.resetsAt ? `, resets ${formatReset(w.resetsAt)}` : ""}
              </dd>
            </React.Fragment>
          ))}
          {instance.checkedAt && (
            <>
              <dt>Checked</dt>
              <dd>{ago(instance.checkedAt)}</dd>
            </>
          )}
        </dl>
      ) : null}
      {step?.kind === "install" && step.busy && step.pct !== undefined && <p className="cv2-ds cv2-tnum" style={{ margin: 0 }}>Downloaded {Math.round(step.pct)}%</p>}
      {step?.kind === "sign-in" && step.waiting && <SignInFinish step={step} busy={busy === "managed"} onComplete={(url) => managed({ type: "auth", action: "complete", flowId: step.flowId, callbackUrl: url })} />}
      {error && <p className="cv2-ds warn" style={{ margin: 0 }}>{error}</p>}
      {setupLine && <p className="cv2-ds" style={{ margin: 0 }}>{setupLine}</p>}
      <div className="cv2-acts" ref={menuRef}>
        {step ? (
          step.busy ? (
            <button type="button" className="cv2-btn" disabled={busy !== null} onClick={() => managed(step.kind === "install" ? { type: "install", action: "cancel", operationId: step.operationId } : { type: "auth", action: "cancel", flowId: step.flowId })}>
              {busy === "managed" ? <Spinner size={14} /> : null}
              Cancel
            </button>
          ) : (
            <button type="button" className={cn("cv2-btn", "ink")} disabled={busy !== null} onClick={() => managed(step.kind === "install" ? { type: "install", action: "start" } : { type: "auth", action: "start" })}>
              {busy === "managed" ? <Spinner size={14} /> : null}
              {step.kind === "install" ? "Install" : expired ? "Sign in again" : "Sign in"}
            </button>
          )
        ) : held ? null : disabled ? (
          <button type="button" className="cv2-btn" disabled>
            {CONNECTION_ACTION_LABELS[action === "manage" ? "re-check" : action]}
          </button>
        ) : action === "install" || action === "sign-in" || action === "sign-in-again" ? (
          <button type="button" className="cv2-btn ink" onClick={() => setup(action === "install" ? "install" : "login")} disabled={busy !== null}>
            {busy === "setup" ? <Spinner size={14} /> : null}
            {CONNECTION_ACTION_LABELS[action]}
          </button>
        ) : action === "re-check" ? (
          <button type="button" className="cv2-btn" onClick={probe} disabled={busy !== null}>
            {busy === "probe" ? <Spinner size={14} /> : null}
            Re-check
          </button>
        ) : (
          <>
            <button type="button" className="cv2-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              Manage <Glyph name="chevron-down" size={12} />
            </button>
            <ComposerPopover open={menu} onClose={() => setMenu(false)} width={240} align="left" offset={0} label="Manage" anchorRef={menuRef} down role="menu">
              <MenuList
                label="Manage"
                onClose={() => setMenu(false)}
                entries={[
                  { id: "probe", label: "Re-check", onSelect: () => void probe() },
                  { id: "login", label: "Sign in to another account", onSelect: () => void setup("login") },
                  ...(onDisconnect ? [{ id: "off", label: "Disconnect", onSelect: () => onDisconnect(instance.id) }] : []),
                ]}
              />
            </ComposerPopover>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * While a managed sign-in waits: the vendor's page opens in a new tab. On the
 * Mac itself the browser lands back on the Mac's loopback and the row turns
 * signed in by itself. Anywhere else, the reader pastes the address the
 * browser ended on and the Mac finishes it.
 */
function SignInFinish({ step, busy, onComplete }: { step: Extract<ManagedStep, { kind: "sign-in" }>; busy: boolean; onComplete: (url: string) => void }) {
  const [pasting, setPasting] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const href = safeAuthorizationUrl(step.authorizationUrl);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="cv2-acts">
        {href && (
          <a className="cv2-btn ink" href={href} target="_blank" rel="noopener noreferrer">
            Open the {step.method} sign-in
          </a>
        )}
        {!pasting && (
          <button type="button" className="cv2-btn ghost" onClick={() => setPasting(true)}>
            Not on your Mac?
          </button>
        )}
      </div>
      {pasting && (
        <form
          className="cv2-keyfield"
          onSubmit={(e) => {
            e.preventDefault();
            const r = checkPastedRedirect(value);
            if (!r.ok) return setProblem(r.message);
            setProblem(null);
            onComplete(r.url);
          }}
        >
          <input autoFocus type="url" autoComplete="off" spellCheck={false} placeholder="http://localhost:…" aria-label="Address your browser ended on after signing in" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="cv2-btn ink" disabled={!value.trim() || busy}>
            {busy ? <Spinner size={14} /> : null}
            Finish
          </button>
        </form>
      )}
      {pasting && !problem && <p className="cv2-ds" style={{ margin: 0 }}>After signing in, your browser shows a page that cannot load. Copy its address and paste it here.</p>}
      {problem && <p className="cv2-ds warn" style={{ margin: 0 }}>{problem}</p>}
    </div>
  );
}

// ── Key detail ──────────────────────────────────────────────────────────────

function keySentence(provider: ByokProvider, record?: ByokKeyRecord): string {
  const label = BYOK_LABELS[provider];
  if (!record) return "No key.";
  if (record.invalid) return `Refused by ${label}${record.detail ? ` (${record.detail})` : ""}. Replace or re-test it.`;
  return `${record.hint}, added ${new Date(record.addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${record.lastUsedAt ? `, last used ${ago(record.lastUsedAt)}` : ", not used yet"}.`;
}

function KeyDetail({ provider, record, client, onChange, onRemoved }: { provider: ByokProvider; record?: ByokKeyRecord; client?: ByokClient; onChange: (r: ByokKeyRecord | null) => void; onRemoved: (r: ByokKeyRecord) => void }) {
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
      onChange(await client.add(provider, value));
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
  return (
    <div className="cv2-md-detail">
      <div className="hd">
        <Glyph name="key" size={20} />
        <span className="cv2-m">{label}</span>
      </div>
      <p className={cn("cv2-ds", record?.invalid && "warn")} style={{ margin: 0 }}>
        {keySentence(provider, record)} Used by the Alevr engine and billed by {label}, never by Alevr.
      </p>
      {adding && (
        <form className="cv2-keyfield" onSubmit={save}>
          <input autoFocus type="password" autoComplete="off" spellCheck={false} placeholder={`Paste your ${label} key`} aria-label={`${label} API key`} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="cv2-btn ghost" onClick={() => (setAdding(false), setValue(""), setError(null))}>
            Cancel
          </button>
          <button type="submit" className="cv2-btn ink" disabled={!value.trim() || busy !== null}>
            {busy === "save" ? <Spinner size={14} /> : null}
            Test and save
          </button>
        </form>
      )}
      {adding && value.trim() && !looksLikeKey(provider, value) && <p className="cv2-ds" style={{ margin: 0 }}>That does not look like a {label} key ({maskKey(value)}). Alevr will still test it.</p>}
      {error && <p className="cv2-ds warn" style={{ margin: 0 }}>{error}</p>}
      <div className="cv2-acts">
        {record && !adding && (
          <>
            <button type="button" className="cv2-btn" onClick={test} disabled={busy !== null}>
              {busy === "test" && <Spinner size={14} />}
              Re-test
            </button>
            <button type="button" className="cv2-btn ghost" onClick={remove} disabled={busy !== null}>
              Remove
            </button>
          </>
        )}
        {!record && !adding && (
          <button type="button" className="cv2-btn ink" onClick={() => setAdding(true)} disabled={!client}>
            Add key
          </button>
        )}
      </div>
    </div>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

export function ConnectionsPanel(props: ConnectionsProps) {
  const { instances, device, flags, byok } = props;
  const [keys, setKeys] = React.useState<ByokKeyRecord[]>(props.keys ?? []);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [undo, setUndo] = React.useState<ByokKeyRecord | null>(null);
  const [showDetail, setShowDetail] = React.useState(!!props.initialSelected);
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
  const runtimeOf = (i: ProviderInstance) => (i.kind === "acp" ? (acpRuntimeKey(i) ?? i.id) : i.kind);
  const held = listed === reported ? PLACEHOLDER_SUBSCRIPTIONS.filter((p) => isInstanceVisible(p, flags) && !reported.some((i) => runtimeOf(i) === runtimeOf(p))) : [];
  const setKey = (provider: ByokProvider, r: ByokKeyRecord | null) => setKeys((ks) => [...ks.filter((k) => k.provider !== provider), ...(r ? [r] : [])]);
  const showKeys = props.showKeys !== false;
  const [selected, setSelected] = React.useState<string>(props.initialSelected ?? subs[0]?.id ?? "alevr");
  const choose = (id: string) => {
    setSelected(id);
    setShowDetail(true);
  };

  const subRow = (i: ProviderInstance, opts: { disabled?: boolean; held?: boolean }) => {
    const st = rowStatus(i, opts);
    return (
      <button key={i.id} type="button" className="cv2-md-row" aria-current={selected === i.id ? "true" : undefined} aria-disabled={opts.disabled || opts.held || undefined} onClick={() => choose(i.id)}>
        <InstanceMark instance={i} size={16} />
        <span style={{ minWidth: 0 }}>
          <span className="nm block cv2-trunc">{displayName(i)}</span>
          <span className={cn("ds", st.warn && "warn")}>{st.text}</span>
        </span>
      </button>
    );
  };

  const selSub = subs.find((i) => i.id === selected);
  const selHeld = held.find((i) => i.id === selected);
  const selKey = selected.startsWith("key:") ? (selected.slice(4) as ByokProvider) : null;
  let detail: React.ReactNode = null;
  if (selSub) detail = <SubscriptionDetail key={selSub.id} instance={selSub} disabled={!online} onProbe={props.onProbe} onSetup={props.onSetup} onDisconnect={props.onDisconnect} onManaged={props.onManaged} />;
  else if (selHeld) detail = <SubscriptionDetail key={selHeld.id} instance={selHeld} disabled held />;
  else if (selected === "key:add" && showKeys)
    detail = (
      <div className="cv2-md-detail">
        <div className="hd">
          <Glyph name="key" size={20} />
          <span className="cv2-m">Add a key</span>
        </div>
        <p className="cv2-ds" style={{ margin: 0 }}>Your own API keys run Alevr&apos;s engine on the lab&apos;s bill. Alevr never charges for them.</p>
        <div className="cv2-set-card" style={{ borderRadius: 12 }}>
          {BYOK_PROVIDER_VALUES.filter((p) => !keys.some((k) => k.provider === p)).map((p) => (
            <button key={p} type="button" className="cv2-set-row" style={{ minHeight: 40 }} onClick={() => choose(`key:${p}`)}>
              <span className="cv2-grow">{BYOK_LABELS[p]}</span>
              <Glyph name="chevron-right" size={14} className="cv2-mute" />
            </button>
          ))}
        </div>
      </div>
    );
  else if (selKey && showKeys) detail = <KeyDetail key={selKey} provider={selKey} record={keys.find((k) => k.provider === selKey)} client={byok} onChange={(r) => setKey(selKey, r)} onRemoved={setUndo} />;
  else if (selected === "alevr" && props.alevrPlan)
    detail = (
      <div className="cv2-md-detail">
        <div className="hd">
          <InstanceMark instance={{ id: "alevr", kind: "alevr" }} size={20} />
          <span className="cv2-m">Alevr</span>
        </div>
        <p className="cv2-ds" style={{ margin: 0 }}>Alevr models, billed to your {props.alevrPlan.name}.</p>
        {props.alevrPlan.spentUsd !== undefined && (
          <dl className="cv2-kv">
            <dt>This month</dt>
            <dd>
              ${props.alevrPlan.spentUsd.toFixed(2)}
              {props.alevrPlan.capUsd ? ` of $${props.alevrPlan.capUsd.toFixed(0)}` : ""}
            </dd>
          </dl>
        )}
        <div className="cv2-acts">
          <Link className="cv2-btn" href="/settings/billing">
            Manage plan
          </Link>
        </div>
      </div>
    );

  const note = (
    <div className="cv2-note">
      <Glyph name="laptop" size={14} />
      {device ? (
        online ? (
          <span>
            On the web, subscriptions run through {device.name}
            {device.lastSeenAt ? `, seen ${ago(device.lastSeenAt)}` : ""}.
          </span>
        ) : (
          <span>
            {device.name} is offline{device.lastSeenAt ? `, last seen ${ago(device.lastSeenAt)}` : ""}. Open Alevr on it to use your subscriptions.
          </span>
        )
      ) : (
        <>
          <span>Subscriptions run on your Mac. Open Alevr for Mac to connect them.</span>
          <Link className="cv2-link" href="/download">
            Download for Mac
          </Link>
        </>
      )}
    </div>
  );

  const content = (
    <div className="inner">
      {!props.embedded && (
        <div className="cv2-row" style={{ gap: 12 }}>
          <h1 className="cv2-h1 cv2-grow">Connections</h1>
          {props.sheet && props.onClose && (
            <button type="button" className="cv2-iconbtn" aria-label="Close" onClick={props.onClose}>
              <Glyph name="close" />
            </button>
          )}
        </div>
      )}
      {note}
      {loadError && <div className="cv2-note">{loadError}</div>}
      <div className="cv2-md" data-detail={showDetail ? "true" : "false"}>
        <div className="cv2-md-list" role="list" aria-label="Sources">
          <div className="cv2-msect">Subscriptions</div>
          {subs.map((i) => subRow(i, { disabled: !online }))}
          {held.map((i) => subRow(i, { held: true }))}
          {showKeys && (
            <>
              <div className="cv2-msect" style={{ marginTop: 8 }}>
                Your API keys
              </div>
              {BYOK_PROVIDER_VALUES.filter((p) => keys.some((k) => k.provider === p) || selected === `key:${p}`).map((p) => {
                const rec = keys.find((k) => k.provider === p);
                return (
                  <button key={p} type="button" className="cv2-md-row" aria-current={selected === `key:${p}` ? "true" : undefined} onClick={() => choose(`key:${p}`)}>
                    <Glyph name="key" size={16} />
                    <span style={{ minWidth: 0 }}>
                      <span className="nm block cv2-trunc">{BYOK_LABELS[p]}</span>
                      <span className={cn("ds", rec?.invalid && "warn")}>{rec ? (rec.invalid ? "Refused" : rec.hint) : "No key"}</span>
                    </span>
                  </button>
                );
              })}
              <button type="button" className="cv2-md-row" aria-current={selected === "key:add" ? "true" : undefined} onClick={() => choose("key:add")}>
                <Glyph name="plus" size={16} />
                <span className="nm block cv2-mute">Add a key</span>
              </button>
            </>
          )}
          {props.alevrPlan && (
            <>
              <div className="cv2-msect" style={{ marginTop: 8 }}>
                Alevr
              </div>
              <button type="button" className="cv2-md-row" aria-current={selected === "alevr" ? "true" : undefined} onClick={() => choose("alevr")}>
                <InstanceMark instance={{ id: "alevr", kind: "alevr" }} size={16} />
                <span style={{ minWidth: 0 }}>
                  <span className="nm block cv2-trunc">{props.alevrPlan.name}</span>
                  <span className="ds">{props.alevrPlan.spentUsd !== undefined ? `$${props.alevrPlan.spentUsd.toFixed(2)}${props.alevrPlan.capUsd ? ` of $${props.alevrPlan.capUsd.toFixed(0)}` : ""} this month` : "Alevr models"}</span>
                </span>
              </button>
            </>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <button type="button" className="cv2-btn ghost cv2-md-back" style={{ margin: "12px 0 0 12px" }} onClick={() => setShowDetail(false)}>
            <Glyph name="chevron-left" size={14} /> All sources
          </button>
          {detail}
        </div>
      </div>
      {undo && (
        <div className="cv2-toast" role="status">
          <span>Removed your {BYOK_LABELS[undo.provider]} key.</span>
          <button type="button" className="cv2-btn ghost" onClick={() => setUndo(null)}>
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
