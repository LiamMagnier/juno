# Open decisions

Items from the pre-production review that are **not** code problems. Each is a
choice only the owner can make, or a question that needs someone qualified.
Recorded here so they stop living in a review document nobody re-reads.

Everything else from that review has been implemented; see the branch history.

---

## 1. Consumer prices are displayed excluding tax (review item 60) — **DECIDED, October 2026**

**The owner charges VAT (20%).** Prices stay HT in `PLANS` (that is what
Stripe charges, with Stripe Tax adding the buyer's VAT: French rate in France,
the buyer's own rate for other EU consumers under OSS, reverse charge for
businesses in another EU state). Every price a person sees goes through
`displayPrice()` in `src/lib/price-display.ts` and is shown **TTC** with
`vatNote()` under it (commit 96f3305c). The CGU price table is gone; the
contract of sale is `/legal/cgv`, whose prices are computed from `PLANS` so
they cannot drift (branch `pricing/legal`).

Still open, and tracked in `docs/pricing/LEGAL_CHECKLIST.md` §2–3: the OSS
registration and Stripe Tax settings (owner), and one remaining HT line in
Settings → Plan & usage (pricing-UI lane).

---

## 2. Does Free get any messages at all? (review item 7) — **DECIDED, October 2026**

**Yes: about €0.20 of model cost a month, on cost-1 models only** (Claude
Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash). `BUDGET_EUR.FREE` is 0.2 in
`src/lib/spend.ts` and `modelRequiredPlan()` admits Free only to models the
catalogue prices FREE *and* marks cost 1. Voice, web search, Code, agents and
research stay paid, which was the interaction this item warned about. The CGV
(art. 3) describes the Free offer.

---

## 3. Is there a tier under €20? (review item 49) — **DECIDED, October 2026**

**Yes: Lite at €9 HT** (€10.80 TTC), fast everyday models plus web search, no
Code or agents. The line-up is now Free, Lite €9, Pro €20, Plus €50, Max ×5
€100, Max ×10 €200, Ultra €500 (all HT). Annual billing is **ten months for
twelve** (`ANNUAL_MONTHS_BILLED`), replacing the earlier no-discount annual
price. Code and agents start at Pro.

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

## 7. Other AI Act / GDPR items (review item 64) — **partly done, October 2026**

- **AI Act Art. 50 transparency.** Done for images: `/api/generate` writes an
  IPTC XMP "AI-generated" marking into every PNG, JPEG and WebP it saves
  (`src/lib/ai-content-marking.ts`), and generated media in chat carries a
  plain "AI-generated" caption. **Not done:** video and audio files (left as
  the provider made them; Google's carry SynthID), text, and the caption on
  public share pages and in the Library. See
  `docs/pricing/LEGAL_CHECKLIST.md` §8.
- **Data residency.** Unchanged: the database is `eu-west-1` and the app runs
  on Azure Sweden Central, but inference goes wherever the chosen provider is.
  The privacy notice now lists every provider with its country and the
  intended transfer safeguard; whether each will sign SCCs (and the seven
  PRC-based ones in particular) is still a fact to establish. Checklist §5.
- **No cookie banner, on purpose.** Still true and still correct: essential
  cookies only. Adding analytics means adding consent in the same change.

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
