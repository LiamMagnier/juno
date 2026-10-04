# Channels

What to do where, in priority order. The owner creates every account and sends every application; nothing here has been submitted. Verify each programme's current terms on its own site before applying: they change, and nothing below is a quote of them.

| Channel | Audience | Effort | When | Owner action |
|---|---|---|---|---|
| /vs comparison pages (SEO) | People searching "Claude vs GPT…" | Done in code | Live at next deploy | Submit sitemap in Google Search Console and Bing Webmaster Tools |
| Product Hunt | Early adopters, makers | 1 day + prep | Week 3 | `PRODUCT_HUNT.md` |
| Show HN | Developers | 4 hours | Week 3, two days after PH | `SHOW_HN.md` |
| Reddit (r/macapps, r/ChatGPTPro, r/SideProject) | Power users, Mac users, makers | Ongoing | From week 2 | `REDDIT.md` |
| X + LinkedIn build in public | Makers (X), FR professionals (LinkedIn) | 2 posts/week | From day 1 | `LINKEDIN_X.md` |
| Indie Hackers | Bootstrapped founders | Low | Week 2 | Product page + one milestone post |
| French Tech | FR ecosystem, press, events | Medium | Week 2 | Join the local French Tech community; events |
| Malt | FR freelancers (ICP 1) | Low | Week 2 | Freelancer-facing content, not ads |
| Newsletters | Targeted readers | Medium | Week 3–4 | Pitch list below |
| Setapp | Mac users who subscribe to app bundles | High (review) | Apply week 2, decision later | Application notes below |
| B2B cold email | Agencies, consultancies, SMEs | 30 emails/day max | Week 2 onward | `COLD_EMAIL_B2B.md` |
| Referral programme | Existing users | Done in code (billing lane) | When `/r/<code>` ships | Copy below |

## SEO: the /vs pages
- 14 pages at `/vs/<pair>` plus the `/vs` index, in the sitemap, with canonical URLs and JSON-LD (WebPage + BreadcrumbList, CollectionPage on the index).
- After deploy: submit `<production URL>/sitemap.xml` in Google Search Console and Bing Webmaster Tools (owner's accounts), then request indexing for `/vs`.
- Add a pair when a new model ships: one line in `src/lib/compare/model-pairs.ts`; the test in `tests/compare-pages.test.ts` checks it.
- The pages are English. The site translates at runtime for French readers; dedicated French URLs (e.g. `/fr/comparatif/...`) would rank better in France and are the next SEO step.

## Setapp application notes
Setapp is a subscription bundle of Mac apps; developers are paid from the subscription pool according to usage. Points to settle **before** applying:
- **Cost model.** Alevr's cost is per reply (model spend). A Setapp user does not pay Alevr's plan, so a Setapp edition must carry its own usage budget sized to what Setapp pays out, or offer a limited model set (fast models) with an in-app upgrade to a full Alevr plan, if Setapp's rules allow it. Read Setapp's current developer terms on in-app purchases and external accounts first.
- **Build.** Setapp ships its own build with its licensing framework; that means a second Mac build target and release lane alongside the direct-download one.
- **Requirements to check**: notarized build, no separate account wall before value (or a Setapp-compatible sign-in), privacy policy, support contact, localisation.
- **Pitch**: "Every top AI model in one native Mac app, with agents and code review. Hosted in France." Lead with the Mac-native craft, which is what Setapp curates for.
- **Decision**: apply in week 2, but do not build the Setapp target until the economics are confirmed in writing.

## Indie Hackers
- Product page with revenue shown only if the owner is comfortable sharing it (IH's culture rewards real numbers).
- One post: "Pricing a multi-model AI app without losing money on every power user" (the budget model, the 55 % budget share, why no lifetime deal).
- Monthly milestone posts with the `METRICS.md` numbers.

## French Tech and the French ecosystem
- Join the local French Tech community (capital or regional); attend meetups with a laptop demo, not a deck.
- Angle for French press and newsletters: a French, GDPR-first alternative that still gives access to the American models, with data hosted in France.
- Bpifrance / French Tech programmes: look at eligibility for a Bourse French Tech or similar early-stage support (owner checks the current calls).

## Malt
Malt is a freelancer marketplace; the audience is ICP 1. Don't post ads disguised as missions.
- Write a practical guide for freelancers ("Using AI on client work without breaking GDPR") on the owner's own blog/LinkedIn and share it in Malt community spaces where allowed.
- Consider Malt's partner or perks programmes if they exist for tools (owner checks); a referral-style offer fits better than a discount.

## Newsletters (pitch, don't buy, until there is conversion data)
- FR: newsletters about tech, AI and freelancing (owner builds the list; check each one's sponsor/submission policy).
- EN: Mac app newsletters, AI tool roundups, indie maker newsletters.
- Pitch: one paragraph, one screenshot, one link to `/vs` or the homepage, the free tier mentioned.

## Referral programme
- Mechanics (billing lane): a code per user at `/r/<code>`; when the invited person subscribes, both get €2 of usage.
- Landing copy: `src/components/referral/referral-landing.tsx` ("A friend invited you. … You both get €2 of usage when you subscribe.").
- In-app placement: Settings › Plan, and after a user's 10th useful conversation, never as a pop-up.
- Measure the k-factor (`METRICS.md`).

## Why no lifetime deals
1. **Every reply has a marginal cost.** Alevr pays the model lab per token; a lifetime buyer's cost continues every month and the revenue does not.
2. **The heaviest users buy lifetime deals.** LTD platforms attract exactly the users whose usage is highest, so the loss concentrates.
3. **It forces a worse product later.** The only ways out are throttling lifetime users or degrading their models, which breaks the promise and the trust.
4. **It anchors the price at zero.** It teaches the market that Alevr is worth a one-off sum and makes the monthly plans look expensive.
5. **Better alternatives exist:** annual billing (two months free), the free tier, and referral credit.

Answer to "will you do an LTD?": "No. Every reply costs us real money at the model lab, so a lifetime price would mean either losing money or quietly degrading the product for you. Annual billing gives you two months free instead."
