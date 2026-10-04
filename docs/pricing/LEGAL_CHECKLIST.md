# Legal checklist: selling Alevr in France and the EU

Written 4 October 2026 for the pricing rollout (Free at €0.20/month on cheap
models, Lite €9, Pro €20, Plus €50, Max ×5 €100, Max ×10 €200, Ultra €500,
all HT with 20% VAT added; Code from Pro). This is **not legal or tax
advice**. It records what each obligation is, what the code now does about
it, and who has to do the rest. Articles were checked against the
Code de la consommation as published on 1 October 2026 (codes.droit.org
edition of Légifrance) unless marked otherwise.

Status key:

- **CODE**: done in this branch (`pricing/legal`).
- **OWNER**: only the owner can do it (a fact, a signature, a registration).
- **LAWYER** / **ACCOUNTANT**: needs a qualified person before launch.
- **LANE**: another lane of the rollout has to build or show it (named).

## 0. Placeholders to fill (one file)

Every owner-only fact on the legal pages is read from
`src/lib/legal/seller.ts`. While a field is `null` the pages show
`[À COMPLÉTER : …]` in bold. Fill these fields there and every page updates:

| Field | Shown on | Note |
|---|---|---|
| `SELLER.name` | CGV, CGU, mentions, privacy | Company name, or first and last name for an entrepreneur individuel |
| `SELLER.legalForm` | CGV, mentions | SASU, EURL, EI… (see §1) |
| `SELLER.shareCapital` | CGV, mentions | Not applicable to an EI: write "Sans objet" |
| `SELLER.siren`, `SELLER.registry` | CGV, mentions, privacy | e.g. "RCS Paris", or "RNE" |
| `SELLER.address` | CGV (also the withdrawal form), mentions, privacy | Registered office |
| `SELLER.vatNumber` | CGV, mentions | FR + key + SIREN |
| `SELLER.email` | everywhere | Support, withdrawal, privacy and DSA contact unless overridden |
| `SELLER.phone` | CGV, mentions | LCEN and L221-5 ask for one |
| `SELLER.publicationDirector` | mentions | A natural person (the legal representative) |
| `MEDIATOR.name/address/website` | CGV art. 16, CGU, mentions | Only after signing with a CECMC-listed mediator (§3) |
| `PRIVACY_CONTACT` | privacy | Optional; defaults to `SELLER.email` |
| `DSA_CONTACT` | CGU art. 9, mentions | Optional; defaults to `SELLER.email` |
| `HOST.phone` | mentions | Microsoft Ireland's phone, from Microsoft's own legal notice |
| `DATABASE_HOST.address` | mentions | Supabase contracting entity address, from the DPA you sign |
| Backup rotation (privacy §6) | privacy | The number of days Supabase keeps backups on your plan; the page has its own `Fill` |

`SERVICE_HOST` is `chat.liams.dev`. Change it when Alevr has its own domain.

## 1. Company form and tax regime: ACCOUNTANT, OWNER

- **Micro-entreprise taxes turnover, not profit.** Income tax and social
  charges are computed on revenue after a flat allowance (34% for BNC, 50%
  for BIC services), whatever the real costs are. With model costs around 55%
  of revenue (the budgets in `src/lib/spend.ts` are ~55% of the HT price),
  this overtaxes the business. It also caps turnover.
- **A SASU or EURL is taxed on profit** (corporate tax, IS; reduced rate on
  the first band of profit for SMEs), so model costs, hosting and Stripe fees
  are deducted. That suits this cost structure. The choice between SASU
  (president is "assimilé salarié") and EURL (TNS manager) is a social-charges
  question for an accountant.
