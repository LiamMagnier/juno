# Growth metrics, measured without third-party analytics

Alevr's promise is privacy, so its growth numbers come from its own database and its own server, not from a tracking SDK. Most of what matters is already in Postgres; one small event table (proposed below, **not built yet**) fills the gaps.

## Definitions

| Metric | Definition | Target (first 90 days) |
|---|---|---|
| **Activation** | Share of new accounts that, within 7 days of sign-up, send at least 3 messages on 2 different days. | ≥ 35 % |
| **Free → paid conversion** | Share of accounts created in a cohort week that hold a paid plan (`Subscription.plan` not FREE, status ACTIVE or TRIALING) 30 days later. | ≥ 4 % |
| **Paid churn (monthly)** | Paid subscriptions at the start of a month that are CANCELED, or set `cancelAtPeriodEnd`, by its end ÷ paid subscriptions at the start. | ≤ 6 % |
| **Cost per user** | Sum of `ApiSpend.costMicroUsd` per user per month (model spend at list price), split by plan. | Within the plan's budget share (below) |
| **Gross margin per plan** | (HT revenue − model spend − payment fees − allocated infrastructure) ÷ HT revenue, per plan, per month. | ≥ 40 % on every paid plan |
| **Referral k-factor** | Invitations sent per paying user × share of invitations that become paying users. | ≥ 0.2 by day 90 |
| **Channel yield** | Sign-ups and paid conversions per channel (PH, HN, Reddit, LinkedIn, X, email, /vs pages, referral). | Ranked monthly |

## Gross margin by plan (from the code)

Each plan's monthly model budget is **55 % of its HT price** (`BUDGET_EUR` in `src/lib/spend.ts`, with 1 USD of list-price spend counted as 1 EUR by default, `eurPerUsd()`):

| Plan | HT price | Model budget (max spend) | Margin before fees and infra, if the whole budget is used |
|---|---|---|---|
| Free | 0 € | 0,20 € | −0,20 € per active free user (acquisition cost) |
| Lite | 9 € | 5 € | 4 € (44 %) |
| Pro | 20 € | 11 € | 9 € (45 %) |
| Plus | 50 € | 27,50 € | 22,50 € (45 %) |
| Max ×5 | 100 € | 55 € | 45 € (45 %) |
| Max ×10 | 200 € | 110 € | 90 € (45 %) |
| Ultra | 500 € | 275 € | 225 € (45 %) |

That is the **worst case**: most users spend well under their budget, so the real margin is higher. Subtract card fees (check the current Stripe EU rate on the owner's account; for small amounts the fixed part matters, so Lite's fee share is the highest) and infrastructure (VM, database, storage, email) divided by paying users. Free users are acquisition cost: watch `free_users × 0,20 €` against new paid conversions each month.

Prompt caching, batch APIs and context trimming lower model spend per reply; their effect shows up directly as lower cost per user at the same budget.

## Queries on what already exists

Run read-only, on a replica or during low traffic. Tables are the Prisma model names.

```sql
-- Sign-ups per week
SELECT date_trunc('week', "createdAt") AS week, count(*) FROM "User" GROUP BY 1 ORDER BY 1;

-- Activation: ≥3 user messages on ≥2 distinct days within 7 days of sign-up
WITH msgs AS (
  SELECT c."userId", m."createdAt"
  FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
  WHERE m.role = 'USER'
)
SELECT date_trunc('week', u."createdAt") AS cohort,
       count(*) AS users,
       count(*) FILTER (WHERE a.n >= 3 AND a.days >= 2) AS activated
FROM "User" u
LEFT JOIN LATERAL (
  SELECT count(*) AS n, count(DISTINCT date_trunc('day', msgs."createdAt")) AS days
  FROM msgs WHERE msgs."userId" = u.id AND msgs."createdAt" < u."createdAt" + interval '7 days'
) a ON true
GROUP BY 1 ORDER BY 1;

-- Free → paid at day 30, by cohort week (current plan as the proxy)
SELECT date_trunc('week', u."createdAt") AS cohort,
       count(*) AS users,
       count(*) FILTER (WHERE s.plan <> 'FREE' AND s.status IN ('ACTIVE','TRIALING')) AS paid
FROM "User" u LEFT JOIN "Subscription" s ON s."userId" = u.id
WHERE u."createdAt" < now() - interval '30 days'
GROUP BY 1 ORDER BY 1;

-- Cost per user per month, by plan (micro-USD → USD)
SELECT date_trunc('month', a."createdAt") AS month, coalesce(s.plan::text, 'FREE') AS plan,
       count(DISTINCT a."userId") AS users,
       round(sum(a."costMicroUsd") / 1e6 / nullif(count(DISTINCT a."userId"), 0), 2) AS usd_per_user
FROM "ApiSpend" a LEFT JOIN "Subscription" s ON s."userId" = a."userId"
GROUP BY 1, 2 ORDER BY 1, 2;
```

Caveat: `Subscription` holds the **current** state only, so churn and conversion over time need history. That is what the event table below adds. Column names match `prisma/schema.prisma` as of 2026-10-04; re-check after migrations.

## Proposed: a first-party `GrowthEvent` table (not built)

One row per business event, written server-side where the event already happens. No cookies, no client SDK, no IP addresses, no user agent.

| Field | Notes |
|---|---|
| `id`, `createdAt` | |
| `userId` | nullable for anonymous page events |
| `name` | `signup`, `first_message`, `activated`, `plan_changed`, `subscription_canceled`, `referral_invite_sent`, `referral_converted`, `checkout_started` |
| `props` | JSON: `{ from, to }` for plan changes, `{ campaign, source }` from `utm_*` or `ref` captured at sign-up |

Write points: sign-up (auth), Stripe webhook (plan changes, cancellations), the chat route (first message), referral redemption (billing lane). Retention: aggregate monthly, delete raw rows after 25 months.

## Page traffic without consent banners

Two options, in order of preference:
1. **Server-side counts with no identifier.** Count requests to public pages (`/`, `/vs/*`, `/download`, `/sign-up`) in the server log or a counter table, by path, day and `utm_source`/referrer host. No cookie, no personal data: no consent needed.
2. **A CNIL-exempt audience tool** (for example Matomo self-hosted, configured per the CNIL's audience-measurement exemption: strictly first-party, anonymised, no cross-site tracking, limited cookie lifetime and data retention; check the CNIL's current conditions and the tool's CNIL configuration guide). This allows unique-visitor counts without a consent banner.

Never add Google Analytics, Meta Pixel or similar to the product or the public site: they require consent in France and contradict the positioning.

## Weekly dashboard (one spreadsheet, every Monday)

| Week | Visits (public) | Sign-ups | Activated % | New paid | Free → paid % (d30 cohort) | Paid churn % | Model spend / paying user | Gross margin % | Referral invites | Referral paid | Top channel |
|---|---|---|---|---|---|---|---|---|---|---|---|

And one channel log row per post or send: date, channel, link, reach (views/upvotes), sign-ups attributed, paid attributed.
