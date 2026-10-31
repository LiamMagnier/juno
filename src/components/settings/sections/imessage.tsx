"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow, SettingsGroup, SettingsInlineError } from "@/components/settings/setting-row";
import { useSettingsResource } from "@/components/settings/use-settings-resource";

const IMESSAGE_URL = "/api/channels/imessage";

interface ChannelLinkView {
  status: "pending" | "verified";
  lastFour: string;
  verifiedAt: string | null;
  codeExpiresAt: string | null;
}

interface IMessageState {
  configured: boolean;
  link: ChannelLinkView | null;
}

function parseIMessage(body: unknown): IMessageState {
  const value = body as Partial<IMessageState> | null;
  if (!value || typeof value.configured !== "boolean") throw new Error("unreadable");
  return { configured: value.configured, link: value.link ?? null };
}

const IMESSAGE_COPY = {
  title: "iMessage",
  description: "Text your agents from your phone. Start a text with @Name to pick one. Approvals stay in the app: a reply by text never approves anything.",
  numberLabel: "Your number",
  numberHint: "With its country code. We text it a six-digit code.",
  codeLabel: "Code",
  codeHint: "The six digits we just texted. They expire in 10 minutes.",
  linkedLabel: "Linked number",
  sendCode: "Send code",
  link: "Link",
  unlink: "Unlink",
  change: "Change",
  cancel: "Cancel",
  loadFailed: "Couldn’t load your iMessage link.",
  requestFailed: "That didn’t work. Try again.",
  linked: "Your number is linked.",
  unlinked: "Your number is unlinked. Texts from it reach nobody now.",
} as const;

/** "Ending in 0100", or a plain "Linked" when the row could not be read back. */
function EndingIn({ lastFour }: { lastFour: string }) {
  return lastFour ? <>Ending in <span translate="no">{lastFour}</span></> : <>Linked</>;
}

type Step = "rest" | "number" | "code";

/**
 * Settings › Devices › iMessage: link one number, read a code back, unlink.
 *
 * Drawn only when the server offers it (`configured`); otherwise nothing,
 * not even a disabled row. The number never comes back from the server, only
 * its last four digits. The rows follow the Username row's pattern: at rest a
 * description and one button, and the field opens in the row itself.
 */
export function IMessageGroup() {
  const { data, error, reload, setData } = useSettingsResource<IMessageState>(IMESSAGE_URL, parseIMessage);
  const [step, setStep] = React.useState<Step>("rest");
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  // A code already waiting (another tab, a reload) opens on the code field,
  // once: Cancel from there has to stay cancelled.
  const pendingOnArrival = data?.link?.status === "pending";
  const [openedPending, setOpenedPending] = React.useState(false);
  React.useEffect(() => {
    if (!pendingOnArrival || openedPending) return;
    setOpenedPending(true);
    setStep("code");
  }, [pendingOnArrival, openedPending]);

  if (!data) {
    return error ? (
      <SettingsGroup title={IMESSAGE_COPY.title}>
        <SettingsInlineError onRetry={() => void reload()}>{IMESSAGE_COPY.loadFailed}</SettingsInlineError>
      </SettingsGroup>
    ) : null;
  }
  if (!data.configured) return null;

  const call = async (url: string, init: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) setMessage(typeof body.message === "string" ? body.message : IMESSAGE_COPY.requestFailed);
      return { ok: res.ok, body };
    } catch {
      setMessage(IMESSAGE_COPY.requestFailed);
      return { ok: false, body: {} };
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    const result = await call(`${IMESSAGE_URL}/link`, { method: "POST", body: JSON.stringify({ phone }) });
    if (!result.ok) return;
    if (result.body.status === "verified") {
      setStep("rest");
      await reload();
      return;
    }
    setCode("");
    setStep("code");
  };

  const verify = async () => {
    const result = await call(`${IMESSAGE_URL}/verify`, { method: "POST", body: JSON.stringify({ code }) });
    if (!result.ok) return;
    setStep("rest");
    setPhone("");
    setCode("");
    toast.success(IMESSAGE_COPY.linked);
    await reload();
  };

  const unlink = async () => {
    const result = await call(IMESSAGE_URL, { method: "DELETE" });
    if (!result.ok) return;
    setData({ configured: true, link: null });
    setStep("rest");
    toast.success(IMESSAGE_COPY.unlinked);
  };

  const cancel = () => {
    setStep("rest");
    setMessage(null);
    setCode("");
  };

  const verified = data.link?.status === "verified" ? data.link : null;
  const note = message ? (
    <p className="text-ui text-destructive-ink" role="status">
      {message}
    </p>
  ) : null;

  return (
    <SettingsGroup title={IMESSAGE_COPY.title} description={IMESSAGE_COPY.description}>
      {verified && step === "rest" ? (
        <SettingRow
          label={IMESSAGE_COPY.linkedLabel}
          description={<EndingIn lastFour={verified.lastFour} />}
          control={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep("number")} disabled={busy}>
                {IMESSAGE_COPY.change}
              </Button>
              <Button variant="destructive-outline" size="sm" onClick={() => void unlink()} loading={busy}>
                {IMESSAGE_COPY.unlink}
              </Button>
            </div>
          }
        >
          {note}
        </SettingRow>
      ) : step === "code" ? (
        <SettingRow label={IMESSAGE_COPY.codeLabel} htmlFor="imessage-code" description={IMESSAGE_COPY.codeHint}>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="imessage-code"
                name="code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={busy}
                className="min-w-0 flex-1 basis-40"
              />
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
                  {IMESSAGE_COPY.cancel}
                </Button>
                <Button type="submit" loading={busy} disabled={code.length !== 6}>
                  {IMESSAGE_COPY.link}
                </Button>
              </div>
            </div>
            {note}
          </form>
        </SettingRow>
      ) : (
        <SettingRow label={IMESSAGE_COPY.numberLabel} htmlFor="imessage-number" description={IMESSAGE_COPY.numberHint}>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendCode();
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="imessage-number"
                name="phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                autoComplete="tel"
                placeholder="+1 415 555 0100"
                maxLength={40}
                disabled={busy}
                translate="no"
                className="min-w-0 flex-1 basis-56"
              />
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {verified && (
                  <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
                    {IMESSAGE_COPY.cancel}
                  </Button>
                )}
                <Button type="submit" loading={busy} disabled={!phone.trim()}>
                  {IMESSAGE_COPY.sendCode}
                </Button>
              </div>
            </div>
            {note}
          </form>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
