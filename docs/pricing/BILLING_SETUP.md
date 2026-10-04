# Billing setup — what to do in the Stripe dashboard

Everything the code needs from Stripe for the October 2026 lineup (Free, Lite
9 €, Pro 20 €, Plus 50 €, Max ×5 100 €, Max ×10 200 €, Ultra 500 €, all HT),
annual billing at two months free, usage top-ups, referral rewards and the
annual-renewal notice. Do it in **test mode first**, run one checkout of each
kind, then repeat in live mode and copy the live ids into the production env.

Amounts in Stripe are **HT** (tax behaviour *exclusive*); Stripe Tax adds the
buyer's VAT at checkout. The app shows TTC prices (HT × 1.20 for a French
buyer) through `src/lib/price-display.ts`.

## 1. Business and tax

1. **Settings → Business → Public details**: legal name, support email, and
   **Terms of service URL** = `https://<app domain>/legal/cgv` (the checkout
   consent checkbox links to it). Privacy policy URL = `/legal/confidentialite`.
   **Note:** as of this branch there is no `/legal/cgv` page yet (only `cgu`,
   `confidentialite`, `mentions-legales`). The Terms of Sale must exist before
   live checkout opens — they carry the withdrawal-waiver wording, the renewal
   terms and the top-up validity (12 months).
2. **Settings → Tax** (Stripe Tax):
   - Origin address: the French business address.
   - Default tax code: **`txcd_10103001`** (Software as a service). Default tax
     behaviour: **Exclusive**.
   - **Registrations**: add **France** (standard VAT, 20%) and the **EU One-Stop
     Shop (OSS, Union scheme)** so other EU consumers are charged their own
     country's rate. Add others only if you register there.
   - Turn on **automatic tax** for Checkout (the code passes
     `automatic_tax: { enabled: true }`; set `STRIPE_AUTOMATIC_TAX="false"`
     only on a test account without Stripe Tax).
3. **Tax ID collection** is requested per session by the code
   (`tax_id_collection`). Nothing to switch on, but check **Settings → Tax →
   Customer tax IDs → Validate EU VAT numbers** is enabled so a valid business
   VAT number is reverse-charged.

## 2. Products and prices (12 recurring + 2 one-off)

**Product catalogue → Add product**, one product per tier. On each product add
**two recurring prices** in **EUR**, tax behaviour **Exclusive**, tax code
`txcd_10103001` (inherit from the product):

| Product | Monthly HT | Yearly HT | Env (monthly) | Env (yearly) |
|---|---:|---:|---|---|
| Lite | 9 € | 90 € | `STRIPE_PRICE_LITE` | `STRIPE_PRICE_LITE_YEARLY` |
| Pro | 20 € | 200 € | `STRIPE_PRICE_PRO` | `STRIPE_PRICE_PRO_YEARLY` |
| Plus | 50 € | 500 € | `STRIPE_PRICE_PLUS` | `STRIPE_PRICE_PLUS_YEARLY` |
| Max ×5 | 100 € | 1 000 € | `STRIPE_PRICE_MAX` | `STRIPE_PRICE_MAX_YEARLY` |
| Max ×10 | 200 € | 2 000 € | `STRIPE_PRICE_MAX20` | `STRIPE_PRICE_MAX20_YEARLY` |
| Ultra | 500 € | 5 000 € | `STRIPE_PRICE_ULTRA` | `STRIPE_PRICE_ULTRA_YEARLY` |

- Monthly: *Recurring, every 1 month*. Yearly: *Recurring, every 1 year*.
- Pro, Max ×5 and Max ×10 already exist: **keep their monthly prices**; create
  a NEW yearly price at the ten-month amount and point the `*_YEARLY` env at it.
  Archive the old twelve-month yearly price in Stripe but do not delete it —
  existing annual subscribers keep it until they renew or switch, and the
  webhook never downgrades a price it does not recognise (it alerts instead).
- Copy each `price_…` id into the env var in the table. A tier with no price id
  is simply not offered for sale.

**Top-ups**: one product "Usage top-up" (or two), with two **one-off** prices in
EUR, tax behaviour **Exclusive**, tax code `txcd_10103001`:

| Price | HT | Env | Credit granted |
|---|---:|---|---:|
| Top-up 5 | 5 € | `STRIPE_PRICE_TOPUP_5` | 2,75 € of usage |
| Top-up 20 | 20 € | `STRIPE_PRICE_TOPUP_20` | 11 € of usage |

The credit is computed in code from the pack (55% of HT), not from the Stripe
amount, so keep these at exactly 5 € and 20 €. Top-ups accept no promotion
codes.

## 3. Customer portal

**Settings → Billing → Customer portal**:

