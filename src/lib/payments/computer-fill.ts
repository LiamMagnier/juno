import "server-only";

/**
 * The real card filler: the agent's own computer browser, over CDP.
 *
 * The computer is found server-side from `(userId, agentId)` (RULES §3.1):
 * never from an id, address or port the model or a client named. It must be
 * on (`awake`) and not under the person's control; nothing here wakes or
 * starts it. The card goes into the page in front, frame by frame (checkouts
 * put each card field in its own iframe), into the inputs `planCardFields`
 * picked, and nowhere else.
 *
 * Never logged: Playwright's own debug output (`DEBUG=pw:*`) would print
 * what was typed, so with it on the filler refuses to run at all, and every
 * error is replaced by a fixed sentence rather than passed on.
 */

import type { Frame, Page } from "playwright";
import {
  COLLECT_CARD_INPUTS_SCRIPT,
  cardFieldValue,
  planCardFields,
  planIsComplete,
  readInputDescriptor,
  type CardFieldKind,
} from "./card-fields";
import { FILL_COPY, type CardFiller, type CardFillerResolver } from "./fill";
import type { CardDetails } from "./types";

const COPY = {
  asleep: "The card is ready, but this agent's computer is asleep. Wake it, open the checkout there, then ask the agent to fill the card.",
  takenOver: "The card is ready, but you have control of the agent's computer. Hand it back, then ask the agent to fill the card.",
  debug: "The card is ready, but this server has browser debug logging on, which would record what is typed. It was not filled.",
  unsupported: "The card is ready, but this computer's browser cannot be reached to type it.",
} as const;

/** Whether Playwright would echo what is typed into the server's logs. */
export function playwrightDebugLogging(debug: string | undefined): boolean {
  if (!debug) return false;
  return debug.split(/[\s,]+/).some((name) => name === "*" || name.startsWith("pw:") || name === "pw*");
}

async function frameInputs(frame: Frame): Promise<Map<CardFieldKind, number>> {
  const raw = await frame.evaluate(COLLECT_CARD_INPUTS_SCRIPT).catch(() => []);
  const inputs = (Array.isArray(raw) ? raw : []).map(readInputDescriptor).filter((input) => input !== null);
  return planCardFields(inputs);
}

/** Where each kind of card field is, across the page's frames: the first frame offering it wins. */
async function locateCardFields(page: Page): Promise<Map<CardFieldKind, { frame: Frame; index: number }>> {
  const found = new Map<CardFieldKind, { frame: Frame; index: number }>();
  for (const frame of page.frames()) {
    const plan = await frameInputs(frame);
    for (const [kind, index] of plan) if (!found.has(kind)) found.set(kind, { frame, index });
  }
  return found;
}

async function typeCard(page: Page, details: CardDetails): Promise<{ ok: true; filled: CardFieldKind[] } | { ok: false; message: string }> {
  const fields = await locateCardFields(page);
  if (!planIsComplete(new Set(fields.keys()))) return { ok: false, message: FILL_COPY.noFields };
  const filled: CardFieldKind[] = [];
  for (const [kind, where] of fields) {
    if (kind === "name" && !details.name) continue;
    // A combined expiry field wins over a split one only when both exist.
    if ((kind === "expMonth" || kind === "expYear") && fields.has("exp")) continue;
    const field = where.frame.locator("input").nth(where.index);
    try {
      await field.fill("", { timeout: 5_000 });
      // Key by key: checkout fields format as they are typed into.
      await field.pressSequentially(cardFieldValue(kind, details), { delay: 15, timeout: 15_000 });
      filled.push(kind);
    } catch {
      return { ok: false, message: FILL_COPY.failed };
    }
  }
  return { ok: true, filled };
}

export const computerCardFillerResolver: CardFillerResolver = async ({ userId, agentId }) => {
  if (playwrightDebugLogging(process.env.DEBUG)) return { ok: false, reason: "unsupported", message: COPY.debug };
  const [{ computerProvider }, store, { connectAgentBrowser }, { takeoverActive }] = await Promise.all([
    import("@/lib/computer/provider"),
    import("@/lib/computer/store"),
    import("@/lib/computer/remote-browser"),
    import("@/lib/computer/takeover"),
  ]);
  const provider = computerProvider();
  if (!provider) return { ok: false, reason: "no_computer", message: FILL_COPY.noComputer };
  if (provider.name === "fake") return { ok: false, reason: "unsupported", message: COPY.unsupported };
  const row = await store.getComputerStorePersistence().findByAgent(userId, agentId);
  if (!row || row.userId !== userId || row.agentId !== agentId) return { ok: false, reason: "no_computer", message: FILL_COPY.noComputer };
  if (row.status !== "awake") return { ok: false, reason: "asleep", message: COPY.asleep };
  if (takeoverActive(row, new Date())) return { ok: false, reason: "taken_over", message: COPY.takenOver };
  let secrets: ReturnType<typeof store.decodeSecrets>;
  try {
    secrets = store.decodeSecrets(row.secrets);
  } catch {
    return { ok: false, reason: "unsupported", message: COPY.unsupported };
  }
  const browser = connectAgentBrowser(store.decodeHandle(row.containerRef, agentId), secrets, { provider });

  const filler: CardFiller = {
    async locate() {
      try {
        const fields = await browser.withPage((page) => locateCardFields(page));
        return planIsComplete(new Set(fields.keys())) ? { ok: true } : { ok: false, message: FILL_COPY.noFields };
      } catch {
        return { ok: false, message: COPY.unsupported };
      }
    },
    async fill(details) {
      try {
        return await browser.withPage((page) => typeCard(page, details));
      } catch {
        return { ok: false, message: FILL_COPY.failed };
      }
    },
    close: () => browser.close(),
  };
  return { ok: true, filler };
};
