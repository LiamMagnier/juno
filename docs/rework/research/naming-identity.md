# Naming and identity research: "Crew", "Juno", and the Orbital Precision palette

> **Current direction, 2026-10-01:** See [the Alevr V3 brand package](../brand/README.md). This dated research/brief remains historical evidence. Its keep-Juno/Crew and old font/icon recommendations do not govern the new proposed identity. D-027 restores Newsreader; D-028 establishes custom icons; D-033/D-034 govern material and agent characters. Alevr remains a working concept with availability unresolved.

Phase 0 research for Juno Refoundation. Researched 2026-09-30 on branch `rework/refoundation` (same as main @ 1feb392c).
Scope: (1) renaming persistent Agents to "Crew", (2) collisions on the name "Juno", (3) brand colour and type landscape, and whether an ultramarine or ion-blue primary can be owned.

How to read the evidence labels:
- **First-party** means the vendor's own page, docs, trademark office record or agency case study.
- **Press** means reputable press, used only to fill gaps.
- **Aggregator** means third-party brand or token scrapers (loftlyy, oh-my-design and similar). Treat these as indicative, not authoritative.
- **UNVERIFIED** means I could not confirm the claim this session.
- Trademark notes are search signals only, not legal advice. Clearance needs counsel.

---

## 1. Summary

1. **The persistent-agent category got its names in August–September 2026, and every leader names the individual rather than the group.** SpaceXAI named its agents "Bots" (with "Team Bots" and a "Chief of Staff" Bot, launched 2026-08-11). OpenAI's are "dots" (launched 2026-09-29: "start with your primary dot, give it a name"). Meta's is "Muse" (launched 2026-09-08: "their Muse"). If Juno adopts a collective noun ("Crew"), individuals still need to be addressed by name everywhere events happen.
2. **"Teammate" and "team" are now category clichés.** Lindy, Zapier ("AI teammates", "dream team"), Asana ("AI Teammates") and Grok Bot ("AI teammates") all use them. Juno's own copy uses "teammate" too (`src/components/agents/agent-hire.tsx:329`). Those words cannot differentiate Juno. "Team" also collides with plan tiers (Claude "Team") and would make "Juno Team" read like a company email sign-off.
3. **"Crew" is not free, but no one owns it for consumer assistants.** The main collisions are:
   - CrewAI, whose core noun is a "crew" of agents. It holds CREWAI registrations at EUIPO, WIPO and Benelux; its US application was abandoned.
   - **AWS "Kiro Crew"**, an open-source persistent-agent workspace launched 2026-08-04.
   - crew.you, "Crew — Your Personal AI Agent".
   - "Crewmate" (Among Us).
   - About 26 USPTO marks that combine "crew" with AI goods.

   **Recommendation: adopt "Crew" as a lowercase collective noun inside the product ("your crew", sidebar "Crew", "Add to Crew").** Do not make it a standalone sub-brand ("Juno Crew™"), never use "crewmate", and always name the individual in events ("Mira needs you"). If counsel objects, fall back to the status-quo "Agents", not "Team".
4. **Keep "Juno".** No single collision is a strong factual reason to rename. The one to watch is **"JUNO AI"**, registered at USPTO (Reg. 8419089, class 42, AI SaaS for legal practice support). Juno must never call itself "Juno AI", and should get class 9/42 clearance before filing anything.
5. **Juno's current identity is effectively Claude's.**
   - Background `48 24% 97.2%` renders as #faf9f6. Claude's ivory is #faf9f5 (ΔE_ok 0.13, perceptually identical).
   - Primary `15 54% 46%` renders as #b55636. That is the same OKLCH hue (38.9° vs 38.8°) and chroma as Claude's clay #d97757, only darker.
   - Add the serif greeting on warm paper (`src/app/layout.tsx:19`) and the result reads as a Claude reskin. This is the strongest argument for the Orbital Precision pivot.