- **Subscriptions → Customers can switch plans**: on. Add **all six products**
  and, on each, **both** prices (monthly and yearly), so any tier can move to any
  other at either interval. The webhook maps every one of the twelve prices back
  to its plan (`tests/stripe-webhook-plan-mapping.test.ts`).
- Proration: *Prorate charges and credits* for upgrades; downgrades may be
  scheduled *at the end of the billing period* (either works with the code: the
  plan changes when Stripe's subscription price changes).
- **Cancellations**: on, **at the end of the billing period** (the app shows
  "Access ends <date>" from `cancel_at_period_end`). Optionally collect a reason.
- **Payment methods, billing address, tax IDs, invoice history**: on.
- Business information → **Terms of service** `/legal/cgv`, **Privacy policy**
  `/legal/confidentialite`. Default return URL: `https://<app domain>/settings?section=billing`.

## 4. Webhook

**Developers → Webhooks → Add endpoint**: `https://<app domain>/api/stripe/webhook`,
then copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Subscribe to:

| Event | What the app does |
|---|---|
| `checkout.session.completed` | Subscription checkouts: link and sync the plan. **Payment** checkouts (top-ups): grant the credit when `payment_status` is `paid`. |
| `checkout.session.async_payment_succeeded` | A top-up paid by a delayed method (SEPA) has cleared: grant the credit. |
| `customer.subscription.created` | Sync plan, status, period end. |
| `customer.subscription.updated` | Same — this is how a portal upgrade/downgrade/interval switch reaches the app. |
| `customer.subscription.deleted` | Back to Free. |
| `invoice.paid` | A referred account's first paid subscription invoice rewards the referral (2 € of usage to each side). |
| `invoice.upcoming` | Annual-renewal notice (see §5). |

Every handler is idempotent: credits are keyed on the Checkout Session id or the
referral id, the referral row moves out of `pending` once, and renewal notices
are claimed per subscription period.

## 5. Annual renewal notice (loi Chatel, Code de la consommation L215-1)

French consumers on a tacitly renewing contract must be told, **no earlier than
three months and no later than one month** before the end of the term, that it
will renew, at what price, and how to stop it. The app emails each **annual**
subscriber once per term, in French and English, with the renewal date, the TTC
amount (from Stripe's invoice preview, so the buyer's own VAT and any discount
are included) and the link to Settings → Plan & usage.

Two triggers, one ledger (`RenewalReminder`), so the mail goes out once:

1. **`invoice.upcoming`**: **Settings → Billing → Subscriptions and emails →
   Upcoming renewal events**: set the lead time to the **longest option
   offered** (at least 32 days if available). The app only sends when the
   renewal is between 32 and 88 days away; an event outside that window is
   ignored.
2. **A sweep** in the app process every 12 hours (`src/lib/boot.ts` →
   `sweepRenewalReminders`) picks up any annual subscription inside the window
   that has not been told yet. This is what guarantees the notice if the
   dashboard lead time is shorter than a month or an event is lost. It runs in
   production when `STRIPE_SECRET_KEY` and `RESEND_API_KEY` are set;
   `RENEWAL_REMINDERS="off"` disables it.

You may leave Stripe's own *"Send emails about upcoming renewals"* off — it
duplicates this notice and does not state the cancellation route in the form
L215-1 asks for.

## 6. Environment checklist

```
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_{LITE,PRO,PLUS,MAX,MAX20,ULTRA}
STRIPE_PRICE_{LITE,PRO,PLUS,MAX,MAX20,ULTRA}_YEARLY
STRIPE_PRICE_TOPUP_5, STRIPE_PRICE_TOPUP_20
STRIPE_AUTOMATIC_TAX="true"
RESEND_API_KEY (renewal notices need mail)
```

## 7. Database

Run the migrations before (or with) the deploy that ships this code:

- `20261004120000_plan_lineup` — the LITE, PLUS and ULTRA plan labels.
- `20261004180000_usage_credits_referrals` — `UsageCredit`, `ReferralCode`,
  `Referral`, `RenewalReminder`, and `SpendPeriod.creditDrawnMicroUsd`.

Until the second one runs, credits read as zero (the chat path logs and carries
on with the plan budget alone) and top-up/referral grants fail in the webhook
(Stripe retries them, so they land once the migration is applied).

## 8. Smoke test (test mode)

1. Buy Lite monthly → plan shows Lite; open the portal, switch to Plus yearly →
   plan shows Plus within seconds.
2. Buy the 5 € top-up → Settings → Plan & usage → Top-ups shows 2,75 € credit.
3. Open `/r/<your code>` in a private window, sign up, buy Lite → both accounts
   show 2 € credit; the referrer's card shows "1 of 20".
4. With the Stripe CLI, `stripe trigger invoice.upcoming` against an annual test
   subscription whose period end is 32–88 days out (use a test clock) → one
   renewal email; trigger it again → no second email.