- Whatever the form: the legal pages need the identifiers in §0.
- Sources: [service-public.fr, devenir micro-entrepreneur](https://entreprendre.service-public.fr/vosdroits/F23961), [service-public.fr, impôt sur les sociétés](https://entreprendre.service-public.fr/vosdroits/F23575).

## 2. VAT, OSS and Stripe Tax

| Item | Status |
|---|---|
| Prices stored HT, displayed TTC at 20% (`src/lib/price-display.ts`) | **CODE** (commit 96f3305c) |
| CGV art. 4 explains FR 20%, other EU consumers at their country's rate, reverse charge only for businesses in **another** EU state | **CODE** |
| The VAT note no longer says "EU businesses pay HT": a French business pays French VAT | **CODE** (`vatNote()` fixed) |
| Opt out of the VAT franchise (art. 293 B CGI) if eligible, since you charge VAT | **ACCOUNTANT** |
| Register for the **OSS** (guichet unique) on impots.gouv.fr to declare other EU consumers' VAT quarterly | **OWNER**, with the accountant. Below €10,000 a year of EU cross-border B2C sales, French VAT may be applied to everyone; above it, the buyer's rate applies. Stripe Tax applies the buyer's rate. Decide which. |
| Stripe Tax: add the French registration and the OSS registration in the Stripe dashboard, set the product tax code (SaaS / electronically supplied services), keep prices "exclusive" | **OWNER** |
| Set `STRIPE_AUTOMATIC_TAX` in production so checkout collects the address and VAT number | **OWNER** |
| Invoice mentions (seller identity, VAT numbers, HT/VAT/TTC per rate, "Autoliquidation" for reverse charge) — set in Stripe invoice settings | **OWNER**, **ACCOUNTANT** |

Sources: [impots.gouv.fr, guichet unique TVA (OSS)](https://www.impots.gouv.fr/professionnel/jutilise-le-guichet-unique-tva-ioss-oss), [EU VAT e-commerce rules](https://vat-one-stop-shop.ec.europa.eu/index_en), [Stripe Tax docs](https://docs.stripe.com/tax).

## 3. Consumer law

| Obligation | Article | Status |
|---|---|---|
| Consumer prices shown TTC | L112-1; Dir. 98/6/EC | **CODE** (price-display, CGV art. 4). **LANE (pricing UI)**: every price surface must use `displayPrice()`; Settings → Plan & usage still prints "a month, excluding VAT" with the HT figure (`src/components/settings/sections/billing.tsx`) |
| Pre-contractual information (identity, characteristics, price, duration, cancellation, withdrawal, guarantees, mediator) | L111-1, L221-5 | **CODE**: `/legal/cgv`. **OWNER**: §0 placeholders |
| CGV with prices generated from `PLANS` so they cannot drift | — | **CODE** (`src/app/(legal)/legal/cgv/page.tsx`) |
| Checkout: CGV acceptance + express request to start now + acknowledgment | L221-25, L221-28 1° | **CODE**. The checkbox wording was **corrected**: a subscription is a digital *service*, so the right of withdrawal is lost only once the service is *fully performed* (1°), and a consumer who withdraws within 14 days owes a pro-rata amount (L221-25). The old text said the right was lost "once it has started", which is the 13° rule for digital *content* and does not apply. |
| Point the Stripe "Terms of service" URL at `/legal/cgv` | — | **OWNER** (Stripe dashboard → Settings → Public details) |
| **Confirmation on a durable medium** after purchase: the contract terms (the CGV themselves, as a PDF attachment or full text, not a link) and the express request/acknowledgment | L221-13 | **LANE (billing backend)**: the welcome/receipt email sent on `checkout.session.completed` must include it. A link alone is not a durable medium (CJEU C-49/11). Not done. |
| Withdrawal handling: refund within 14 days minus the pro-rata share, by the same payment method | L221-24, L221-25 | **OWNER** (manual refund in Stripe) or **LANE (billing)** if automated. CGV art. 10 describes it. |
| Model withdrawal form | L221-5, annex to R221-1 | **CODE** (CGV annex) |
| Legal guarantee of conformity, with the mandatory framed text | L224-25-12 to -26; D211-4 annex III | **CODE** (CGV art. 11, verbatim, "X" = the contractual supply period) |
| Online cancellation, "résilier votre contrat"-type label, recap, notification button, confirmation on durable medium | L215-1-1; D215-1 to D215-3 | **CODE**: `src/components/settings/cancel-subscription.tsx` + `/api/stripe/cancel` + bilingual confirmation email. **LANE (pricing UI)**: mount `<CancelSubscription />` in the plan header of Settings → Plan & usage, beside "Change plan" (see §4). |
| Notice ≤ 10 days, unless the consumer asks for later | L224-25-9 | **CODE**: the dialog has the person choose the end of the paid period (their request for a later date); CGV art. 9 offers an earlier end with pro-rata refund via support. **LAWYER**: confirm this reading for monthly plans. |
| Annual plans: loi Chatel renewal notice, by dedicated email, 3 to 1 month before the non-renewal deadline, with the deadline in a visible box | L215-1 | **LANE (billing backend)**: the reminder email. It must be a dedicated email (not a newsletter), sent in that window (e.g. 45 days before renewal), with the date in a bordered box. If it is not sent, the customer may cancel free at any time after renewal and get the unused advance back within 30 days (CGV art. 8 already says so). |
| Reproduce L215-1 to L215-3 and L241-3 in the contract | L215-4 | **CODE** (CGV art. 18). **LAWYER**: Légifrance tags L215-3/L215-4 and L241-3 with "Conseil constit. 2026-1189 QPC"; check whether that 2026 decision changed anything. |
| Monthly plans and Chatel | L215-1 | **LAWYER**: whether a month-to-month contract is "conclu pour une durée déterminée avec reconduction tacite" needing a monthly notice. Common practice says the online cancellation and the end-of-period rule suffice; get an opinion. |
| Archive contracts ≥ €120 for 10 years and give access | L213-1, D213-1/2 | **OWNER**: Stripe keeps the invoice; also keep the CGV version in force at each purchase (git history is the record: tag each change). |
| Consumer mediator: sign with a mediator **listed by the CECMC**, show name, address and website | L612-1, L616-1, R616-1 | **OWNER**. Placeholders in CGV art. 16, CGU, mentions. List: [economie.gouv.fr, médiateurs référencés](https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/choisir-un-mediateur-de-la-consommation/mediateurs-references). There is no sector mediator for AI software; general-purpose mediators (associations or companies listed by the CECMC) take e-commerce/SaaS for an annual fee. |
| EU ODR platform link | Reg. 524/2013 | **Removed.** The platform closed on 20 July 2025 and the obligation to link to it was repealed (Reg. (EU) 2024/3228). The CGV says so and points to the European Consumer Centre France for cross-border disputes. |
| No consumer liability cap | R212-1 6° | **CODE**: the CGU used to cap liability at 12 months of fees for everyone, a blacklisted clause against consumers; the cap now applies to business customers only. |
| Service changes (model removed by a provider) | L224-25-26 | **CODE** (CGV art. 12: reasons, no extra cost, advance notice on durable medium, free termination within 30 days if the impact is more than minor). **OWNER**: actually send that notice when a provider's whole line-up leaves a plan. |
| Price increases | R212-1 3° | **CODE** (CGV art. 8: 30 days' notice, next period only, free cancellation before; annual price never changes mid-term). |
| Top-ups (€5 / €20, usage credit valid 12 months) and referral credit (€2 each side) | — | **CODE**: CGV art. 6 describes them without hard-coding amounts. **LANE (billing/UI)**: show the TTC price and the usage it buys before purchase; top-ups go through the same checkout consent text (express request + acknowledgment) since they are the same kind of service. **LAWYER**: whether the 12-month expiry of a paid credit is enforceable against consumers. |
| App Store subscriptions | — | **CODE**: CGV art. 9/10 and the cancel control send these to Apple. |

## 4. Cancellation flow audit

What exists today, before this branch:

- Settings → **Plan & usage** shows the plan with two buttons, **Change plan**
  (to `/upgrade`) and **Manage billing**, which POSTs `/api/stripe/portal`
  and redirects to the Stripe customer portal
  (`src/components/settings/sections/billing.tsx`,
  `src/app/api/stripe/portal/route.ts`). `/upgrade` also sends "Downgrade" to
  Free through the same portal.
- In the portal, cancellation is possible **only if it is switched on** in
  the Stripe dashboard (Settings → Billing → Customer portal → "Cancel
  subscriptions"). That is not visible from the code. **OWNER**: check it is
  on, set to "At end of billing period".
- Click count: Settings → Plan & usage → Manage billing → (portal) Cancel
  plan → Confirm. About four clicks after opening settings, and the word
  "cancel" appears nowhere in the app: it is behind "Manage billing". That
  falls short of D215-1 ("résilier votre contrat" or an unambiguous
  equivalent, directly reachable).

What this branch adds:

- `src/components/settings/cancel-subscription.tsx`: a **Cancel
  subscription** button (destructive outline), a dialog with the recap D215-3
  asks for (name, email, plan, reference = Stripe subscription id, end date),
  and one **Notify cancellation** button. Two clicks from the section. When a
  cancellation is pending it shows the end date and **Keep my subscription**.
  App Store subscriptions get a link to Apple's subscription settings.
- `src/app/api/stripe/cancel/route.ts`: GET (recap) and POST
  (`cancel` / `resume`), which set `cancel_at_period_end` on the Stripe
  subscription, update the row, and send the confirmation email.
- `src/lib/cancellation.ts` + `tests/legal-cancellation.test.ts`: the
  bilingual confirmation (receipt, end date, effects).

**Where to mount it (LANE: pricing UI):** in `BillingSection`, inside the
`features.billing && quota.plan !== "FREE"` branch, after the **Manage
billing** button:

```tsx
import { CancelSubscription } from "@/components/settings/cancel-subscription";
// …
<CancelSubscription />
```

It renders nothing for a Free account. The French catalogue needs entries
for its strings ("Cancel subscription" → "Résilier votre abonnement",
"Notify cancellation" → "Notifier la résiliation", "Keep subscription",
"Keep my subscription", and the recap labels): run `npm run i18n:extract`
after mounting.

Not built: an in-app "end it now with a refund" option (it would issue Stripe
refunds automatically). Today that goes through support (CGV art. 9).

## 5. GDPR

| Item | Status |
|---|---|
| Privacy notice lists every processor from `docs/SUBPROCESSORS.md` (Azure, Supabase, Stripe incl. Stripe Tax, Resend, Tavily, Composio, voice providers, Apple) and every model provider read from `PROVIDERS`, with country and transfer mechanism | **CODE** (`/legal/confidentialite`) |
| Billing/VAT data (address, country, VAT number) and referral data added | **CODE** |
| **Record of processing activities** (art. 30). The <250-employee exemption does not apply: the processing is not occasional. Use the CNIL template | **OWNER**. [CNIL, registre](https://www.cnil.fr/fr/RGDP-le-registre-des-activites-de-traitement) |
| **DPA (art. 28) with every processor**: Microsoft (Online Services DPA), Supabase, Stripe, Resend, Tavily, Composio, Deepgram, ElevenLabs, and each model provider's API data-processing terms | **OWNER**: sign or accept each; keep copies |
| **Transfers**: US providers, check each is certified under the EU-US Data Privacy Framework ([dataprivacyframework.gov list](https://www.dataprivacyframework.gov/list)), otherwise SCCs. The 7 PRC-based providers (Zhipu, Moonshot, DeepSeek, MiniMax, Xiaomi MiMo, Alibaba Qwen, Meituan LongCat) and ByteDance: SCCs + transfer impact assessment, and whether each will actually sign SCCs is a fact to establish | **OWNER** + **LAWYER**. The privacy page states the intended safeguard; if a provider will not sign, remove it from the picker for EU users or disclose the transfer without safeguard (art. 49 is not a basis for routine transfers) |
| Retention periods in the notice (logs 12 months, referral 3 years after the programme, reports 1 year, prospects 3 years, invoices 10 years) need **purge jobs**; nothing deletes logs, reports or referral rows on a schedule today | **OWNER** decision, then a code task |
| Backup rotation period | **OWNER** (§0) |
| AI-generated media metadata carries no personal data (tool name only) | **CODE** |
| DPO: not mandatory at this scale (art. 37); the contact email serves | **CODE** (privacy §1) |

## 6. Email prospecting (CNIL)

- **B2C**: prior, specific, opt-in consent (unticked box) before any
  marketing email, except the "soft opt-in" for existing customers about
  similar products, with an easy opt-out in every message (CPCE L34-5).
  Accepting the CGU is not consent.
- **B2B**: no prior consent needed if the message relates to the person's
  profession, they were told their address would be used, and every message
  lets them object.
- Transactional emails (receipts, cancellation confirmation, the Chatel
  reminder) are not prospecting; keep marketing out of them, especially the
  Chatel reminder, which must be "dedicated".
- **OWNER**: if a newsletter or win-back email is planned, add a consent
  checkbox at sign-up (not pre-ticked) and an unsubscribe link.
- Sources: [CNIL, prospection par courrier électronique](https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique-sms-mms-et-automate-dappel).

## 7. Cookies and analytics

No analytics SDK, essential cookies only, no banner (correct: nothing needs
consent). **Rule**: adding analytics means adding a consent banner in the
same change, with "Refuse" as easy as "Accept". Status: **CODE** (privacy §8
says so). Source: [CNIL, cookies](https://www.cnil.fr/fr/cookies-et-autres-traceurs).

## 8. AI Act (Regulation (EU) 2024/1689)

Article 50 applies from **2 August 2026**. Secondary sources report that the
Digital Omnibus left art. 50 in place but gave generative systems already on
the market before that date until **2 December 2026** for the
machine-readable marking of art. 50(2); **LAWYER** to confirm against the
published text.

| Item | Status |
|---|---|
| 50(1): people know they are talking to an AI | Obvious from the product; the "can be wrong" footer stays. **CODE** (existing) |
| 50(2): generated **images** marked in machine-readable form | **CODE**: `src/lib/ai-content-marking.ts`, called in `/api/generate` before upload. PNG (iTXt XMP + tEXt `ai-generated`), JPEG (APP1 XMP), WebP (VP8X + XMP chunk), IPTC `DigitalSourceType` = `trainedAlgorithmicMedia` (`compositeWith…` for edits), no re-encode, files with a provider C2PA manifest left untouched. Tests: `tests/ai-content-marking.test.ts` (sharp reads the XMP back, pixels identical). |
| 50(2): generated **video and audio** | **Not done.** Returned as the provider made them. Google (Veo, Lyria) embeds SynthID at source; OpenAI adds C2PA to its images. For the others nothing marks the file. Doing it properly means writing an XMP `uuid` box into MP4 / ID3 tags into MP3 with a real muxer (or signing C2PA manifests with c2patool and a certificate). **Code task + LAWYER** on whether the provider's marking satisfies the deployer's duty. |
| 50(2): generated **text** | **Not done.** No reliable technique; the Commission's code of practice on marking is the reference to follow. **LAWYER**. |
| Visible label on generated media in the app | **CODE**: plain "AI-generated" caption under media from image/video/audio models in chat (`message-item.tsx`). Not yet on the public share page or in the Library grid (**LANE / follow-up**). |
| 50(4): deep fakes disclosed by whoever publishes them | **CODE**: CGU art. 8 puts that duty on the user and forbids stripping the marking. |
| Role: is Alevr a "provider" of a generative AI system (it builds the system around third-party GPAI models) or only a deployer? | **LAWYER** |

## 9. DSA (Regulation (EU) 2022/2065)

Public share links and published artifacts make Alevr a hosting service for
that content.

| Item | Status |
|---|---|
| Notice-and-action (art. 16): a Report link on every public page (`/share/[token]`, which also serves publications), anonymous, rate-limited, reasons + detail + optional email, admin queue at `/admin/links` | **Existing** (`src/components/share/report-share-dialog.tsx`, `src/lib/share-moderation.ts`) |
| Good-faith statement (art. 16(2)(d)) | **CODE**: one line added to the report form |
| Acknowledge receipt and tell the notifier the decision (art. 16(4)-(5)) when they left an email | **Not done**: reports with a contact address get no automatic acknowledgment or outcome email. Code task. |
| Statement of reasons to the content owner on takedown (art. 17) | **Existing**: the owner gets a notification with the reason. **Follow-up**: it should also say how to contest it (reply to the DSA contact); CGU art. 9 now says so. |
| Points of contact for authorities and users (art. 11-12), languages stated | **CODE**: mentions légales §4 and CGU art. 9 (placeholder `DSA_CONTACT`, defaults to the seller email) |
| Terms describe moderation (art. 14) | **CODE**: CGU art. 7 and 9 |
| Online-platform obligations (art. 19 onward) | Micro and small enterprises are exempt (art. 19), as long as Alevr stays under the thresholds. **LAWYER** to confirm whether public links make it an "online platform" at all. |

## 10. E-invoicing and e-reporting (France)

Verified on impots.gouv.fr:

- **Since 1 September 2026** every VAT-registered business must be able to
  **receive** electronic invoices through an approved platform
  (plateforme agréée, PA). **OWNER**: pick a PA and sign with it now; supplier
  invoices (Azure, Stripe fees, model providers established in France) will
  arrive through it.
- **From 1 September 2027** SMEs and micro-enterprises must **issue** B2B
  invoices to French businesses electronically, and transmit **e-reporting**
  data: B2C sales (transaction data, aggregated) and B2B sales to foreign
  customers, plus payment data for services. Stripe's invoices are not
  e-invoices in this sense; the PA (or an integration with it) will have to
  ingest Stripe's sales data. **OWNER** + **ACCOUNTANT**: choose a PA that can
  take a Stripe export or API feed. Code task later, not before the PA is
  chosen.
- Sources: [impots.gouv.fr, facturation électronique et plateformes agréées](https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees), [guide pratique du 1er septembre 2026 (PDF)](https://www.impots.gouv.fr/sites/default/files/media/1_metier/2_professionnel/EV/2_gestion/290_facturation_electronique/guide_pratique_facturation_electronique.pdf).

## 11. Trademark "Alevr": OWNER

- Run a clearance search first (INPI base marques, EUIPO eSearch/TMview) for
  "Alevr" and close variants in classes **9** (software), **42** (SaaS, AI
  services) and possibly **35** and **38**.
- File at **INPI** (France only) or **EUIPO** (whole EU); an EU mark is the
  natural choice for an EU-wide product. Also secure the domain(s).
- "Orbit" and "Continuum" (product names in use) are generic words; check
  them too before investing in them as brands.
- Sources: [INPI](https://www.inpi.fr) (dépôt de marque, base marques), [EUIPO](https://www.euipo.europa.eu/en/trade-marks) (EU trade mark, eSearch).

## 12. Provider terms review: LAWYER

Alevr resells model access under one subscription
(`docs/OPEN_DECISIONS.md` item 5). For each provider in
`docs/SUBPROCESSORS.md`, check: (a) the API terms allow building a
consumer-facing product on top and charging for it; (b) no restriction on
"competing" products or on resale; (c) the usage policy you must pass on to
users (the CGU refers to them generally); (d) data use (no training on API
data, retention); (e) the DPA and transfer terms; (f) EU availability.

| Provider | Terms to read | Status |
|---|---|---|
| Anthropic | Commercial Terms + Usage Policy | open |
| OpenAI | Services Agreement + Usage Policies | open |
| Google (Gemini API, Veo, Lyria) | Gemini API Additional Terms (the paid tier only for EU users) | open |
| Mistral | Commercial terms | open |
| Meta (Muse) | API terms | open |
| xAI (Grok) | Enterprise/API terms | open |
| ByteDance (Seedance) | BytePlus terms | open |
| Zhipu (GLM), Moonshot (Kimi), DeepSeek, MiniMax, Xiaomi (MiMo), Alibaba (Qwen), Meituan (LongCat) | Each international API's terms; check that EU personal data is permitted at all | open |
| Tavily, Composio, Resend, Deepgram, ElevenLabs, Supabase, Stripe | Standard SaaS terms + DPA | open |
| **Microsoft Azure** | The production VM runs on an "Azure for Students" subscription. Check that the offer permits commercial production use; if not, move to a pay-as-you-go subscription before selling | **OWNER, urgent** |

## 13. What the other lanes must show

- **Pricing UI** (upgrade, settings, landing): TTC prices via
  `displayPrice()` everywhere, `vatNote()` under each price list, a link to
  `/legal/cgv` next to the checkout buttons (the upgrade page links CGU and
  privacy today, not the CGV), mount `<CancelSubscription />` (§4), and fix
  the HT line in Settings → Plan & usage. Top-up and referral screens: TTC
  price, usage obtained, 12-month validity, and a link to CGV art. 6.
- **Billing backend**: the post-purchase confirmation email with the CGV
  attached and the consent repeated (L221-13); the Chatel reminder for annual
  plans (dedicated email, 3–1 months before, deadline in a box); top-up
  checkout with the same consent text as subscriptions; withdrawal refunds
  pro rata (manual is fine to start).
- **Owner**: §0, §1, §2, the mediator, the PA, the trademark, the Azure
  subscription, the DPAs, the record of processing, the Stripe portal and
  Stripe Tax settings.

## 14. Needs a lawyer before launch (summary)

1. Read the CGV, CGU and privacy notice end to end.
2. The withdrawal mechanics for a subscription service (L221-25 pro rata
   computed by days) and for usage credits.
3. Chatel for monthly plans; the 2026-1189 QPC on L215-3/L215-4.
4. L224-25-9 and "end of period" cancellations.
5. Whether paid credit can expire after 12 months.
6. AI Act role (provider vs deployer), the video/audio/text marking gap, and
   the Digital Omnibus grace period.
7. DSA classification (hosting service vs online platform).
8. Transfers to PRC providers; provider resale terms.

## Needs an accountant

1. Company form (SASU/EURL vs micro) and when to switch.
2. VAT franchise opt-out, OSS registration, the €10,000 threshold choice.
3. Invoice mentions in Stripe; the approved e-invoicing platform and the
   2027 e-reporting feed from Stripe.
