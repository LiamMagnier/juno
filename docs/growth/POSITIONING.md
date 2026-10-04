# Alevr positioning

Drafts for the owner. Nothing here has been published. Every claim below is checked against the product as it ships on `pricing/growth` (2026-10-04). If a feature changes, change this file first and the channel copy after it.

## Fact sheet (the only claims copy may make)

| Claim | Source in the code |
|---|---|
| Claude, GPT, Gemini, GLM, Muse Spark, Grok, Mistral, DeepSeek, Kimi, Qwen and more, 160+ models from 14 labs | `src/lib/models.ts`, `MODELS_FLOOR` / `TOTAL_LABS` in `src/components/landing/lab-marquee.tsx` |
| Hosted in France, GDPR by default, encrypted at rest, conversations never used for training | homepage trust section (`src/components/home/home-page.tsx`) |
| Import ChatGPT or Claude history; export everything at any time | homepage, Free plan features |
| Alevr Orbit: persistent agents with a role, standing work, permissions (Allowed / Ask first / Blocked) and a record of each run | homepage Orbit section |
| Deep Field: deep research with cited sources | `src/lib/brand/names.ts`, homepage |
| Alevr Code: reads the repository, makes the change, runs the tests, shows the diff before anything lands | homepage Code section |
| Native Mac app (Chat and Code in one app) | `/download` |
| iPhone and iPad: **"on the App Store soon"**, not yet available. Do not say "iOS app" as if it can be downloaded today | `src/components/landing/platforms.tsx` |
| Every reply shows its estimated cost; the plan is a monthly usage budget paced by rolling 5-hour and 7-day windows | `src/components/landing/metering.tsx` |
| Memory you can read, edit and switch off; Projects, Library, Folio documents, voice, incognito | homepage bento |
| Connectors: Google Drive, Microsoft 365, GitHub, Notion, Figma, Apple apps, any MCP server, skills | homepage bento |

Never claim: SOC 2 / ISO certifications, "unlimited", "no limits", benchmark wins we have not measured, team or SSO features, an Android or Windows app, or that a model is "better" without a figure (use the /vs pages).

## Pricing (sold HT, shown to consumers TTC)

| Plan | HT / month | TTC / month (FR 20 %) | Annual (10 months for 12), TTC | What it unlocks |
|---|---|---|---|---|
| Free | 0 € | 0 € | — | A small allowance (about 0,20 € of model cost a month) on fast models: Claude Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash |
| Lite | 9 € | 10,80 € | 108 € | Everyday models (Claude Sonnet, Gemini Flash, GPT-6 Luna, GLM), web search, memory, canvas, uploads |
| Pro | 20 € | 24 € | 240 € | Every model, Code, agents (Orbit), deep research, voice |
| Plus | 50 € | 60 € | 600 € | 2.5× Pro's usage, higher priority |
| Max ×5 | 100 € | 120 € | 1 200 € | 5× Pro's usage |
| Max ×10 | 200 € | 240 € | 2 400 € | 10× Pro's usage |
| Ultra | 500 € | 600 € | 6 000 € | Agents running all day |

Rules: consumer-facing copy (Product Hunt, Reddit, X, videos) quotes **TTC**. B2B copy (cold email, LinkedIn to companies, Malt) may quote **HT** and must say "HT" / "excl. VAT". Never mix the two in one message.

## One-liners

- EN: **Every top model in one subscription. Claude, GPT and Gemini in one place, built in Europe.**
- EN (price-led, consumer): **Claude, GPT and Gemini in one subscription: €24 a month incl. VAT instead of paying for three.**
- EN (price-led, B2B): **Claude, GPT and Gemini for your team at €20 HT per seat instead of three subscriptions.**
- FR : **Tous les meilleurs modèles dans un seul abonnement. Claude, GPT et Gemini réunis, conçu en Europe.**
- FR (prix, particuliers) : **Claude, GPT et Gemini dans un seul abonnement : 24 € TTC par mois au lieu de trois.**
- FR (prix, entreprises) : **Claude, GPT et Gemini pour 20 € HT par mois au lieu de trois abonnements.**

On "instead of three": the comparison is with paying separately for ChatGPT, Claude and Gemini consumer plans (each roughly 20 € a month or more). Re-check their current EU prices on the day you post, and never say "same limits": Alevr's Pro is a usage budget, not a copy of each vendor's quota. If someone asks, say so plainly.

## Elevator pitch (30 seconds)

EN: Alevr is an AI workspace from France. One subscription gives you Claude, GPT, Gemini and 160+ other models, so you pick the right model for each job instead of paying for three apps. Around the models sit the things work needs: Orbit agents that keep going between conversations with permissions you set, Deep Field research with cited sources, Alevr Code for reviewable changes to a repository, memory you can edit, and a native Mac app. It is hosted in France, GDPR by default, and your conversations are never used for training. Plans start at €10.80 a month, and every reply shows what it cost.

FR : Alevr est un espace de travail IA conçu en France. Un seul abonnement donne accès à Claude, GPT, Gemini et plus de 160 autres modèles : vous choisissez le bon modèle pour chaque tâche au lieu de payer trois applications. Autour des modèles, ce dont le travail a besoin : des agents Orbit qui continuent entre deux conversations avec les autorisations que vous fixez, la recherche approfondie Deep Field avec sources citées, Alevr Code pour des modifications de code relues avant d'être appliquées, une mémoire modifiable et une app Mac native. Hébergé en France, RGPD par défaut, vos conversations ne servent jamais à l'entraînement. À partir de 10,80 € TTC par mois, et chaque réponse affiche son coût.

## Ideal customer profiles

### 1. EU freelancers and small businesses who need GDPR and more than one model
- Who: consultants, designers, lawyers' and accountants' small practices, marketing freelancers, 1–20 person companies in France, Belgium, Switzerland, Germany.
- Pain: they pay for ChatGPT and Claude separately, worry about client data leaving the EU, and cannot justify an enterprise contract.
- Message: one subscription, hosted in France, never trained on, invoice with VAT handled (EU businesses with a VAT number pay HT by reverse charge).
- Plan fit: Lite to Pro; Plus for heavy writers.
- Channels: LinkedIn FR, Malt, French Tech communities, accountants' and freelancers' newsletters, B2B email.

### 2. Developers who want Claude + GPT + Gemini in one place
- Who: indie developers, staff engineers, students in CS, people already using several labs' playgrounds.
- Pain: switching tabs and paying for three subscriptions to compare models on the same problem; opaque usage limits.
- Message: every model on one budget with the cost shown on every reply; Alevr Code with diffs you approve; a native Mac app; public model comparisons built from real prices (/vs).
- Plan fit: Pro to Max ×5.
- Channels: Show HN, r/ChatGPTPro, r/macapps, X build-in-public, Indie Hackers, the /vs SEO pages.

### 3. Agencies and consultancies
- Who: digital, content and SEO agencies; strategy and IT consultancies (5–200 people).
- Pain: client confidentiality, many deliverables (research, decks, documents), staff using personal AI accounts.
- Message: research with cited sources, agents that run standing work with Ask-first permissions, data hosted in France, one bill.
- Plan fit: Pro per person; Plus/Max for research-heavy roles. (No team admin console yet: don't promise one.)
- Channels: B2B cold email within CNIL rules (`COLD_EMAIL_B2B.md`), LinkedIn, Malt.

## What we say no to
- **No lifetime deals.** Every reply costs real model money; a lifetime deal sells a running cost for a one-off price. See `CHANNELS.md`.
- No "unlimited". The plan is a budget and we say so.
- No fake urgency, no fake scarcity, no invented testimonials.
