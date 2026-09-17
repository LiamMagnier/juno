# Open decisions

Items from the pre-production review that are **not** code problems. Each is a
choice only the owner can make, or a question that needs someone qualified.
Recorded here so they stop living in a review document nobody re-reads.

Everything else from that review has been implemented; see the branch history.

---

## 1. Consumer prices are displayed excluding tax (review item 60)

`/upgrade` and `/settings` render `20 €` with the suffix **`HT/mo`** — *hors
taxes*, a B2B convention. EU consumer law (Directive 98/6/EC; French Code de la
consommation art. L112-1) requires prices shown to consumers to be **TTC**,
tax included.

**Why this is not fixed in code:** the correct display depends on a fact only
you know, and getting it wrong misstates a price.

- **If you charge VAT** — the displayed figure must become the TTC amount
  (`20 €` HT at 20% is `24 €` TTC). Changing the suffix alone would be worse
  than the status quo: it would state a price you do not charge.
- **If you are under the VAT franchise** (micro-entrepreneur, art. 293 B CGI) —
  no VAT is charged, the correct display is a plain `20 €`, and invoices must
  carry *"TVA non applicable, art. 293 B du CGI"*.

`/legal/mentions-legales` still has an unfilled `[N° TVA]` placeholder, so the
answer is not inferable from the repo. The CGU currently asserts *"la TVA
applicable est ajoutée au moment du paiement"*, which is consistent with the
first case.

Once you know which: the strings are `priceSuffix` in
`src/app/(app)/upgrade/page.tsx`, one line in `src/app/(app)/settings/page.tsx`,
`src/components/landing/pricing.tsx`, and the CGU price table.

---

## 2. Does Free get any messages at all? (review item 7)

`PLANS.FREE.monthlyMessages` is `0` and `BUDGET_EUR.FREE` is `0`, so a Free
account can never produce a model reply. The UI is now honest about it — the
composer is gated, the banner says so, and the feature list no longer advertises
things a Free account cannot reach.

What remains is a pricing question: **every hosted competitor's free tier sends
messages.** A small monthly allowance on the cheapest model would cost little
and removes the "I couldn't try it" objection entirely.

If you want it, the change is one number in `src/lib/plans.ts` plus a non-zero
`BUDGET_EUR.FREE` — but check the interaction first: a nonzero Free budget must
not accidentally unlock voice (`PLANS.FREE.voice` is false), web search, video
generation, or scheduled tasks.

---

## 3. Is there a tier under €20? (review item 49)

Annual billing now exists, deliberately with **no discount** — twelve months for
twelve months' price, one invoice instead of twelve, and the page says exactly
that.

Still open: nothing is sold below €20/month. ChatGPT Go is $8, Gemini AI Plus
$4.99, Poe $4.99, Chatbox $3.99, Grok Lite $10. Against Juno's actual
competitive set — multi-provider clients, not ChatGPT — €20 is 2.5–5.7× the
cheapest rivals, and they all let you try first.

That is a positioning decision, not a defect.

---

## 4. Should "Code" be called Code, and should it be a sidebar item?
(review item 51) — **DECIDED, September 2026**

**Yes to the sidebar item; Code keeps its name.** The decision and its reasoning
are `docs/design/TWO_PRODUCTS.md`; this entry records that it is closed and what
was actually settled, because the question as asked was not quite the question.

Code is one of the two products in the sidebar's switcher, at ⌘⇧2, with its own
column — its sessions in date folds, a **Needs you** fold above them, and its own
Customize page. It kept the name because renaming a surface is cheap to do and
expensive to undo, it invalidates every screenshot, doc and support answer, and
the market study this item cited is a snapshot of a convention that is still
forming. The runtime was always the asset.

What the item did not ask, and what the answer turned on: the surface those
eight incumbents promoted is not Code, it is the **async agent** — and Juno
already had it, as Work, as a third top-level product. The reference the item
was written against has since gone the other way: Anthropic folded Cowork back
into Claude on 16 September 2026, on the argument that a person should not have
to decide, before typing, whether their sentence belongs in a conversation or in
an agent workspace. Juno did the same. Work is now what a conversation does when
the ask is big — armed from the composer's `+` menu, drawn in the transcript,
listed in the sidebar as an ordinary chat with a status — and the `/work` routes
redirect. Two products, not three, and the runtime under both is unchanged.

---

## 5. Do the provider terms permit reselling? (review item 63)

**This one is a real business risk, not a formality, and it needs a lawyer.**

Juno resells access to fourteen model providers under a single subscription.
Whether each provider's terms permit that without a commercial agreement is a
question of fact per provider, and a single provider objecting removes a model
from the picker overnight.

`docs/SUBPROCESSORS.md` has the verified list to review against.

---

## 6. The repository has no license (review item 64)

`LICENSE` is a marked TODO. Under the Berne Convention the default is
all-rights-reserved: nobody may copy, modify or redistribute, and no grant
attaches to any contribution. That may be exactly what you want for a commercial
product — but it is currently an accident rather than a decision, and the file
says so out loud.

---

## 7. Other AI Act / GDPR items (review item 64)

- **AI Act Art. 50 transparency.** The *"Juno can be wrong"* footer is a good
  start. Generated images and video should also be disclosed as AI-generated.
- **Data residency.** The database is `eu-west-1`, but inference goes wherever
  the chosen provider is, and Qwen realtime voice goes to Alibaba Cloud
  Singapore. There is no region selector. See `docs/SUBPROCESSORS.md`.
- **No cookie banner, on purpose.** Juno sets essential cookies only (the
  session) and there is genuinely no analytics SDK in the tree, so there is
  nothing to consent to; the banner that used to ask anyway contradicted its
  own copy and was removed in September 2026. Adding analytics later means
  adding consent back at the same time.

---

## Not a decision — a known scaling limit (review item 39)

Recorded here so it is not rediscovered as a bug.

Two pieces of state are per-process and in memory:

- `src/lib/generation-cancel.ts` — the active-generation map that
  `POST /api/chat/cancel` looks in.
- `src/app/api/i18n/translations/route.ts` — the translation cache.
- (Also `provider-health.ts` and `platform-budget.ts`, both added since, both
  documented as such in place.)

With **one** PM2 instance, which is what runs today, all of this is correct.
With more than one, `cancel` reaches the wrong process and returns
`{ ok: true, cancelled: false }` — a silent no-op. The fix when it is needed is
Postgres `LISTEN/NOTIFY`, or a `generationId → cancel` row the streaming loop
polls. Do not add a second instance without doing that first.
