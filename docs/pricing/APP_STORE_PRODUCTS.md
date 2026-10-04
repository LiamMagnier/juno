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

## Swift side

The pricing/billing lane owns the server map and the product table (ids, group
levels, target TTC prices) in this file; this section is what the apps do with
the same twelve ids.

- `native/Packages/JunoNativeKit/Sources/JunoAPI/StoreKit/JunoStoreKit.swift`:
  `JunoStoreKitProductIDs` lists all twelve as constants and as a
  product-to-(plan, interval) map, mapped exactly (never by substring, since
  `max20` contains `max`). `JunoSubscriptionTier` gains `lite`, `plus` and `ultra`.
  A server answer naming a plan the build does not know is kept
  (`JunoSubscriptionState.plan`) and is never shown as Free.
- `native/StoreKit/Alevr.storekit`: a local StoreKit configuration with all
  twelve products in one group (level 1 Ultra … level 6 Lite), on the French
  storefront. The iOS `JunoMobile` scheme runs with it (project.yml
  `storeKitConfiguration`), so the plans page can be tried in the simulator
  without App Store Connect.
- iPhone: the plans page (`JunoMobilePlans.swift`) buys through StoreKit and
  posts the signed transaction to `POST /api/v1/billing/app-store`. When the
  App Store has no products for the build (no App Store Connect setup yet), the
  page shows catalogue prices and says in-app purchase is not available; a plan
  bought on the web still works in the app.
- Mac: the Upgrade sheet keeps Stripe checkout in the browser (the Mac app is
  not distributed through the Mac App Store).
- `tests/native-storekit-products.test.ts` holds the Swift ids and the local
  StoreKit file to the twelve.

| Product id | Plan | Period | Level | Suggested App Store price (EUR, TTC) |
|---|---|---|---:|---:|
| `com.liammagnier.juno.lite.monthly` | Lite | 1 month | 6 | 10,99 € |
| `com.liammagnier.juno.lite.yearly` | Lite | 1 year | 6 | 107,99 € |
| `com.liammagnier.juno.pro.monthly` | Pro | 1 month | 5 | 23,99 € |
| `com.liammagnier.juno.pro.yearly` | Pro | 1 year | 5 | 239,99 € |
| `com.liammagnier.juno.plus.monthly` | Plus | 1 month | 4 | 59,99 € |
| `com.liammagnier.juno.plus.yearly` | Plus | 1 year | 4 | 599,99 € |
| `com.liammagnier.juno.max.monthly` | Max ×5 | 1 month | 3 | 119,99 € |
| `com.liammagnier.juno.max.yearly` | Max ×5 | 1 year | 3 | 1 199,99 € |
| `com.liammagnier.juno.max20.monthly` | Max ×10 | 1 month | 2 | 239,99 € |
| `com.liammagnier.juno.max20.yearly` | Max ×10 | 1 year | 2 | 2 399,99 € |
| `com.liammagnier.juno.ultra.monthly` | Ultra | 1 month | 1 | 599,99 € |
| `com.liammagnier.juno.ultra.yearly` | Ultra | 1 year | 1 | 5 999,99 € |

The suggested prices are the nearest x,99 € price point under each French TTC
target (10,80 / 24 / 60 / 120 / 240 / 600 € a month; ten months for a year).
Lite's 10,80 € has no exact point, so 10,99 € is the one rounding up. Check in
App Store Connect that each point exists for auto-renewable subscriptions in
your price schedule; the 5 999,99 € yearly Ultra is near the top of Apple's
range. Apple keeps 15–30% of each sale, so these prices earn less than the web.

### What the owner sets in App Store Connect

1. One auto-renewable subscription group (for example "Alevr plans") with the
   levels above; the new products are `lite.*`, `plus.*` and `ultra.*`.
2. For each product: reference name, display name and description, the price
   point (base country France, then let Apple equalise or set other storefronts),
   and the review screenshot (the plans page).
3. The App Store Server Notifications URL and the server's App Store
   environment variables, as in the billing lane's setup notes.
