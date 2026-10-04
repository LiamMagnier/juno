# App Store products

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
