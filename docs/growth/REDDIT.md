# Reddit

Draft. The owner posts from his own long-standing account. Reddit punishes drive-by promotion: every subreddit below has its own self-promotion rules, and they change. **Read the sidebar and pinned rules of each subreddit on the day you post** and follow them over anything written here. The widely used rule of thumb is that most of your activity on Reddit should not be about your own product; build that history first (weeks, not hours).

General rules for every post
- Disclose: "I'm the developer" in the first lines.
- Give value that stands without clicking: numbers, lessons, a screenshot.
- One link at most, at the end, or only in a comment if the sub prefers.
- Reply to every comment for 24 hours; never argue, never use alt accounts, never ask for upvotes.
- Quote TTC prices ("incl. VAT").

---

## r/macapps

Fit: native Mac apps. They welcome developer posts that show the app and state price clearly; many posts get removed for missing price or for being web wrappers. Alevr's Mac app is native (SwiftUI), so say so and show it.

Check before posting: whether the sub requires a flair (e.g. "Developer"/"Promotion"), a pricing line, and how often a dev may post about the same app.

**Title:** `[Developer] Alevr – a native Mac app for Claude, GPT, Gemini and 160+ models, with agents and code review`

**Body:**
> I'm the developer. Alevr is a native Mac app (SwiftUI, not a web wrapper) for working with several AI models from one subscription. Chat and Alevr Code live in one window.
>
> What it does on the Mac:
> - Switch between Claude, GPT, Gemini, GLM, Muse Spark and others per message; every reply shows its estimated cost.
> - Alevr Code works on a local project: it makes a change, runs the tests and shows a diff you approve.
> - Orbit agents keep standing work going, with per-action permissions (Allowed / Ask first / Blocked).
> - Every published build lists its version, size and SHA-256 on the download page.
>
> Price: free tier with a small allowance on fast models; Lite €10.80/month; Pro €24/month incl. VAT for every model, agents, research and Code. No lifetime deal.
>
> Requires macOS 26. Hosted in France; conversations are never used for training.
>
> I'd love feedback on the Mac-specific details: keyboard shortcuts, window behaviour, what feels non-native.

Screenshots: the main window in light and dark, the model picker, a Code diff.

Caveat to check first: the download page shows a warning when a build is not notarized. **Do not post on r/macapps until the current build is notarized**; a Gatekeeper warning will sink the thread.

---

## r/ChatGPTPro

Fit: power users comparing models and workflows. Promotion is restricted; the safest format is a genuinely useful comparison or workflow post where the product is context, not the subject. Check whether the sub has a weekly self-promotion thread and use it if required.

**Title:** `I priced the same 1,000 requests on Claude Opus 5.5, GPT-6.1 Sol and Gemini 3.1 Pro at list prices – here's the table`

**Body:**
> I maintain a model catalog for an app I build, so I have every lab's list prices in one file. Here's what 1,000 chat turns of 800 input / 500 output tokens cost at list price, and what a coding turn costs once prompt caching is counted:
>
> *(paste the table from the /vs pages, e.g. Opus 5.5 $13.20 vs GPT-6.1 Sol $6.60 per 1,000 chat turns; coding turns of 20K input with 80% cache hits: $49.20 vs $24.60)*
>
> Things I didn't expect:
> - Cache pricing matters more than headline prices for long sessions. GPT-6.1 Sol and Claude Opus 5.5 both bill a cache hit at 5% of the input price, but Anthropic charges 2× input to write a one-hour cache, and GLM-5.3 bills a hit at about 19%.
> - Several new models (Opus 5.5, GPT-6.1 Sol) don't have independent benchmark scores yet, so any "which is smarter" claim about them is still an estimate.
>
> Disclosure: I'm the developer of Alevr, a multi-model workspace; the numbers come from its catalog and the full comparison pages are public (link in comments if allowed). Happy to share the method or correct any price that's out of date.

Re-run the figures from `/vs` on the day you post; prices change.

---

## r/SideProject

Fit: makers sharing what they built. Self-promotion is the point, but low-effort link drops are ignored. Tell the story and the numbers.

**Title:** `I built a multi-model AI workspace solo from France – what I learned pricing it honestly`

**Body:**
> I'm the developer. Alevr puts Claude, GPT, Gemini and ~160 models in one subscription, with agents, deep research, code review and a native Mac app.
>
> The hard part wasn't the UI, it was pricing:
> - Every reply costs real money, so plans are a monthly usage budget (Pro includes about €11 of list-price model usage for €20 excl. VAT), and every reply shows its cost.
> - I added a free tier (about €0.20/month of fast models) and a €9 Lite tier for people who only chat.
> - I said no to a lifetime deal: it sells a running cost for a one-off price.
> - EU VAT: prices are shown incl. VAT to consumers (legal requirement in France), businesses pay excl. VAT.
>
> Stack: Next.js, Postgres, SwiftUI for the Mac app, hosted in France.
>
> Feedback welcome, especially on the pricing page. Link: <production URL>

---

## After posting
Log each post in `METRICS.md`'s channel table (date, sub, link, upvotes, comments, sign-ups attributed via `?ref=` or `utm_source=reddit`).
