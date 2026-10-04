import "server-only";
import { assertConnectorEncryptionConfigured } from "@/lib/crypto";
import { assertDataEncryptionKeyConfigured } from "@/lib/message-crypto-config";
import { sweepAbandonedFirstSubmissionReceipts } from "@/lib/chat-first-submission-receipt";
import { installGracefulShutdown } from "@/lib/graceful-shutdown";

/**
 * Everything `instrumentation.ts` does on the Node runtime, in a module only
 * the Node runtime ever resolves.
 *
 * Why the indirection: Next compiles `instrumentation.ts` for the edge
 * runtime too, and webpack resolves every `import()` it can reach — an early
 * `return` on `NEXT_RUNTIME` does not make the code after it dead. The
 * receipt sweep reaches Prisma and `node:crypto`, neither of which the edge
 * bundle can resolve, and the dev server 500'd on every route the moment
 * that import was added. Inside `if (process.env.NEXT_RUNTIME === "nodejs")`
 * the branch IS constant-dead for the edge compile, and webpack skips it
 * entirely — which is the documented shape for Node-only instrumentation.
 */
export async function bootNodeRuntime(): Promise<void> {
  try {
    assertDataEncryptionKeyConfigured();
    if (process.env.NODE_ENV === "production") assertConnectorEncryptionConfigured();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[boot] ${message}`);
    // Only fatal in production. A developer running `next dev` gets the warning
    // and the derived key, which is what makes a fresh checkout runnable.
    if (process.env.NODE_ENV === "production") throw error;
  }

  // Drain on SIGTERM/SIGINT instead of Next's immediate exit — see
  // graceful-shutdown.ts for the sequence and shutdown.ts for the rules.
  installGracefulShutdown();

  // PM2 `wait_ready`: the listener is up by the time register() runs (Next
  // binds the port before initialising handlers), so this is the moment the
  // old process may be retired. Only present when PM2 launched this process
  // directly with an IPC channel; `next dev` has no such channel.
  process.send?.("ready");

  // Refund what the previous process could not: receipts it left `running`
  // whose lease has since expired. Awaited so the accounting is settled
  // before this process serves its first turn, but never fatal — a boot must
  // not fail because a sweep did.
  try {
    const swept = await sweepAbandonedFirstSubmissionReceipts();
    if (swept.scanned > 0) console.info("[boot] abandoned generation receipts swept", swept);
  } catch (error) {
    console.error("[boot] receipt sweep failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  scheduleRenewalReminders();
}

const RENEWAL_SWEEP_EVERY_MS = 12 * 60 * 60 * 1000;

/**
 * The annual-renewal notice sweep (renewal-reminders.ts), twice a day per
 * process. The RenewalReminder ledger makes it one mail per period however
 * many processes run it; unref'd so it never holds a draining process open.
 * Off without Stripe or mail, and with RENEWAL_REMINDERS=off.
 */
function scheduleRenewalReminders(): void {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.RESEND_API_KEY) return;
  if (process.env.RENEWAL_REMINDERS === "off" || process.env.NODE_ENV !== "production") return;
  const run = async () => {
    try {
      const { sweepRenewalReminders } = await import("@/lib/billing/renewal-reminders");
      const sent = await sweepRenewalReminders();
      if (sent > 0) console.info("[boot] renewal notices sent", { sent });
    } catch (error) {
      console.error("[boot] renewal sweep failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, RENEWAL_SWEEP_EVERY_MS).unref();
}
