# App Store products — October 2026 lineup

The server maps these ids in `src/lib/billing/app-store.ts` (`APP_STORE_PRODUCT_IDS`);
`tests/app-store-lineup.test.ts` fails if this file and that map drift apart. The
native lane uses the same list for StoreKit (`JunoStoreKit.swift`).

Product ids keep the `com.liammagnier.juno.` prefix: an App Store product id can
never be renamed or reused, so the Alevr rename does not touch them.

## Subscription group

All twelve products go in ONE auto-renewable subscription group (e.g. "Alevr
plans") so a subscriber moves between tiers as an upgrade/downgrade/crossgrade
instead of holding two subscriptions. Group levels, highest service first:

| Level | Tier |
|------:|------|
| 1 | Ultra |
| 2 | Max ×10 (`max20`) |
| 3 | Max ×5 (`max`) |
| 4 | Plus |
| 5 | Pro |
| 6 | Lite |

Monthly and yearly of the same tier share a level.

## Products

App Store prices are tax-inclusive in the EU storefronts. The targets below are
the French TTC price (HT × 1.20); pick the nearest App Store price point.
Yearly is ten months for twelve (two months free), as on the web.

| Product id | Plan | Interval | Web HT | Target TTC (FR) |
|---|---|---|---:|---:|
| `com.liammagnier.juno.lite.monthly` | LITE | month | 9 € | 10,80 € |
| `com.liammagnier.juno.lite.yearly` | LITE | year | 90 € | 108 € |
| `com.liammagnier.juno.pro.monthly` | PRO | month | 20 € | 24 € |
| `com.liammagnier.juno.pro.yearly` | PRO | year | 200 € | 240 € |
| `com.liammagnier.juno.plus.monthly` | PLUS | month | 50 € | 60 € |
| `com.liammagnier.juno.plus.yearly` | PLUS | year | 500 € | 600 € |
| `com.liammagnier.juno.max.monthly` | MAX | month | 100 € | 120 € |
| `com.liammagnier.juno.max.yearly` | MAX | year | 1 000 € | 1 200 € |
| `com.liammagnier.juno.max20.monthly` | MAX20 | month | 200 € | 240 € |
| `com.liammagnier.juno.max20.yearly` | MAX20 | year | 2 000 € | 2 400 € |
| `com.liammagnier.juno.ultra.monthly` | ULTRA | month | 500 € | 600 € |
| `com.liammagnier.juno.ultra.yearly` | ULTRA | year | 5 000 € | 6 000 € |

New in this lineup: `lite.*`, `plus.*`, `ultra.*`. The `pro.*`, `max.*` and
`max20.*` products already exist; only their yearly price changes (it was
twelve months, it is now ten).

Apple keeps 15–30% of an App Store sale, so the same plan nets less there than
on the web. The plan budget is the same on both (55% of the web HT price); that
is a deliberate choice to keep one entitlement per tier, not an oversight.

Top-up packs and referral rewards are web-only (Stripe). An App Store
subscriber can still buy a top-up on the web: the top-up route creates a
Stripe customer for them on first purchase.
