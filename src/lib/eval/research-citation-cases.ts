/**
 * The research citation eval set: whole reports, their corpora, and a human
 * judgement of every claim in them.
 *
 * Each case is a report as the writer produces one — Markdown, headings, `[n]`
 * markers, a table where a comparison calls for one — plus the numbered corpus
 * it was written from, plus a label for EVERY load-bearing sentence the audit
 * extracts. The labels were written from the report and the source text alone,
 * by reading them; they are the ground truth the audit is scored against and
 * are never edited to match its output.
 *
 * IN-SAMPLE. This set is not held out. The cases landed in one commit
 * (74ed268e0) after the audit fixes they exposed — the comparison
 * corroboration, the day-count and two-letter-unit rules, the clause-level
 * negation, and "Plus" as a product name rather than a sentence starter — so
 * git history cannot show the labels predate that tuning, and the numbers this
 * set produces (`renderScorecard` says so on every run) are a regression floor
 * for this build, not a general accuracy figure. A held-out set has to be
 * written after the code it measures is frozen.
 *
 * KNOWN GAP. Under the optimistic and credulous judges one strict miss is a
 * false support: relapse-trial's "The trial showed the drug is safe in the
 * long term", labelled contradicted, is audited supported because the judge
 * accepts the trial's efficacy paragraph; the "not designed to assess
 * long-term safety" paragraph is a denial the text cannot line up with the
 * claim (`negation_unresolved`), recorded beside the support, so the claim is
 * shown CONTESTED, but its label is wrong. The deterministic audit settles a
 * contradiction only when the text proves it (claim-polarity.ts), so the
 * other strict misses are the stub judge's to make: relapse-trial's "approved
 * … in 2026" against a page whose denial names no year reads as unsupported,
 * and the two dates-and-lists dates are lenient (a wrong date read as
 * unsupported rather than contradicted).
 * Where a careful reader could defensibly give either of two labels (a wrong
 * date is "contradicted" to some readers and "unsupported" to others) the
 * primary label is the stricter reading and `accept` names the other, so the
 * scorecard can report strict and lenient accuracy separately.
 *
 * The corpus is built to make the audit's job realistic rather than easy:
 * near-miss figures, a page about the right subject in the wrong year, a
 * quotation tidied into saying the opposite, a two-sentence search preview,
 * a citation number the corpus does not have, an old page behind a sentence
 * that says "currently", two cited sources that disagree, and an uncited page
 * that gives a different figure for the same thing.
 *
 * All names, figures and URLs are invented. `.example` hosts are reserved
 * (RFC 2606); the official-looking ones are on `.example.gov` style names that
 * exist only here.
 */

import type { SupportLabel } from "@/lib/research/claim-analysis";

export interface EvalSourceFixture {
  url: string;
  title: string;
  /** The text the run held for this source — what the writer was shown. */
  body: string;
  /** ISO date, as the source claims it. Absent: undated. */
  publishedAt?: string;
  /**
   * How the run obtained the text, as its event log would record it:
   * `opened` — a fetching stage read the page (a `source_read` event);
   * `search` — the search provider supplied the body and nothing opened it.
   */
  obtained: "opened" | "search";
}

export interface EvalExpectation {
  /** A substring that identifies exactly one extracted claim. */
  claim: string;
  /** The human judgement: what a careful reader says the cited evidence does for this claim. */
  label: SupportLabel;
  /** Another label a careful reader could defensibly give. Counted only in lenient accuracy. */
  accept?: SupportLabel[];
  /** The claim is supported, but other evidence in the corpus disagrees with it. */
  contested?: boolean;
  /** The claim says something is true now and rests on a source too old to say so. */
  stale?: boolean;
  /** `[n]` markers on the claim that name no source in the corpus. */
  unresolved?: number[];
  /** Why a careful reader says so. Printed beside every miss. */
  why: string;
}

export interface EvalCase {
  id: string;
  topic: string;
  /** When the audit is run: what "currently" means. */
  asOf: string;
  report: string;
  sources: EvalSourceFixture[];
  expectations: EvalExpectation[];
}

