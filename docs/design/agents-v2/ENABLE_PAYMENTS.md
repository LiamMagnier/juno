# Turning on agent payment cards

2026-10-31. For the owner. Code: `src/lib/payments/`, `src/lib/chat/payment-tools.ts`,
`src/app/api/payments/stripe-issuing/webhook/route.ts`. Tests: `tests/payments.test.ts`.

Agent payment cards are **off** until you finish every step below. While they are off, no
agent is offered the payment tools, the webhook route answers 404, and nothing else changes.

## What it does

An agent working in its own thread can ask to pay for one thing (`request_payment`):
a merchant, an amount in US dollars, and a reason.

1. Nothing happens before you answer. You get an approval card with **Not now** and
   **Pay**. The card shows the merchant, the amount and the agent's reason. It cannot be
   allowed standing ("Always allow" never appears), and it asks under every approval
   setting except Block and Lockdown, which refuse it.
2. On **Pay**, Stripe Issuing creates one virtual card:
   - its all-time spending limit is exactly the approved amount, so Stripe refuses
     anything above it;
   - it works for one payment;
   - it expires after 30 minutes unused (`AGENT_PAYMENT_CARD_TTL_MINUTES`).
3. The card's number, expiry and CVC are typed into the card fields of the checkout open
   in the agent's computer browser. The agent never sees them. They are never stored, logged,
   put in an event or in a tool result. Only the last four digits are kept, for the receipt.
4. If the agent's computer is off, asleep or under your control, or the open page has no card
   fields, the card is **held**. You are told what to do; the agent can then fill it once
   (`fill_payment_card`). A held card is cancelled at its expiry like any other.
5. A receipt line follows in the chat. The agent then presses the merchant's own pay button.
6. When the merchant charges the card, Stripe asks Juno in real time
   (`issuing_authorization.request`). Juno approves only when all of these hold:
   - the card belongs to an approved payment that has not been used;
   - it has not expired;
   - the currency matches;
   - the amount is at most the approved amount.

   It declines everything else, including a second charge and any answer it cannot give
   within 1.5 seconds. The card is cancelled right after the payment it made. A
   zero-amount check, which a merchant may run before it charges, is approved and does not
   use the card up. A merchant that checks with a non-zero hold (say $1) uses the card's
   one payment, so the real charge after it is declined.
7. Each agent has a **monthly spending limit**, which starts at zero: an agent cannot pay for
   anything until you set one. The agent can lower its limit when you ask
   (`set_spending_limit`). Raising it shows the agent approval card. It is never raised from a
   turn that read outside content (a web page, a file, an email).

## Before you start

- A Stripe account with **Issuing** enabled (US). Issuing has its own application in the
  Stripe Dashboard.
- **Card numbers by API.** Juno reads the card number and CVC with
  `expand[]=number&expand[]=cvc`. In live mode, Stripe allows this only for accounts it has
  approved to handle card data (PCI). Ask Stripe support to enable it for your account before
  going live. In test mode it works at once.
- Agent computers are on (`COMPUTER_PROVIDER`, see `docs/design/agents-v2/RULES.md` §7).
  Without a computer, every card is held and expires unused.

## Steps

Do steps 1 to 6 in **test mode** first, with `rk_test_…` keys, and try one payment end to end.

1. **Cardholder.** In Issuing, create one cardholder for the agents. An individual or a
   company, with your billing address; the name prints on checkout forms. Copy its id
   (`ich_…`).
2. **Restricted key.** In Developers, then API keys, create a restricted key with exactly these
   permissions:
   - Issuing Cards: Write;
   - Issuing Cardholders: Read;
   - Issuing Authorizations: Read.

   Copy it (`rk_…`). Do not reuse `STRIPE_SECRET_KEY`: billing and payments stay separate.
3. **Webhook endpoint.** In Developers, then Webhooks, add the endpoint
   `https://<your domain>/api/payments/stripe-issuing/webhook`. Subscribe it to
   `issuing_authorization.request` only. Copy its signing secret (`whsec_…`).
4. **Real-time authorizations.** In Issuing settings, check that real-time authorizations go
   to that endpoint. Set what happens when the endpoint does not answer in time to
   **decline**. Juno itself declines anything it cannot decide in time; this setting covers
   the server being down.
5. **Environment.** Add these on the server (never commit them):
   ```
   STRIPE_ISSUING_SECRET_KEY="rk_test_…"
   STRIPE_ISSUING_CARDHOLDER_ID="ich_…"
   STRIPE_ISSUING_WEBHOOK_SECRET="whsec_…"
   ```
   Optional:
   - `STRIPE_ISSUING_API_VERSION` (default `2026-06-24.dahlia`, the installed SDK's).
   - `AGENT_PAYMENT_CARD_TTL_MINUTES` (default 30, 5 to 1440).
   - `AGENT_PAYMENT_MAX_AMOUNT_MINOR` (default 50000, which is $500 per payment; a
     monthly limit can be at most 20 times this).

   All three required values must be set and well formed (`rk_`/`sk_`, `ich_`,
   `whsec_`), or payments stay off. Restart the web server **and** `juno-work`. The work
   runner's tick cancels expired cards once a minute.
6. **Try it.**
   1. In an agent's thread, say "set your spending limit to $20", and approve the card.
   2. Turn the agent's computer on, and open a test checkout that takes Stripe test cards.
   3. Ask the agent to pay $5 there. Press **Pay** on the card.
   4. Check that the card fields fill in, the merchant's charge is approved, and the card
      shows as canceled in the Issuing dashboard.
   5. Charge the same card again from the Dashboard's test helpers: it must be declined.
      A charge of $6 on a new $5 card must be declined too.
   6. Check that a capture after the card was cancelled still settles. Stripe captures
      authorizations it already approved; confirm this on your account.
7. **Live.** Repeat steps 2 to 5 with live keys, once Stripe has enabled card numbers by API.

## Turning it off

Remove `STRIPE_ISSUING_SECRET_KEY` (or any of the three) and restart. The tools disappear
from every agent and the webhook answers 404. Stripe then falls back to your timeout
setting (step 4: decline). Before removing the key, cancel any card still open in the
Issuing dashboard. Without the key, Juno can no longer cancel them itself.

## Development

Outside production, `AGENT_PAYMENTS_TEST_PROVIDER=1` issues pretend cards in memory. They
can be filled into a page but never authorized, because there is no webhook. Production
ignores this setting.