6. **Blues are crowded, but one band is open among AI assistants.** Deep ultramarine at **OKLCH h 266–271°, L 0.44–0.50, C 0.19–0.22** (for example #2A3FC9 or #2E44D0) sits outside two occupied clusters:
   - The Meta, Google/Gemini, Apple, Facebook and Zoom cluster at h 255–263°.
   - The Linear, Discord, Stripe and Teams "blurple" cluster at h 273–280° and L ≥ 0.54.

   Hue alone is never ownable. Tailwind indigo-700 is ΔE 3.1 away, so ownership has to come from lightness, restraint and the rest of the system.
7. **An amber signal works only as meaning, never as brand.** Use OKLCH h 73–78°, L 0.63–0.68 (#B87A0A to #C98A12), reserved for "needs you". It must not become a dot or pill (owner rule), and it stays clear of Claude clay and Mistral orange.
8. **Typography: leave Inter and Newsreader behind as brand faces.**
   - Inter is shared with Linear and (per aggregators) Mistral. Newsreader has no Cyrillic, although Juno ships `ru` and `uk`.
   - Three OFL pairings fit Juno's 20 locales and clone no AI brand: IBM Plex Sans + Plex Mono; Geologica + Source Serif 4 + JetBrains Mono; Commissioner + Literata + JetBrains Mono.
   - Avoid Google Sans/Flex (Gemini's face, now OFL), Geist (Vercel/v0 ubiquity) and Space Grotesk (same designer as Perplexity's FK Grotesk, heavily overused).
9. **The patterns worth adopting all respect the owner's rules.**
   - Grok Bot puts agent state *in the avatar* (idle / working / waiting / blocked / thinking / done), with hover revealing the current action. That is presence without pills.
   - OpenAI offers per-action "allow / require approval / block" Custom Rules, a single Activity View, and read-only "proactive research".
   - Meta routes anything that reaches the internet through a separate approving "Sentinel".
10. **Secondary collision flagged: Juno's "Work" now shares a name with "ChatGPT Work"** (OpenAI, launched 2026-07-09). Also, Juno's search User-Agent advertises `https://juno.app` (`src/lib/search/search-engine.ts:662`), but that domain redirects to a GoDaddy for-sale page.

---

## 2. Findings by capability

### 2.1 Naming the persistent-agent feature ("Crew")

#### (a) What exists today

**How the leading persistent-agent products name things (first-party unless marked):**

| Product | Individual noun | Collective / structure | Creation verb | Source (date) |
|---|---|---|---|---|
| OpenAI dots | "dot" ("your dot", "primary dot") | "teams of dots" (future); "specialist dots"; "ChatGPT Space" for humans + dots | "Create your dot", "give it a name", "let it introduce itself" | openai.com/index/introducing-dots (2026-09-29) |
| SpaceXAI Grok Bot | "Bot" (name, avatar, title) | "Team Bot" (shared); "Chief of Staff" Bot coordinating specialists; "group chat" | "Create new Bot", "Create "name" Bot", "Publish to team" | x.ai/news/introducing-grok-bot (2026-08-11); docs.x.ai/grok-bot/bots; docs.x.ai/grok-bot/team-bots; x.ai/news/designing-grok-bot (2026-09-03) |
| Meta Muse | "Muse" ("their Muse") | single personal agent; "Sentinel agent" approves | "tell Muse what needs to get done" | about.fb.com/news/2026/09/introducing-muse-personal-ai-agent (Sept 2026); Wikipedia: launched 2026-09-08 |
| Lindy | "AI teammate", "AI employee" | none (avoids collective nouns) | — | lindy.ai (read 2026-09-30) |
| Zapier | "agents", "AI teammates" | "dream team" | "Create specialized agents" | zapier.com/agents (read 2026-09-30) |
| Asana | "AI Teammates" | — | — | Business Wire (2025-09-25) |
| Relevance AI | agents | "AI Workforce", "team of agents" | "Deploy your first team of agents" | relevanceai.com (read 2026-09-30) |
| Microsoft | agents | "Copilot Cowork"; "Agent 365" governance | — | Fortune (2026-03-09, press); OpenAI dots page (Agent 365 integration) |

**Every "Crew" collision found:**

| Collision | What it is | Why it matters | Source (date) |
|---|---|---|---|
| **CrewAI** | Agent framework plus enterprise "Agent Management Platform". Defines "A crew … represents a collaborative group of agents working together". Its homepage claims "65% of Fortune 500" and "450M+ agentic workflows" monthly. | Owns the developer mindshare for "crew = group of agents" and "crew members". | docs.crewai.com/en/concepts/crews; crewai.com (read 2026-09-30); Wikipedia (first release Dec 2023, $18M Oct 2024) |
| **Kiro Crew (AWS)** | Open-source (Apache 2.0) persistent agent workspace with memory, skills, schedules and subagents. Kiro's docs describe it as "An open-source personal AI agent … persistent, self-learning, and self-evolving". Internally "MeshClaw"; 39,000+ Amazon developers. | Same category as Juno Agents, from a hyperscaler. "Juno Crew" pattern-matches "Kiro Crew". | kiro.dev/docs/crew; InfoQ (2026-08-30, press); launch 2026-08-04 per Swami Sivasubramanian on X |
| **crew.you** ("Crew — Your Personal AI Agent", by AI3) | Consumer personal AI agent across messengers; Free to $99/month; "founded 2026" per page schema. | Direct consumer collision on the bare word. | crew.you (read 2026-09-30) |
| **Crew (Crew Systems)** | "AI-powered employee self-service" HR app, iOS 2025-04-10. | App Store search noise. | apps.apple.com id6760766435 |
| **Square Team (ex-Crew)** | Square bought the Crew team-messaging app in 2021, and it became Square Team Communication. | Historic "Crew" = team messaging. | squareup.com press; Square community |
| **Among Us "Crewmate"** | The game's default role. Innersloth still ships "Crewmate roles" in 2025–26. | Rules out "crewmate" as Juno's singular. | innersloth.com news |

**Trademark signals. Searched live on USPTO Trademark Search and on TMview (EUIPO's aggregator of EU and national offices):**

- **CREWAI at USPTO:** serial 98425496, classes 009/042, filed 2024-02-28. Status is **DEAD/ABANDONED 2025-01-06**, "applicant failed to respond … to an Office action". The office action's content is UNVERIFIED.
- **CREWAI elsewhere (TMview):** registered at **EUIPO** (application 2024-05-15, classes 9 and 42), **WIPO** (7, 9), **Benelux** (7, 9) and **Brazil** (9). A further EUIPO filing from 2024-11-14 is pending.
- **USPTO query `CM:crew AND GS:"artificial intelligence"` returns 26 marks.** Live examples:
  - CREWIQ (Cast & Crew LLC; class 42 "virtual assistant software", pending)
  - GROUNDCREW AI (pending)
  - POCKETCREW (AI, pending)
  - PROFITCREW (AIaaS, pending)
  - DIGITAL CREW (Thales, registered)
  - SAMSUNG BOT CREW (registered)
  - PITCREW AI (registered)
  - TASKCREW.AI (abandoned)
- **Wordmark "crew", Live, coordinated class 009: 843 results.**
- **TMview, "Kiro Crew": no marks found.**

My reading, not legal advice: "crew" is a crowded, weak element in US software classes, and many composites coexist. The EU is different, because CREWAI is registered in 9/42. A bare "CREW" filing by Juno would be hard. Using "crew" as a descriptive in-product noun carries lower risk than filing "JUNO CREW".

#### (b) The user problem

People need one word for "the persistent helpers I own". That word goes in navigation, notifications, creation flows and settings. It has to:
- make clear these are durable (unlike a chat),
- make clear they act (unlike a prompt),
- make clear they belong to you (unlike a marketplace).

A non-technical user should understand it without a tooltip.

#### (c) Does Juno already solve it?

Today the feature is "Agents": the sidebar label (`src/components/app/app-sidebar.tsx:1233`) and copy such as "New agent" and "Your agents" (`src/components/agents/agent-hire.tsx:328`, `src/components/agents/agents-home.tsx:81`). The explanatory copy says "A teammate with its own brief, goals and memory…" (`agent-hire.tsx:329`).

Juno already names individuals in events: "Mira needs you. Scout is working." (`agents-home.tsx:92`), and "Needs you" is an existing fold (`app-sidebar.tsx:1672`). Creation is conversation-first by product rule (`PRODUCT.md`, Capabilities).

So Juno does solve the problem, but with the generic noun ("agent") plus the category cliché ("teammate").

#### (d) Are the competitors' solutions better?

- **Partly.** OpenAI's "dot" and SpaceXAI's "Bot" are better at one thing: a short, ownable singular noun that the brand carries. A "dot" is unmistakably OpenAI's, and "Bot" inherits Grok's brand.
- Grok's naming rationale is also sound. It identified five concepts users need: Bots, Chats, Prompts, Tools and Artifacts (x.ai/news/designing-grok-bot, 2026-09-03). That is a small, fixed vocabulary.
- Juno has no ownable singular, and "Crew" does not supply one either (the singular would be "crew member"). That is acceptable only because Juno's agents already have faces and names, and the design should lean on those.

#### Alternatives evaluated

Scores run from 1 to 5; higher is better. Collision risk is scored inverted, so 5 means low risk. These are my assessments, grounded in the collisions above.

| Name | Clarity (non-technical) | Collision risk (5 = low) | Verb-ability | Reads in UI | Localisation | Fit with "Juno" / Orbital | Notes |
|---|---|---|---|---|---|---|---|
| **Crew** | 4 | 2 | 5 ("Add to Crew") | 4 | 3 | 5 (mission crew) | CrewAI, Kiro Crew, crew.you, "crewmate" |
| Team | 5 | 1 | 5 | 3 | 5 | 2 | Collides with plan tiers (Claude "Team" — claude.com/pricing), Microsoft Teams, Grok "Team Bots", Zapier "dream team". "Juno Team" reads as a company sign-off. Blocks the word Juno will need for human workspaces. |
| Agents (status quo) | 4 | 3 | 3 ("Make this an agent") | 3 | 5 (エージェント, 智能体, Agenten) | 2 | Zero distinctiveness, zero risk. |
| Circle | 2 | 3 | 4 | 2 | 3 | 3 | Reads as a people or sharing circle (privacy ambiguity); Circle (USDC), Circle.so. |
| Cast | 2 | 3 | 1 | 2 | 1 | 2 | "Cast" means screen-casting (Google Cast); Cast & Crew LLC holds AI marks. |
| Staff | 3 | 3 | 2 | 2 | 3 | 1 | "Juno staff" reads as Juno's employees; Grok already owns "Chief of Staff". |
| Colleagues | 4 | 4 | 2 | 2 | 4 | 1 | Long (4 syllables); implies peers, not delegates. |
| Deputies | 3 | 3 | 3 ("deputize") | 3 | **1** | 2 | es *diputado*, fr *député*, it *deputato*, ru *депутат* all mean **legislator**. Deputy is also a workforce SaaS. |
| Orbit / Satellites | 1 | 3 (Mozilla Orbit AI assistant, shut 2025-06-26) | 3 | 2 | 4 | 5 | Poetic but opaque. "Orbit needs you" is nonsense as a sentence. |

The shortlist is Crew, Team, Agents and Orbit, with eight real UI strings each:

**Crew**
1. Sidebar section: `Crew`
2. Empty state: `No one on your crew yet. Describe a job and Juno will bring someone on for it.`
3. Promote from a chat: `Add Mira to your crew` (button: `Add to Crew`)
4. Aggregate attention header (more than one waiting): `Two of your crew need you`
5. Single event: `Mira needs you: send 3 follow-up emails?`
6. Profile line: `Mira · on your crew since 30 Sept`
7. Removal: `Remove Mira from your crew? Her chats and finished work stay in your history.`
8. Settings: `Crew rules — what your crew may do without asking`

**Team**
1. `Team`
2. `No one on your team yet. Describe a job and Juno will set someone up.`
3. `Add to team`: ambiguous the day Juno ships human workspaces (`Invite to team` vs `Add to team`)
4. `Two teammates need you`: indistinguishable from humans in a shared workspace
5. `Mira needs you: send 3 follow-up emails?`
6. `Mira · on your team since 30 Sept`
7. `Remove Mira from your team?`: reads as an HR or billing action
8. `Team settings`: collides with billing and plan settings

**Agents (status quo)**
1. `Agents`
2. `No agents yet. Describe a job and Juno will set one up.`
3. `Make this an agent`
4. `2 agents need you`
5. `Mira needs you: send 3 follow-up emails?`
6. `Mira · agent since 30 Sept`
7. `Delete agent Mira? Her chats and finished work stay in your history.`
8. `Agent rules — what agents may do without asking`

**Orbit**
1. `Orbit`
2. `Nothing in your orbit yet. Describe a job and Juno will bring someone in.`
3. `Add to Orbit`
4. `Orbit needs you`: an orbit cannot need anything, so the sentence fails
5. `Mira needs you: send 3 follow-up emails?`
6. `Mira · in your orbit since 30 Sept`
7. `Remove Mira from your orbit?`
8. `Orbit rules`: opaque without explanation

**Localisation of "Crew" across Juno's 20 locales** (`src/lib/i18n.ts:96-97`).

This is my linguistic assessment and needs native-speaker review.
- **Natural loanword, keep "Crew":**
  - de: *Crew*
  - nl: *crew*
  - ja: *クルー*
  - ko: *크루*, very common for groups
  - id: *kru*
  - pt-BR: *crew*, informal, or *equipe*
- **Good colloquial native equivalents:**
  - pl: *ekipa*
  - tr: *ekip*
- **Everywhere else, use the language's "team" word:**
  - es *equipo*
  - fr *équipe*
  - it *squadra*
  - ru/uk *команда*
  - sv *team*
  - vi *đội/nhóm*
  - th *ทีม*
  - hi *टीम*
  - zh-Hans *团队*
  - zh-Hant *團隊*
- **Put a glossary ban on vehicle-crew words:**
  - *tripulación*, *équipage*, *equipaggio*, *tripulação*
  - *załoga*, *mürettebat*
  - *экипаж*, *екіпаж*
  - *ลูกเรือ*, *船员/机组*

The consequence: in roughly 12 of 20 locales the English nuance collapses to "team". That is acceptable for a feature noun, and another reason not to make "Crew" a mark.

#### (e) Principle Juno should adopt

- **Name the place collectively and the member individually.** "Crew" labels the roster, the settings and the mention-picker header. Every event, approval and notification uses the member's name and face.
- Keep the vocabulary to a fixed small set, in the manner of Grok's five nouns. For Juno that means Chat, Crew, Work, Skills and Connectors.
- **Recommendation: "Crew", lowercase in running copy ("your crew"), capitalised only as a UI label.** Singular: the member's name, or "crew member" only in help text. Never "crewmate". Never "Juno Crew" as a product mark. Rename "teammate" copy (`agent-hire.tsx:329`) to "crew" copy.
- Fallback if counsel flags risk: keep "Agents".

#### (f) What not to copy

- **Do not copy CrewAI's semantics.** There, a crew is a task-scoped orchestration (sequential or hierarchical process). Juno's crew is a standing roster of individuals, and Juno must not imply that members are orchestrated into a pipeline by default.
- Do not copy a coined object noun like "dot" or "Bot". They work only with a mega-brand behind them.
- Do not copy "Chief of Staff" hierarchies, and do not ship a 50-slot roster as a goal. Grok caps at about 50 Bots "to prevent interface bloat". Juno should cap far lower.
- Do not say "teammate". It is the category cliché.

---

### 2.2 The name "Juno"

#### (a) What exists today

**Notable collisions:**

| Collision | Status | Relevance | Source (date) |
|---|---|---|---|
| **JUNO AI**: TechBridge Solutions LLC (New York) | **USPTO registered**, Reg. 8419089, serial 99349343, class 042, "SaaS … using artificial intelligence (AI) for legal practice support and law-firm…". TMview shows application 2025-08-21. | Same class as Juno's services. The strongest trademark signal found. | tmsearch.uspto.gov (searched 2026-09-30); TMview |
| **JUNO**: Origin Social LLC | USPTO pending, serial 99547080, classes 042 (AIaaS) and 045. The same owner has a class 041 filing for dating coaching. | Pending AI mark on the bare word. | USPTO search |
| **JUNO**: Juno Life, LLC | USPTO registered (serial 99206801), class 045, "non-medical personal assistant services". | "Personal assistant" semantics, but human services. | USPTO search |
| JUNO AI / JUNO CONNECT: ABL IP Holding (Juno Lighting / Acuity) | USPTO abandoned (2020 filings, home automation). | Lighting brand "Juno" is long-standing. | USPTO search |
| JUNO AI: CNIPA (China) | Three class-9 registrations (2021); owner UNVERIFIED. | Relevant if Juno ships in China app stores. | TMview |
| **Juno Online Services** (juno.com) | Operating ISP and email since 1996; subsidiary of United Online / B. Riley; site © 1995–2026. | Owns juno.com; older "free email" association. | Wikipedia; juno.com (search result, 2026) |
| **NASA Juno** (Jupiter orbiter) | Launched 2011-08-05, at Jupiter since 2016-07-04. Extended mission ended 2025-09-30. Post-2025 operating status reported as uncertain; Io results still reported Aug 2026 (press). | Positive, non-commercial association, and it supports the "orbital" identity. | science.nasa.gov/mission/juno; Scientific American (2025-08-19); Space.com (press) |
| **Juno — Python and Jupyter** (Rational Matter) | iPad/iPhone notebook IDE "with AI"; also Juno Connect. | Same App Store developer-tools neighbourhood as Juno Code. | apps.apple.com id1462586500; navoshta.com/juno |
| **Juno: AI that books by phone** (Trugen AI; juno-ai.app) | iOS/Android AI assistant making phone calls; iOS v1.0 2025-04-18. | Direct "Juno + AI assistant" consumer collision in store search. | apps.apple.com id6760284554; juno-ai.app |
| **Juno Health** (YC; chronic-illness AI assistant) | Active; claims 200,000 users. | Another "Juno AI assistant". | ycombinator.com/companies/juno-chat |
| juno.app | Redirects to a GoDaddy for-sale page (fetched 2026-09-30). | Juno's search User-Agent string advertises this domain (`src/lib/search/search-engine.ts:662`). Whether Juno controls it is UNVERIFIED. | fetch result |

Other well-known "Juno"s (Juno Awards, the 2007 film, Juno Records, Gett's NYC ride-hailing Juno) were not re-checked this session and are low relevance.

#### (b) The user problem

Users need a name that is findable, memorable and unambiguous in app stores and search, and that will not be taken away.

#### (c) Does Juno already solve it?

The name is established across web, Mac and iPhone, and `PRODUCT.md` makes it a brand commitment. But store and search findability is poor. At least three consumer "Juno" AI assistants exist (Trugen, Juno Health, and the AI-enabled Jupyter IDE). The metadata description ("Every frontier AI model … in one calm workspace", `src/app/layout.tsx:55-56`) carries the differentiation, not the name.

#### (d) Is anyone's solution better?

Not applicable as a competitor comparison. The relevant benchmark is Cursor's naming rule: "Refer to us as Cursor. Not Cursor AI or Cursor Code." (cursor.com/brand). A short common word is survivable when the brand enforces one form and never appends "AI".

#### (e) Principle to adopt

- **Keep "Juno"**, with three conditions:
  - one canonical form ("Juno", never "Juno AI" or "JunoAI"), because "JUNO AI" is a registered class-42 mark,
  - a consistent store descriptor ("Juno — every model, one workspace" or similar) to win search,
  - trademark clearance in classes 9 and 42 (US, EU, UK) before any filing.
- Fix or confirm the `juno.app` User-Agent reference.
- There is no strong factual reason to rename. The collisions are either different goods (lighting, ISP, dating, legal SaaS) or small apps.

#### (f) What not to copy

- Do not lean on NASA mission imagery (Jupiter art, probe silhouettes). It is government mission identity and a cliché.
- Take the *orbital* idea as a system metaphor (precision, trajectories, rings of state), not as illustration.
- Do not add "AI" to the name.

---

### 2.3 Brand colour: can a blue primary be owned?

#### (a) What exists today

| Product | Primary colour signature | Neutrals | Source (date, label) |
|---|---|---|---|
| **Claude / Anthropic** | Clay orange **#d97757** (OKLCH h 38.8°); secondary blue #6a9bcc, green #788c5d | Ivory **#faf9f5**, slate #141413 | Anthropic's own `brand-guidelines` skill, github.com/anthropics/skills (first-party) |
| **ChatGPT / OpenAI** | Largely monochrome; palette of "greys and blues evoking horizons"; blue animated "emotive point" for voice | Black/white | Wallpaper* (2025-02-04, press, on the rebrand) |
| **Gemini** | Four-colour Google gradient sparkle (blue dominant) since 2025-06-30; previously blue-purple. Google Blue #4285F4 (h 260.0° OKLCH) | White / Material | 9to5Google (2025-06-30, press) |
| **Grok / SpaceXAI** | Monochrome, no gradient; xAI became SpaceXAI 2026-07-06 | Black/white | digitalapplied, techweez (Jul 2026, press) |
| **Meta AI / Muse** | Meta Blue gradient #0064E0 → #0082FB (h 255–259°); Muse-specific palette UNVERIFIED | White, Meta Ink #1C2B33 | Aggregator (oh-my-design / loftlyy); Muse palette UNVERIFIED |
| **Perplexity** | "True Turquoise" #20808D (h 208.5°) | Paper #FBFAF4, offblack #091717 | Aggregator; identity by Smith & Diction (2023, bpando.org) |
| **Mistral** | Orange-to-yellow sunset gradient (#FA520F …); brand page says "Prefer the gradient version" | Cream, near-black | mistral.ai/brand (first-party, logo guidance); colours from aggregator |
| **Microsoft Copilot** | Consumer icon: multicolour gradient "represents all Microsoft products, rather than just the traditional blue". M365 Copilot redesigned to a "minimalist black and white palette". | — | microsoft.design (2025-10-01, first-party); Engadget (2026-05-28, press) |
| **Cursor** | Neutrals (black, white, cream) plus a warm orange accent "inspired by … power tools" | Cream | The Brand Identity (2025-11-03, press on Kimera's rebrand) |
| **Codex** | Shares the OpenAI/ChatGPT blossom icon (user complaints about identical icons); colour UNVERIFIED | — | github.com/openai/codex issue #32096 |
| **Linear** | "Subtle desaturated blue" primary; commonly cited #5E6AD2 (h 275.2°), UNVERIFIED first-party | Mercury White #F4F5F8, Nordic Gray #222326 | linear.app/brand (first-party) |
| **Apple system accent** (Mac/iOS default) | systemBlue #007AFF (h 257.4°) | — | Apple HIG (well known; not re-fetched) |

Four patterns stand out:
- **Warm orange/terracotta is crowded:** Claude, Mistral and Cursor's accent.
- **Monochrome is crowded:** ChatGPT, Grok, M365 Copilot and Cursor's base.
- **Mid-lightness blues are crowded:** Meta, Google/Gemini, OpenAI's voice blue and Apple's default.
- **Blurple belongs to** Linear, Discord, Stripe and Teams.

#### (b) The user problem

Users recognise a product at a glance and trust that colour means something. A brand colour that is someone else's either borrows their identity or makes Juno look unbranded.

#### (c) Does Juno already solve it?

Not distinctively, and the numbers here are computed from Juno's tokens.

**Juno versus Claude today:**

| Token | Juno | Claude | Difference |
|---|---|---|---|
| Background | `--background: 48 24% 97.2%` (`src/app/globals.css:70`) = #faf9f6 | ivory #faf9f5 | ΔE_ok **0.13**, identical to the eye |
| Primary | `--primary: 15 54% 46%` (`globals.css:82`) = #b55636 | clay #d97757 | Same hue (38.9° vs 38.8°) and chroma (0.132 vs 0.131); lightness 0.565 vs 0.672 |

The warm-neutral rule is enforced by tests: `JunoDesignTokensTests.testBrandNeutralsAreWarmInBothAppearances` (`native/Packages/JunoNativeKit/Tests/JunoDesignSystemTests/JunoDesignTokensTests.swift:227`, referenced at `globals.css:63`). An Orbital identity must deliberately retire that gate.

Blue is currently reserved for the design canvas's selection chrome. `globals.css:485` calls blue "the palette's one hole", and `--canvas-selection` is `229 78% 60%` at `globals.css:493` (dark `229 86% 68%` at `globals.css:660`). A blue primary would collide with that token.

#### (d) Is anyone's solution better?

- **Perplexity's approach is the most transferable.** It uses one muted signature hue as the only chromatic voice, on paper-toned neutrals ("invisible brand", per Smith & Diction).
- **M365 Copilot's 2026 move to black-and-white** confirms the trend. Brand colour retreats and function colours carry meaning.
- **Claude's system works because the whole system is coherent** (clay, ivory, serif). Juno copying two of its three legs is the worst of both.

#### (e) Principle and precise hue ranges

Computed in OKLCH, with ΔE_ok×100 distances (about 2 is a just-noticeable difference):

| Role | Range | Example | Nearest neighbours (ΔE) | Contrast |
|---|---|---|---|---|
| Primary (light) | **h 266–271°, L 0.44–0.50, C 0.19–0.22** | **#2A3FC9** = oklch(0.452 0.212 268.7) | Tailwind indigo-700 3.1 · IKB 7.8 · Meta #0064E0 8.9 · Tailwind blue-600 9.6 · Gemini #4285F4 far | 7.9:1 on white; 7.4:1 on #F7F7F5 |
| Primary (alt) | same | #2E44D0 = oklch(0.469 0.215 268.9) | Tailwind blue-700 2.6 · indigo-700 3.3 | about 7:1 |
| Primary (dark theme ink) | **h 274–276°, L 0.70–0.74, C 0.14–0.16** | **#8C9BFF** = oklch(0.720 0.146 275.7) | Gemini 10.6 · Discord 15.6 | 7.3:1 on #121316 |
| Signal amber (sparing) | **h 73–78°, L 0.63–0.68, C 0.13–0.14** | #B87A0A (3.6:1 on white; icon or large text) or #C98A12 | Claude clay 8.6–8.9 · Mistral #FFAF00 13–19 | Pair with ink text; never a fill or dot |
| Graphite ink | L 0.20–0.23, C ≤ 0.015, h ≈ 267° (tinted toward the primary) | #15171C | — | 16.7:1 on #F7F7F5 |
| Luminous paper | L 0.975, C ≤ 0.004, neutral or very slightly cool | #F7F7F5 / #F6F7F9 | Away from Claude's warm ivory | — |

**Hue bands to avoid:**
- **h 250–263°** in any lightness: Meta #0064E0/#0082FB, Google #4285F4, Apple #007AFF, Facebook #1877F2, Zoom #0B5CFF. Apple's default is especially important, because a native Juno app tinted near systemBlue would read as an untinted app.
- **h 273–280° at L ≥ 0.54**: the Linear, Discord, Stripe and Teams blurples.
- **Exact Tailwind defaults.** #2448D8 is ΔE 1.2 from Tailwind blue-700 #1D4ED8, so it is indistinguishable from the stock web blue.
- **Teal around h 200–210°**: Perplexity.

The rule that makes this ownable: **ultramarine is only ever an ink or a control fill, never a gradient, glow or surface wash.** Distinctness comes from darker-than-everyone lightness (L about 0.45 against 0.53–0.63 for the AI blues), a luminous neutral ground, and scarcity. Hue alone is not ownable; the nearest Tailwind defaults are ΔE 2.6–4.

Three concrete follow-ups:
- Move canvas selection off blue (for example to the signal amber at chrome strength) or derive it from the primary.
- Retire the warm-neutral test.
- Retire the coral accent option (`globals.css:678-679`), or keep it as a non-default user accent.

#### (f) What not to copy

- No multi-stop gradients (Gemini, Meta, Mistral, consumer Copilot).
- No animated coloured orb or "emotive point" (OpenAI voice).
- No sunset stripes.
- No teal answer cursor.
- No serif-on-ivory greeting.
- The amber must never become a status dot or pill (owner rule). It colours a word or a face state, and only when something needs the user.

---

### 2.4 Typography

#### (a) What exists today

| Product | Faces | Source (date, label) |
|---|---|---|
| Claude / Anthropic | Custom **Anthropic Sans / Serif / Mono** by Chester Jenkins (BSPK) with Geist studio. Earlier identity: **Styrene** (Commercial Type) and **Tiempos** (Klim). | geist.co/work/anthropic (first-party agency); Gooova (2026-05-20, press); wtfont (anthropic.com uses Anthropic Sans/Serif/Mono + JetBrains Mono, aggregator) |
| ChatGPT / OpenAI / Codex | **OpenAI Sans** (bespoke, with ABC Dinamo, Feb 2025), replacing **Söhne** and **Signifier** (Klim) | Wallpaper* (2025-02-04, press) |
| Gemini / Google | **Google Sans / Google Sans Flex**, OFL on Google Fonts (announced by Google Fonts on X; `google/fonts/ofl/googlesansflex` METADATA lists designer "Google") | google/fonts METADATA (first-party); OMG! Ubuntu (Nov 2025, press) |
| Meta | **Optimistic** (Dalton Maag) | fontsinuse; aggregator. Muse-specific face UNVERIFIED |
| Perplexity | **FK Grotesk / FK Display** (Florian Karsten) | Aggregator; UNVERIFIED first-party |
| Mistral | **PP Editorial Old** display + **Inter** | Aggregator DESIGN.md files; UNVERIFIED first-party |
| Cursor | **Cursor Gothic** (from Kimera's Waldenburg) + **Cursor Mono**, plus a serif body | The Brand Identity (2025-11-03, press) |
| Linear | **Inter** + **Inter Display** | linear.app/now "How we redesigned the Linear UI (part II)" (2024-03-28, first-party) |
| Grok | Wordmark reported as Elido Semi Bold or custom | Press; UNVERIFIED |
| Copilot (M365) | "Text-forward" black and white; face UNVERIFIED | Engadget (2026-05-28, press) |

#### (b) The user problem

Type is most of what a chat product *is*. The face has to read calmly for hours, set numbers and code exactly, and render every script Juno ships.

#### (c) What Juno does today

- **Inter** for all UI, **Newsreader** for "the two human moments — the empty-chat greeting and the wordmark", and **JetBrains Mono** (`src/app/layout.tsx:13-53`; `tailwind.config.ts:288-315`).
- The layout comment (`layout.tsx:14-15`) says Inter was chosen as "the closest open face to the custom sans Claude and ChatGPT set". That is an explicit goal of resemblance.
- Coverage gap: per `google/fonts` METADATA, **Newsreader ships latin, latin-ext and vietnamese only, with no Cyrillic**, although Juno ships `ru` and `uk`. The greeting and wordmark fall back for those users.

#### (d) Is anyone's solution better?

- **Cursor's is the most instructive.** One family (Gothic plus Mono) spans brand to editor, so product and identity are the same thing.
- **Linear shows that Inter can be made "yours" by a single move** (Inter Display for headings). But Inter is industry default, not identity.

#### (e) Principle and three open pairings

All of these are OFL on Google Fonts, checked against `github.com/google/fonts/ofl/*/METADATA.pb` on 2026-09-30. None is the signature face of a surveyed AI product.

| # | Pairing | Why it fits "calm, exact, technical-but-human" | Script coverage vs Juno's locales | Risks |
|---|---|---|---|---|
| 1 | **IBM Plex Sans** (UI; variable wdth 75–100, wght 100–700) + **IBM Plex Mono** (data, code, ids) | Engineered grotesk with humane details; one superfamily covers brand-to-code, as Cursor does. | Latin, Cyrillic, Greek, Vietnamese. Sibling families **Plex Sans JP / KR / Thai / Devanagari** cover ja, ko, th, hi. zh falls back to system. | IBM association; slightly corporate at display sizes. |
| 2 | **Geologica** (UI; axes wght, slnt, **SHRP 0–100** sharpness, **CRSV**) + **Source Serif 4** (human moments; opsz 8–60) + **JetBrains Mono** (kept) | SHRP lets one face move from exact (sharp) to soft (human) without switching family. Designed by Monokrom (Sindre Bremnes, Frode Helland). | Geologica and Source Serif 4: Latin, Cyrillic, Greek, Vietnamese. JetBrains Mono: Latin, Cyrillic, Greek, Vietnamese. | Less proven at 12–13 px UI sizes; needs a hinting check on Windows/Electron. |
| 3 | **Commissioner** (UI; axes wght, slnt, **FLAR** flare, **VOLM** volume) + **Literata** (reading/human; opsz 7–72, TypeTogether) + **JetBrains Mono** or **Martian Mono** | Flare dials from neutral grotesk to a subtly humanist voice. Literata is a reading serif built for long text. | Commissioner and Literata: Latin, Cyrillic, Greek, Vietnamese. Martian Mono: Latin and Cyrillic, **no Vietnamese**, so prefer JetBrains Mono. | Commissioner's flared settings can drift decorative; lock FLAR low in UI. |

- **Runner-up for Latin-only surfaces:** Atkinson Hyperlegible Next + Mono (Braille Institute; OFL; Google Fonts, added 2025-01-07 and 2024-11-20). It is distinctive and accessibility-led, but Latin only, so it fails `ru`, `uk` and `vi` in-product.
- **Native:** Mac and iOS should keep SF Pro for chrome and controls (system components, per owner rule). Use the brand face only where the web uses it: wordmark, greeting and possibly reading surfaces.

#### (f) What not to copy

- **Google Sans / Google Sans Flex.** They are Gemini's voice, even though they are now OFL.
- **Geist and Geist Mono.** They are the Vercel and v0 house faces, and ubiquitous in AI dev tools.
- **Space Grotesk.** Tempting for "orbital", but it comes from Florian Karsten, the same designer as FK Grotesk (Perplexity, per aggregators), and is heavily overused.
- **Söhne-, Styrene- or Tiempos-alikes**, and the serif-greeting-on-ivory move.
- **Inter as the brand voice.** It is fine as a fallback in the stack.

---

## 3. Interaction and visual patterns worth noting

These are principles, not pixels.

- **Presence lives in the face, not in a badge.**
  - Grok Bot: "The avatar itself communicates state — idle, working, waiting, blocked, thinking, or done". Avatars use "simple shapes and expressive eyes" with "controlled variations". Hover reveals the specific current action (x.ai/news/designing-grok-bot, 2026-09-03).
  - This is the pattern that satisfies the owner's no-pills rule. Juno's face states (`src/components/agents/agent-face-studio.tsx:38`, "Needs you") are on this path.
  - `NeedsYouDot` (`src/components/agents/agent-bits.tsx:58-60`, a static `bg-primary` circle) should be reviewed against the owner rule "no status dots anywhere". Moving attention into the face and the member's name is the consistent choice.
- **Creation by conversation, then naming.**
  - OpenAI: "create your first dot … and let it introduce itself"; "give it a name".
  - Grok: "type a name and choose Create "name" Bot".
  - Juno's conversation-first rule (`PRODUCT.md`) matches. Juno should let the member propose its own name, with the user able to rename in place.
- **Approvals as user-editable policy, with graduated trust.**
  - OpenAI: "Custom Rules let you allow specific actions, require approval, or block them"; "auto-review"; "Certain sensitive tasks … always stay with you".
  - Grok: returns "only when something needs your approval", and users "trust your Bots with more" over time.
  - Meta: "Nothing Muse does reaches the internet unless the Sentinel approves it."
  - Juno's digest-bound approvals are integrity-stronger. Two lessons: expose the policy in three plain states per action class (allow, ask, block), and show what trust a member has earned.
- **One place for background work.** OpenAI has "Activity View" and "open your dot's computer at any time to inspect its work". Principle: every run is inspectable from the member's profile and from one global activity surface. Progress is prose ("Mira is drafting the follow-ups"), not spinners or percentages.
- **Background initiative is read-only by default.** OpenAI's "proactive research" uses "tools that are restricted to be read-only". Juno routines and crew initiative should inherit exactly that default.
- **Mentions route work.** Grok adds Bots to a "group chat for visible handoffs". Principle: an `@Mira` token in the composer is the lightest way to hand work to a crew member from any chat. The mention picker's section header is where the collective noun earns its keep ("Crew").
- **Composer that grows with intent.** M365 Copilot's redesign has a "dynamic prompt surface that resizes and reveals options as users type" (Engadget, 2026-05-28). Principle: options appear when the text implies them, not as a permanent toolbar.
- **Restraint is the 2026 visual baseline.** M365 Copilot has gone black and white, Grok is monochrome, and Perplexity calls its approach an "invisible brand". Colour is reserved for meaning, which is why the ultramarine must stay an ink.
- **Adjacent naming collision.** "Work" (Juno's delegated long runs) now overlaps "ChatGPT Work" (launched 2026-07-09; BNN Bloomberg/Axios, press; openai.com/index/chatgpt-for-your-most-ambitious-work). This is worth resolving in the same naming pass as Crew.

---

## 4. Sources

Grouped by topic. "First-party" means the vendor itself, an official office record, or the vendor's design agency. Pages read on 2026-09-30 unless dated.

**Persistent-agent naming (first-party)**
1. OpenAI, "Introducing dots", 2026-09-29, https://openai.com/index/introducing-dots/ (read in full via browser)
2. SpaceXAI, "Introducing Grok Bot", 2026-08-11, https://x.ai/news/introducing-grok-bot
3. SpaceXAI, "Designing Grok Bot for a world of persistent agents", 2026-09-03, https://x.ai/news/designing-grok-bot
4. SpaceXAI Docs, "Create and manage Bots", https://docs.x.ai/grok-bot/bots
5. SpaceXAI Docs, "Team Bots", https://docs.x.ai/grok-bot/team-bots
6. Meta, "Introducing Muse", Sept 2026, https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
7. Meta, Muse product page, https://ai.meta.com/muse/
8. Lindy homepage, https://www.lindy.ai/
9. Zapier Agents, https://zapier.com/agents
10. Relevance AI homepage, https://relevanceai.com/
11. Asana, "AI Teammates" press release, 2025-09-25, https://investors.asana.com/news-releases/news-release-details/asana-announces-new-ai-teammates-collaborative-agents-deliver
12. Anthropic, Claude pricing ("Team" plan), https://claude.com/pricing

**"Crew" collisions**
13. CrewAI homepage, https://www.crewai.com/
14. CrewAI docs, "Crews", https://docs.crewai.com/en/concepts/crews
15. Wikipedia, "CrewAI", https://en.wikipedia.org/wiki/CrewAI
16. Kiro docs, "Crew", https://kiro.dev/docs/crew/
17. InfoQ, "AWS Open Sources Kiro Crew…", 2026-08-30 (press), https://www.infoq.com/news/2026/08/kiro-crew-coding-agents/
18. Search result: Swami Sivasubramanian on X announcing Kiro Crew (launch 2026-08-04 per Open Source For You / search summaries), https://x.com/SwamiSivasubram/status/2084729736228442254
19. crew.you, "Crew — Your Personal AI Agent", https://crew.you/
20. Apple App Store, Crew (Crew Systems), https://apps.apple.com/us/app/crew-ai-workforce-payroll/id6760766435
21. Square press, "Square Acquires Crew", https://squareup.com/us/en/press/square-acquires-crew
22. Innersloth news (Crewmate roles), https://www.innersloth.com/news/
23. Mozilla / OMG! Ubuntu, Orbit shut down 2025-06-26 (press), https://www.omgubuntu.co.uk/2025/06/orbit-by-mozilla-shutting-down-june-26-2025

**Trademark records (official search tools, queried 2026-09-30)**
24. USPTO Trademark Search, CREWAI serial 98425496, https://tmsearch.uspto.gov/ (query "crewai")
25. USPTO Trademark Search, query `CM:crew AND GS:"artificial intelligence"` (26 results); `CM:crew AND GS:"virtual assistant"` (3); wordmark "crew" Live, class 009 (843)
26. USPTO Trademark Search, query `CM:juno AND GS:"artificial intelligence"` (13 results, incl. JUNO AI Reg. 8419089)
27. EUIPO TMview, "crewai" (7 records), "kiro crew" (0), "juno ai" (8), https://www.tmdn.org/tmview/

**"Juno" collisions**
28. NASA Science, Juno mission page, https://science.nasa.gov/mission/juno/
29. Scientific American, "Say Goodbye to Juno…", 2025-08-19 (press), https://www.scientificamerican.com/article/how-nasas-juno-probe-changed-everything-we-know-about-jupiter/
30. Space.com, "NASA's Juno probe … may have come to an end…" (press), https://www.space.com/space-exploration/missions/nasas-juno-probe-orbiting-jupiter-may-have-come-to-an-end-but-no-one-can-confirm
31. Wikipedia, "Juno Online Services", https://en.wikipedia.org/wiki/Juno_Online_Services
32. Apple App Store, "Juno: AI That Books by Phone" (Trugen AI), https://apps.apple.com/us/app/juno-your-ai-companion/id6760284554 ; https://juno-ai.app/
33. Apple App Store, "Juno — Python and Jupyter" (Rational Matter), https://apps.apple.com/us/app/juno-jupyter-python-ide/id1462586500
34. Y Combinator, Juno (chronic-illness AI), https://www.ycombinator.com/companies/juno-chat
35. juno.app, redirect to GoDaddy for-sale page (fetched 2026-09-30)

**Brand colour and type**
36. Anthropic, `brand-guidelines` skill (colours), https://raw.githubusercontent.com/anthropics/skills/main/skills/brand-guidelines/SKILL.md
37. Geist (agency), Anthropic case study, https://geist.co/work/anthropic
38. Gooova, "Anthropic Designed Its Own Type Family", 2026-05-20 (press), https://gooova.com/en/anthropic-designed-its-own-type-family/
39. Wallpaper*, "OpenAI has undergone its first ever rebrand", 2025-02-04 (press), https://www.wallpaper.com/tech/openai-has-undergone-its-first-ever-rebrand-giving-fresh-life-to-chatgpt-interactions
40. 9to5Google, "Gemini sparkle icon getting the four-color Google treatment", 2025-06-30 (press), https://9to5google.com/2025/06/30/new-gemini-icon/
41. Microsoft Design, "Fluid forms, vibrant colors", 2025-10-01, https://microsoft.design/articles/fluid-forms-vibrant-colors/
42. Engadget, "Microsoft debuts a more buttoned-up look for Copilot", 2026-05-28 (press), https://www.engadget.com/2183246/microsoft-debuts-a-more-buttoned-up-look-for-copilot/
43. Mistral brand page, https://mistral.ai/brand
44. WinBuzzer, "Mistral rebrands Le Chat as Vibe", 2026-06-01 (press), https://winbuzzer.com/2026/06/01/mistral-rebrands-le-chat-as-vibe-for-work-and-coding-xcxwbn/
45. Cursor brand page, https://cursor.com/brand
46. The Brand Identity, "How Kimera built Cursor's identity…", 2025-11-03 (press), https://the-brandidentity.com/project/how-kimera-built-cursors-identity-around-a-custom-typeface-system
47. Linear brand page, https://linear.app/brand
48. Linear, "How we redesigned the Linear UI (part II)", 2024-03-28, https://linear.app/now/how-we-redesigned-the-linear-ui
49. BP&O, Perplexity identity by Smith & Diction (2023), https://bpando.org/logos/perplexity/ ; Perplexity colour values via aggregators (loftlyy, oh-my-design), UNVERIFIED first-party
50. Meta colours and Optimistic via aggregators (oh-my-design, fontsinuse), UNVERIFIED first-party
51. SpaceXAI rebrand and monochrome Grok identity (press): https://www.digitalapplied.com/blog/spacexai-xai-rebrand-grok-what-it-means-2026 ; https://techweez.com/2026/07/09/spacexai-grok-4-5-launch/
52. GitHub openai/codex issue #32096 (Codex and ChatGPT share an icon), https://github.com/openai/codex/issues/32096
53. Google Fonts repository METADATA (licences, designers, subsets, axes) for IBM Plex Sans/Mono, Geologica, Commissioner, Source Serif 4, Literata, JetBrains Mono, Martian Mono, Newsreader, Inter, Atkinson Hyperlegible Next/Mono, Google Sans Flex, Geist, Space Grotesk: https://github.com/google/fonts/tree/main/ofl
54. Braille Institute, Atkinson Hyperlegible Next release, 2025-02-10, https://www.brailleinstitute.org/about-us/news/braille-institute-launches-enhanced-atkinson-hyperlegible-font-to-make-reading-easier/

**Other product collisions**
55. OpenAI, "ChatGPT is now a partner for your most ambitious work" (ChatGPT Work), https://openai.com/index/chatgpt-for-your-most-ambitious-work/ ; BNN Bloomberg, 2026-07-09 (press)

**Juno code cited:**
- `src/app/globals.css:63,70,82,485,493,660,678-679`
- `src/app/layout.tsx:13-56`
- `tailwind.config.ts:288-315`
- `src/components/agents/agent-hire.tsx:328-329`
- `src/components/agents/agents-home.tsx:81,92`
- `src/components/agents/agent-bits.tsx:58-60`
- `src/components/agents/agent-face-studio.tsx:38`
- `src/components/app/app-sidebar.tsx:1233,1672`
- `src/lib/i18n.ts:96-97`
- `src/lib/search/search-engine.ts:662`
- `native/Packages/JunoNativeKit/Tests/JunoDesignSystemTests/JunoDesignTokensTests.swift:227`
- `PRODUCT.md`

Colour metrics were computed locally: OKLab/OKLCH via the Björn Ottosson matrices, and WCAG 2 contrast.