/** A long, on-topic body for a source whose full text came from the search provider. */
function longBody(paragraphs: string[]): string {
  return paragraphs.join("\n\n");
}

export const RESEARCH_CITATION_CASES: EvalCase[] = [
  // ── 1. Company results: figures, a quotation, a forecast, an uncited claim ──
  {
    id: "northwind-results",
    topic: "A company's annual results",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://northwind.example/investors/annual-report-2024",
        title: "Northwind Industries — Annual Report 2024",
        publishedAt: "2025-03-04",
        obtained: "opened",
        body: [
          "Northwind Industries reported revenue of $4.3 billion for the financial year ended 31 December 2024, up from $3.9 billion a year earlier.",
          "Operating profit rose 12% to $610 million. The logistics division contributed 41% of group revenue, and the industrial division the remainder.",
          "The company employed 18,200 people at year end across 14 countries, and it opened two new distribution centres during the year.",
        ].join("\n\n"),
      },
      {
        url: "https://wire.example/business/northwind-results",
        title: "Northwind revenue beats forecasts",
        publishedAt: "2025-03-04",
        obtained: "opened",
        body: [
          "Northwind Industries said on Tuesday its annual revenue rose to $4.3 billion, beating analyst expectations of $4.1 billion.",
          "Chief executive Maria Lund said the results were \"the strongest in the company's history\" and that the group would expand into Brazil next year.",
          "Shares rose 6% in early trading after the announcement, their biggest one-day gain this year.",
        ].join("\n\n"),
      },
      {
        url: "https://marketnotes.example/northwind-analysis",
        title: "What is driving Northwind?",
        publishedAt: "2025-03-10",
        obtained: "opened",
        body: [
          "Northwind's logistics arm drove the growth, analysts said, with the division now accounting for 41% of group revenue after two years of acquisitions.",
          "Some analysts estimate the company could reach $5 billion in revenue by 2026 if the Brazil expansion goes to plan.",
        ].join("\n\n"),
      },
    ],
    report: [
      "# Northwind Industries: 2024 results",
      "",
      "## Summary",
      "",
      "Northwind reported revenue of $4.3 billion for the 2024 financial year [1][2]. Operating profit rose 12% to $610 million [1]. The logistics division contributed 41% of group revenue [1][3].",
      "",
      "Northwind beat analyst expectations of $4.1 billion [2]. Chief executive Maria Lund said the results were \"the strongest in the company's history\" [2]. Shares rose 16% in early trading after the announcement [2].",
      "",
      "## Outlook",
      "",
      "Some analysts estimate revenue could reach $5 billion by 2026 if the Brazil expansion goes to plan [3]. The company plans to list its shares in New York.",
    ].join("\n"),
    expectations: [
      {
        claim: "revenue of $4.3 billion for the 2024 financial year",
        label: "supported",
        why: "Both cited sources give $4.3 billion; the annual report ties it to the year ended 31 December 2024.",
      },
      {
        claim: "Operating profit rose 12% to $610 million",
        label: "supported",
        why: "The annual report states both figures in those words.",
      },
      {
        claim: "logistics division contributed 41% of group revenue",
        label: "supported",
        why: "Sources [1] and [3] both give 41%.",
      },
      {
        claim: "beat analyst expectations of $4.1 billion",
        label: "supported",
        why: "The wire story says revenue beat expectations of $4.1 billion.",
      },
      {
        claim: "strongest in the company's history",
        label: "supported",
        why: "The quotation appears verbatim in the wire story, attributed to Maria Lund.",
      },
      {
        claim: "Shares rose 16% in early trading",
        label: "contradicted",
        why: "The cited story says shares rose 6% in early trading, not 16%.",
      },
      {
        claim: "could reach $5 billion by 2026",
        label: "supported",
        why: "A hedged forecast reported as a hedged forecast, with its condition kept.",
      },
      {
        claim: "list its shares in New York",
        label: "unsupported",
        why: "No citation, and nothing in the corpus mentions a listing.",
      },
    ],
  },

  // ── 2. Offshore wind: freshness, an uncited rival, a superlative leap ──────
  {
    id: "uk-offshore-wind",
    topic: "National energy statistics",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://energy-stats.example.gov/energy-trends-september-2026",
        title: "Energy Trends: September 2026",
        publishedAt: "2026-09-25",
        obtained: "opened",
        body: [
          "Installed offshore wind capacity in the UK reached 16.5 GW at the end of June 2026, the department's quarterly statistics show.",
          "Offshore wind generated 17% of the UK's electricity in 2025, up from 14% in 2024, as three large projects reached full output.",
        ].join("\n\n"),
      },
      {
        url: "https://windnews.example/uk-offshore-capacity",
        title: "UK leads Europe on offshore wind",
        publishedAt: "2023-02-10",
        obtained: "opened",
        body: [
          "The UK currently has 13.8 GW of offshore wind capacity installed, the largest offshore wind fleet in Europe.",
          "The government's target is 50 GW of offshore wind by 2030, which would require the build rate to roughly triple.",
        ].join("\n\n"),
      },
      {
        url: "https://energyweekly.example/cfd-auction-results",
        title: "Auction results: offshore wind clears at £59",
        publishedAt: "2026-09-03",
        obtained: "opened",
        body: [
          "The latest Contracts for Difference auction cleared offshore wind at £59 per MWh in 2012 prices, below the administrative strike price.",
          "A total of 8.4 GW of new offshore capacity won contracts in the round, spread across six projects in the North Sea and the Celtic Sea.",
        ].join("\n\n"),
      },
      {
        url: "https://windindustry.example/reports/capacity-review-2026",
        title: "Offshore wind capacity review 2026",
        publishedAt: "2026-08-01",
        obtained: "search",
        body: longBody([
          "This review tracks the operational offshore wind fleet project by project, using commissioning notices, grid connection records and operator disclosures rather than headline announcements.",
          "On that basis UK offshore wind capacity stood at 15.1 GW at the end of June 2026, with a further 4.2 GW under construction and expected to connect over the next three years.",
          "The difference between this figure and other published totals is mostly timing: a project is counted here only once every turbine has exported power, while some statistics count a project from first power.",
          "Turbine sizes continue to grow. The average rating of turbines installed in the first half of 2026 was 13 MW, compared with 8 MW five years earlier, and fewer, larger foundations have reduced installation time per megawatt.",
          "Supply chain constraints remain the main risk to the build-out, particularly for high-voltage cables and installation vessels, where lead times now exceed three years for some components.",
          "The review's methodology, data sources and a project-by-project table are published alongside it so that each figure can be checked against the underlying record.",
          "Regional distribution has shifted as well. Most early capacity was built in shallow waters off the east coast, while the newest projects are further from shore and in deeper water, which raises foundation costs but improves wind resource and load factors.",
          "Grid connection dates are now the binding constraint for several projects that have consent and contracts. The review lists each project's connection date as published by the network operator and flags those that have moved in the past year.",
          "Floating offshore wind remains at demonstration scale, with a handful of turbines operating. The review does not include floating projects in its fixed-bottom capacity total and reports them separately in an appendix.",
          "Operations and maintenance now employ more people than construction at several ports, as the first generation of projects ages. Blade repairs and cable faults account for most unplanned outages recorded in the review period.",
          "The review will be updated every six months, and corrections submitted by operators are logged in a public change list with the date each figure was revised.",
        ]),
      },
    ],
    report: [
      "# UK offshore wind in 2026",
      "",
      "The UK had 16.5 GW of offshore wind capacity installed at the end of June 2026 [1]. Offshore wind generated 17% of the UK's electricity in 2025 [1].",
      "",
      "The UK currently has 13.8 GW of offshore wind capacity installed, the largest fleet in Europe [2]. The government's target is 50 GW of offshore wind by 2030 [2].",
      "",
      "The latest auction cleared offshore wind at £59 per MWh [3]. A total of 8.4 GW of new offshore capacity won contracts in the round, the largest round ever held [3].",
    ].join("\n"),
    expectations: [
      {
        claim: "16.5 GW of offshore wind capacity installed at the end of June 2026",
        label: "supported",
        contested: true,
        why: "The cited statistics give 16.5 GW at end-June 2026 — but the uncited capacity review, which the run read, gives 15.1 GW for the same date.",
      },
      {
        claim: "17% of the UK's electricity in 2025",
        label: "supported",
        why: "Stated in the cited statistics for 2025.",
      },
      {
        claim: "currently has 13.8 GW",
        label: "partially supported",
        stale: true,
        why: "The 2023 article supports 13.8 GW as of early 2023; it cannot support \"currently\" in late 2026, and newer sources in the corpus give higher figures.",
      },
      {
        claim: "target is 50 GW of offshore wind by 2030",
        label: "supported",
        why: "The cited article states the 50 GW by 2030 target.",
      },
      {
        claim: "latest auction cleared offshore wind at £59 per MWh",
        label: "supported",
        why: "The cited auction report is from September 2026, so \"latest\" is current, and it states £59 per MWh.",
      },
      {
        claim: "the largest round ever held",
        label: "partially supported",
        why: "8.4 GW is stated; \"the largest round ever held\" is not.",
      },
    ],
  },

  // ── 3. A SaaS product: a preview-only source, invented citations ──────────
  {
    id: "saas-pricing-previews",
    topic: "A software product's pricing and funding",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://examplesaas.example/pricing",
        title: "Pricing — Example SaaS",
        obtained: "opened",
        body: [
          "Plans and pricing for teams of every size. Every plan comes with a 14-day free trial and can be cancelled at any time.",
          "The Team plan costs $12 per user per month, billed annually. The Business plan costs $24 per user per month, billed annually.",
          "All plans include unlimited projects and 30-day version history, and the Business plan adds single sign-on and audit logs.",
        ].join("\n\n"),
      },
      {
        url: "https://reviews.example/example-saas-review",
        title: "Example SaaS review",
        publishedAt: "2026-06-01",
        obtained: "search",
        body: "Example SaaS review: a capable tool for small teams. We tested the Team plan for a month and found the editor fast and the mobile app solid, if a little sparse on settings.",
      },
      {
        url: "https://techpress.example/2026/05/example-saas-series-b",
        title: "Example SaaS raises $40 million",
        publishedAt: "2026-05-02",
        obtained: "search",
        body: longBody([
          "Example SaaS raised $40 million in a Series B round led by Northstar Ventures, the company announced on Thursday, bringing its total funding to $58 million.",
          "The company says it has 9,000 paying customers, most of them teams of fewer than fifty people, and that annual recurring revenue doubled over the past year.",
          "Chief executive Priya Raman said the money would go towards hiring engineers in Lisbon and Toronto and towards building the offline mode customers have been asking for.",
          "The round was oversubscribed, according to two people familiar with it, and existing investors Harbor Capital and Linden Partners also took part.",
          "Example SaaS competes with larger collaboration suites on price and simplicity. Its Team plan undercuts most rivals, and the company has resisted adding features that would complicate the editor.",
          "The startup was profitable in two of the last four quarters, Raman said, but it plans to run at a loss while it expands the engineering team.",
          "Analysts who follow the sector said the round showed investors remain willing to back focused tools with clear revenue, even as funding for broader platforms has slowed.",
          "Customers interviewed for this article praised the speed of the editor and the predictability of the pricing, though two said the lack of an offline mode had kept them from moving their whole team onto the product.",
          "The company plans to publish a public roadmap later this year and says it will keep the Team plan's price unchanged for existing customers for at least twelve months after the funding.",
          "Northstar Ventures partner Daniel Osei will join the board. In a statement, he said the firm had been a customer before it was an investor, and that the product's retention among small teams was the strongest he had seen in the category.",
          "Example SaaS was spun out of a design agency and still builds much of its own marketing in house. Its support team answers tickets in four languages, and the company publishes its uptime record monthly on a public status page that lists every incident since launch.",
        ]),
      },
    ],
    report: [
      "# Example SaaS",
      "",
      "## Pricing",
      "",
      "The Team plan currently costs $12 per user per month, billed annually [1]. The Business plan costs $24 per user per month [1]. All plans include unlimited projects and 30-day version history [1][5].",
      "",
      "## Reception and funding",
      "",
      "Reviewers rated the mobile app 4.8 out of 5 [2]. Example SaaS raised $40 million in a Series B round led by Northstar Ventures [3]. The company has 90,000 paying customers [3]. Example SaaS employs 140 engineers [3]. Example SaaS was founded in Lisbon in 2019 [7].",
    ].join("\n"),
    expectations: [
      {
        claim: "Team plan currently costs $12 per user per month",
        label: "supported",
        why: "The live pricing page states it. It is undated because it is the current page, which is what \"currently\" needs.",
      },
      {
        claim: "Business plan costs $24 per user per month",
        label: "supported",
        why: "Stated on the pricing page.",
      },
      {
        claim: "unlimited projects and 30-day version history",
        label: "supported",
        unresolved: [5],
        why: "Source [1] states it; [5] names no source in a three-source corpus and must not survive in the answer.",
      },
      {
        claim: "mobile app 4.8 out of 5",
        label: "unverified",
        why: "The only text held for source [2] is a two-sentence search preview with no rating in it. The page may or may not give one; nobody read it.",
      },
      {
        claim: "raised $40 million in a Series B round led by Northstar Ventures",
        label: "supported",
        why: "Stated in the funding story's first paragraph.",
      },
      {
        claim: "90,000 paying customers",
        label: "contradicted",
        why: "The cited story says 9,000 paying customers.",
      },
      {
        claim: "employs 140 engineers",
        label: "unsupported",
        why: "The funding story — page text the search provider supplied in full, not a preview — mentions hiring engineers but gives no headcount. Text that substantial is enough to say the figure is not there.",
      },
      {
        claim: "founded in Lisbon in 2019",
        label: "unsupported",
        unresolved: [7],
        why: "It cites [7], which does not exist; nothing in the corpus gives a founding date or city.",
      },
    ],
  },

  // ── 4. A drug trial: hedges, a tidied quotation, polarity ─────────────────
  {
    id: "relapse-trial",
    topic: "A clinical trial and its regulatory status",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://journal.example/articles/relapse-trial",
        title: "Randomised trial of a relapse-prevention drug",
        publishedAt: "2025-11-12",
        obtained: "opened",
        body: [
          "In a randomised trial of 1,240 participants, those who took the drug showed a 27% reduction in relapse over 12 months compared with placebo.",
          "The authors noted that the trial was not designed to assess long-term safety, and said further studies were needed before wider use.",
          "Serious adverse events occurred in 3% of the treatment group and 2% of the placebo group, a difference the authors described as not significant.",
        ].join("\n\n"),
      },
      {
        url: "https://healthnews.example/relapse-drug-early-results",
        title: "Relapse drug shows early promise",
        publishedAt: "2025-11-13",
        obtained: "opened",
        body: [
          "The drug may reduce relapse rates, early results suggest, though experts cautioned that the findings are preliminary and need confirming in larger groups.",
          "\"This is an encouraging signal, not a cure,\" said Dr Amara Okafor, a specialist who was not involved in the study.",
        ].join("\n\n"),
      },
      {
        url: "https://medicines-agency.example.gov/applications/relapse-drug",
        title: "Application status: relapse-prevention drug",
        publishedAt: "2026-04-02",
        obtained: "opened",
        body: [
          "The agency has not approved the drug for the treatment of relapse. The application is under review and a decision is expected in 2027.",
          "Until a decision is made the drug is available only within clinical trials, and the agency's assessment report will be published with the decision.",
        ].join("\n\n"),
      },
    ],
    report: [
      "# The relapse-prevention drug",
      "",
      "In a trial of 1,240 participants, the drug reduced relapse by 27% over 12 months compared with placebo [1]. Serious adverse events occurred in 3% of the treatment group [1]. The trial showed the drug is safe in the long term [1].",
      "",
      "The drug reduces relapse rates in patients [2]. Dr Amara Okafor called the drug \"an encouraging signal and a cure\" [2].",
      "",
      "The agency approved the drug for the treatment of relapse in 2026 [3].",
    ].join("\n"),
    expectations: [
      {
        claim: "reduced relapse by 27% over 12 months",
        label: "supported",
        why: "Participant count, effect size, period and comparator all match the trial report.",
      },
      {
        claim: "Serious adverse events occurred in 3% of the treatment group",
        label: "supported",
        why: "Stated in the trial report.",
      },
      {
        claim: "safe in the long term",
        label: "contradicted",
        accept: ["unsupported"],
        why: "The trial report says the trial was NOT designed to assess long-term safety — it did not show it.",
      },
      {
        claim: "reduces relapse rates in patients",
        label: "partially supported",
        why: "The source hedges (\"may\", \"early results suggest\", \"preliminary\"); the report states it as settled fact.",
      },
      {
        claim: "an encouraging signal and a cure",
        label: "contradicted",
        accept: ["unsupported"],
        why: "The quotation was altered: Dr Okafor said \"not a cure\".",
      },
      {
        claim: "agency approved the drug",
        label: "contradicted",
        why: "The agency page says it has not approved the drug.",
      },
    ],
  },

  // ── 5. A comparison table: cell-level checks ──────────────────────────────
  {
    id: "storage-plans-table",
    topic: "A two-product comparison matrix",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://alpha.example/pricing",
        title: "Alpha pricing",
        obtained: "opened",
        body: [
          "Alpha Pro costs $20 per month and includes 100 GB of storage, with file history kept for 180 days.",
          "Alpha Free includes 5 GB of storage and keeps file history for 30 days. Prices exclude local sales taxes.",
        ].join("\n\n"),
      },
      {
        url: "https://beta.example/plans",
        title: "Beta plans",
        obtained: "opened",
        body: [
          "Beta Plus costs $15 per month and includes 50 GB of storage, with file history kept for 90 days.",
          "Beta Basic is free and includes 2 GB of storage. Every Beta plan can share folders with unlimited collaborators.",
        ].join("\n\n"),
      },
    ],
    report: [
      "# Alpha Pro or Beta Plus?",
      "",
      "## Comparative matrix",
      "",
      "| Product | Price | Storage |",
      "|---|---|---|",
      "| Alpha Pro | $20 per month [1] | 100 GB [1] |",
      "| Beta Plus | $18 per month [2] | 50 GB [2] |",
      "",
      "## Verdict",
      "",
      "Alpha Pro includes twice the storage of Beta Plus, at 100 GB against 50 GB [1][2].",
    ].join("\n"),
    expectations: [
      {
        claim: "Alpha Pro — Price: $20 per month",
        label: "supported",
        why: "Both cells match Alpha's pricing page.",
      },
      {
        claim: "Beta Plus — Price: $18 per month",
        label: "contradicted",
        why: "Beta's plans page gives $15 per month, not $18.",
      },
      {
        claim: "twice the storage of Beta Plus",
        label: "supported",
        why: "100 GB is on Alpha's page and 50 GB on Beta's; the sentence cites both.",
      },
    ],
  },

  // ── 6. Dates: the publication-date trap, a wrong year, a list overreach ───
  {
    id: "dates-and-lists",
    topic: "A merger and a city ordinance",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://newswire.example/acme-globex-merger-retrospective",
        title: "Seven years after the Acme–Globex merger",
        publishedAt: "2026-02-11",
        obtained: "opened",
        body: [
          "The merger between Acme and Globex was completed in 2019 after a two-year antitrust review by regulators on both sides of the Atlantic.",
          "The combined group has since divested its European retail arm and now operates in 31 countries, with manufacturing concentrated in four of them.",
        ].join("\n\n"),
      },
      {
        url: "https://cityhall.example.gov/ordinances/plastics",
        title: "Single-use plastics ordinance",
        publishedAt: "2026-01-15",
        obtained: "opened",
        body: [
          "From 1 July 2026 the city's ban covers single-use plastic bags and polystyrene food containers sold or given away by retailers.",
          "Retailers that breach the rules face fines of up to £5,000 per offence. Inspections begin three months after the ban takes effect.",
        ].join("\n\n"),
      },
    ],
    report: [
      "# Two policy notes",
      "",
      "Acme and Globex completed their merger in 2026 [1]. The combined group now operates in 31 countries [1].",
      "",
      "The ban covers single-use plastic bags, polystyrene food containers and disposable vapes [2]. Retailers that breach the rules face fines of up to £5,000 per offence [2]. The ban took effect on 1 July 2025 [2].",
    ].join("\n"),
    expectations: [
      {
        claim: "completed their merger in 2026",
        label: "contradicted",
        accept: ["unsupported"],
        why: "The article says 2019; 2026 is only its publication date.",
      },
      {
        claim: "now operates in 31 countries",
        label: "supported",
        why: "Stated in an article published eight months before the audit, inside the freshness window for \"now\".",
      },
      {
        claim: "disposable vapes",
        label: "partially supported",
        why: "Bags and polystyrene containers are covered; vapes are not mentioned.",
      },
      {
        claim: "fines of up to £5,000 per offence",
        label: "supported",
        why: "Stated in the ordinance.",
      },
      {
        claim: "took effect on 1 July 2025",
        label: "contradicted",
        accept: ["unsupported"],
        why: "The ordinance says 1 July 2026.",
      },
    ],
  },

  // ── 7. Disagreement: two cited sources, and a rival that is not one ───────
  {
    id: "city-population",
    topic: "A city's population, past and present",
    asOf: "2026-10-25",
    sources: [
      {
        url: "https://stats-office.example.gov/population/mid-2025",
        title: "Mid-2025 population estimates",
        publishedAt: "2026-03-01",
        obtained: "opened",
        body: [
          "The statistics office's mid-2025 figures put the city's population at 812,000, an increase of 1.1% on the previous year.",
          "Net international migration accounted for most of the increase, while natural change was close to zero for the third year running.",
        ].join("\n\n"),
      },
      {
        url: "https://citypaper.example/news/population-analysis",
        title: "Our analysis: the city is smaller than official figures say",
        publishedAt: "2026-03-05",
        obtained: "opened",
        body: [
          "The city's population stood at 790,000 in mid-2025, the paper's own analysis of council tax and school roll data found.",
          "The gap with the official estimate comes from how students and short-term residents are counted, the analysis says.",
        ].join("\n\n"),
      },
      {
        url: "https://census-archive.example.gov/2001/city-profile",
        title: "2001 census: city profile",
        publishedAt: "2003-06-30",
        obtained: "opened",
        body: [
          "At the 2001 census the city's population was 650,000, of whom 21% were aged under 16.",
          "The city's population had fallen slightly since 1991, reversing three decades of growth.",
        ].join("\n\n"),
      },
    ],
    report: [
      "# The city's population",
      "",
      "The city's population was 812,000 in mid-2025 [1][2]. At the 2001 census the city's population was 650,000 [3].",
    ].join("\n"),
    expectations: [
      {
        claim: "812,000 in mid-2025",
        label: "supported",
        contested: true,
        why: "The statistics office gives 812,000; the second cited source, the newspaper's analysis, gives 790,000 for the same date. Supported, and disputed by its own citation.",
      },
      {
        claim: "2001 census the city's population was 650,000",
        label: "supported",
        why: "The census profile states it. The 2025 figures elsewhere in the corpus are a different year, not a rival.",
      },
    ],
  },
];
