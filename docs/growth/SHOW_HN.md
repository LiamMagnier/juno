# Show HN

Draft. The owner posts from his own HN account. HN rewards plain, technical, first-person writing and punishes marketing. No superlatives, no emoji, no "revolutionary". Do not ask anyone to upvote; do not post from multiple accounts.

## Title (≤ 80 characters)

Options:
1. `Show HN: Alevr – Claude, GPT and Gemini in one subscription, cost per reply` (75)
2. `Show HN: Alevr – a multi-model AI workspace built in France, per-reply costs` (76)
3. `Show HN: I built a Claude/GPT/Gemini workspace that shows what every reply costs` (80)

Recommended: **3** (first person, one concrete idea). Check the count is ≤ 80 before posting.

URL: the production homepage (not a sign-up wall). Note in the text that there is a free tier, so people can try without paying.

## Text

> I'm a solo developer in France. Alevr is the AI workspace I wanted: every top model (Claude, GPT, Gemini, GLM, Muse Spark, Grok, Mistral, DeepSeek… about 160 models from 14 labs) behind one subscription, with the cost of each reply shown under it.
>
> Some details that might interest HN:
>
> - **Billing is a usage budget, not a message count.** Each plan buys a monthly budget of model spend, paced by rolling 5-hour and 7-day windows. Every reply is priced from the lab's list rates, including prompt-cache reads and writes, which differ a lot by lab (Anthropic writes 1h cache at 2× input, GPT-6.1 Sol reads cache at 5% of input, GLM at ~19%). Getting this right mattered more than any UI work.
> - **The model catalog is curated by hand** with prices, context windows and 1–10 grades. Where Artificial Analysis has measured a model, grades are derived from its index; newer models carry an estimate, and the UI says which is which. The public comparison pages (/vs) render straight from that file, so they can't drift from what the app bills.
> - **Agents (Orbit)** have permissions per action: Allowed, Ask first or Blocked. A pending question never times out into a yes.
> - **Code** works on a repository and shows a diff you approve before anything is written.
> - **Hosting** is in France; messages are encrypted at rest; nothing is used for training. You can import ChatGPT/Claude exports and export everything.
> - There's a **native Mac app** (SwiftUI); iOS is coming.
>
> Pricing: a free tier with a small allowance on fast models; Lite €10.80/month; Pro €24/month incl. VAT unlocks every model, agents, research and Code. No lifetime deal.
>
> What I'd most like feedback on: whether the per-reply cost display is useful or just noise, and where the comparison pages get the data wrong.

## Prepared answers (have them ready, paste and adapt)

- **"Why not just use OpenRouter?"** OpenRouter is an API. Alevr is the workspace around it: chat, memory, research, agents, Code, a Mac app, and one bill with VAT handled for EU businesses.
- **"How can you afford every model for €24?"** Each plan includes a fixed budget of model spend (Pro: about 11 € of list-price usage a month). Heavy users move to Plus or Max. We don't subsidise unlimited use; that's why there's no "unlimited".
- **"Is my data sent to US labs?"** The workspace and your data are hosted in France. A prompt you send to Claude or GPT is processed by that lab under its API terms; check each lab's current API data policy before quoting it. Mistral, a French lab, is in the catalog for tasks where that matters. Be precise here; do not claim prompts never leave the EU.
- **"Open source?"** No. Say so directly.
- **"Team plan / SSO?"** Not yet. Say so directly.

## Timing
Weekday, 15:00–17:00 Paris (morning US East). Stay on the thread for 4 hours. Respond to criticism with facts or "you're right, noted".
