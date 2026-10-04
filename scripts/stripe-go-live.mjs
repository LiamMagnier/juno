#!/usr/bin/env node
/**
 * Switch a deployment's Stripe to LIVE mode, on the server, without any
 * secret leaving it.
 *
 *   node scripts/stripe-go-live.mjs --env ~/juno/.env --publishable pk_live_…            dry run
 *   node scripts/stripe-go-live.mjs --env ~/juno/.env --publishable pk_live_… --apply    do it
 *
 * Refuses unless STRIPE_SECRET_KEY in that file is a live key (sk_live_ or
 * rk_live_). Then, idempotently (prices are found again by lookup key):
 *   1. every plan's monthly and yearly price (HT EUR from src/lib/plans.ts,
 *      yearly = ten months, VAT added on top: tax_behavior "exclusive")
 *   2. the two top-up packs (one-off)
 *   3. the webhook endpoint for /api/stripe/webhook with the events the route
 *      handles; its signing secret goes straight into the env file
 *   4. the payment-method domain, so Apple Pay and Google Pay can show
 *   5. NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (needs a rebuild: it is inlined)
 * The env file is backed up first. Ids are printed, secrets never.
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envPath = (opt("--env") ?? `${process.env.HOME}/juno/.env`).replace(/^~/, process.env.HOME);
const publishable = opt("--publishable") ?? "";
const apply = args.includes("--apply");
const appUrl = opt("--app-url") ?? "https://chat.liams.dev";

const raw = fs.readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  raw.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")])
);
const KEY = env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_live_/.test(KEY)) {
  console.error("STRIPE_SECRET_KEY in that file is not a live key. Put the sk_live_ key there first. Nothing was changed.");
  process.exit(1);
}
if (!/^pk_live_/.test(publishable)) {
  console.error("--publishable must be the pk_live_ key. Nothing was changed.");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

// HT EUR a month, as src/lib/plans.ts and src/lib/credits.ts set them.
const PLANS = { LITE: ["Lite", 9], PRO: ["Pro", 20], PLUS: ["Plus", 50], MAX: ["Max ×5", 100], MAX20: ["Max ×10", 200], ULTRA: ["Ultra", 500] };
const TOPUPS = { 5: 5, 20: 20 };
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.upcoming",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

const updates = {};
const say = (line) => console.log(apply ? line : `[dry run] ${line}`);

async function product(plan, name) {
  const found = (await api("GET", `products/search?query=${encodeURIComponent(`metadata['alevr_plan']:'${plan}'`)}`)).data[0];
  if (found) return found.id;
  if (!apply) return "(new product)";
  return (await api("POST", "products", { name: `Alevr ${name}`, "metadata[alevr_plan]": plan, tax_code: "txcd_10103001" })).id;
}

async function price(lookup, make) {
  const found = (await api("GET", `prices?lookup_keys[]=${lookup}&active=true`)).data[0];
  if (found) return { id: found.id, reused: true };
  if (!apply) return { id: "(new)", reused: false };
  return { id: (await make()).id, reused: false };
}

for (const [plan, [name, eur]] of Object.entries(PLANS)) {
  const productId = await product(plan, name);
  for (const interval of ["month", "year"]) {
    const amount = eur * 100 * (interval === "year" ? 10 : 1);
    const lookup = `alevr_${plan.toLowerCase()}_${interval}`;
    const p = await price(lookup, () =>
      api("POST", "prices", {
        product: productId,
        currency: "eur",
        unit_amount: String(amount),
        "recurring[interval]": interval,
        tax_behavior: "exclusive",
        lookup_key: lookup,
        "metadata[alevr_plan]": plan,
        nickname: `${name} ${interval === "year" ? "yearly" : "monthly"}`,
      })
    );
    updates[`STRIPE_PRICE_${plan}${interval === "year" ? "_YEARLY" : ""}`] = p.id;
    say(`${name} ${interval}: ${amount / 100} EUR HT ${p.reused ? "(already there)" : "(created)"}`);
  }
}

for (const [pack, eur] of Object.entries(TOPUPS)) {
  const productId = await product(`TOPUP_${pack}`, `top-up ${eur} EUR`);
  const lookup = `alevr_topup_${pack}`;
  const p = await price(lookup, () =>
    api("POST", "prices", { product: productId, currency: "eur", unit_amount: String(eur * 100), tax_behavior: "exclusive", lookup_key: lookup, nickname: `Top-up ${eur} EUR` })
  );
  updates[`STRIPE_PRICE_TOPUP_${pack}`] = p.id;
  say(`Top-up ${eur}: ${p.reused ? "(already there)" : "(created)"}`);
}

// The webhook: one endpoint for this URL. Stripe only reveals a signing
// secret at creation, so an existing endpoint we did not just make is
// replaced rather than guessed at.
const url = `${appUrl}/api/stripe/webhook`;
const existing = (await api("GET", "webhook_endpoints?limit=100")).data.filter((w) => w.url === url);
if (apply) {
  for (const w of existing) await api("DELETE", `webhook_endpoints/${w.id}`);
  const body = { url, description: "Alevr" };
  EVENTS.forEach((e, i) => (body[`enabled_events[${i}]`] = e));
  const created = await api("POST", "webhook_endpoints", body);
  updates.STRIPE_WEBHOOK_SECRET = created.secret;
}
say(`Webhook ${url}: ${existing.length ? "replaced" : "created"} (${EVENTS.length} events)`);

const domain = new URL(appUrl).hostname;
if (apply) {
  try {
    await api("POST", "payment_method_domains", { domain_name: domain });
  } catch (e) {
    if (!/already/i.test(String(e.message))) throw e;
  }
}
say(`Apple Pay / Google Pay domain: ${domain}`);

updates.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = publishable;

if (!apply) {
  console.log(`[dry run] would set in ${envPath}: ${Object.keys(updates).join(", ")}`);
  process.exit(0);
}
fs.copyFileSync(envPath, `${envPath}.bak-${Date.now()}`);
let next = raw;
for (const [k, v] of Object.entries(updates)) {
  const line = `${k}=${v}`;
  next = new RegExp(`^${k}=.*$`, "m").test(next) ? next.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${next.replace(/\n?$/, "\n")}${line}\n`;
}
fs.writeFileSync(envPath, next, { mode: 0o600 });
console.log(`Set in ${envPath} (backup beside it): ${Object.keys(updates).join(", ")}. Redeploy to build the publishable key in.`);
