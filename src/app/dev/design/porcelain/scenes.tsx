"use client";

import * as React from "react";
import { ChevronDown, Folder, GitBranch, Laptop, MoreHorizontal, Settings2, Share2 } from "@/components/ui/icons";
import { Face } from "./face";
import { CREW, MIRA, PRESENCE_LABEL, SCOUT, THREAD_TITLE } from "./fixtures";
import { AtPalette, Caret, clampLeft, Composer, DRAFT, DraftText, ModelMenu, TOK, Token, TokenPanel, useCaretAnchor, type Seg } from "./composer";
import { MobileTop, Sidebar } from "./shell";
import { ActivityLine, Answer, Approval, TaskCard, ThinkingLine, UserMessage } from "./thread";

/* ------------------------------------------------------------------ */
/* Home: Chat at rest                                                  */
/* ------------------------------------------------------------------ */

export function Suggestions() {
  return (
    <div className="pc-chips" aria-label="Suggestions">
      <button type="button" className="pc-chip">
        <Face avatar={MIRA.avatar} presence="waiting" size={18} />
        Answer Mira on Halvorsen
      </button>
      <button type="button" className="pc-chip">
        <Face avatar={SCOUT.avatar} presence="available" size={18} />
        Review Scout&apos;s forecast
      </button>
      <button type="button" className="pc-chip">
        <Folder />
        Continue Atlas launch
      </button>
    </div>
  );
}

export function HomeScene() {
  return (
    <div className="pc-app">
      <Sidebar />
      <main className="pc-main">
        <MobileTop />
        <div className="pc-home">
          <div className="pc-home__inner">
            <div className="pc-home__greet">
              <h1 className="pc-greet text-center">Good afternoon, Liam</h1>
            </div>
            <Suggestions />
            <Composer variant="home" focused>
              <DraftText segs={DRAFT} />
              <Caret />
            </Composer>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Thread: after send                                                  */
/* ------------------------------------------------------------------ */

function ThreadTop({ title }: { title: string }) {
  return (
    <header className="pc-topbar">
      <button type="button" className="pc-topbar__title">
        {title}
        <ChevronDown />
      </button>
      <span className="flex items-center gap-0.5">
        <button type="button" className="pc-icon-btn" aria-label="Share">
          <Share2 />
        </button>
        <button type="button" className="pc-icon-btn" aria-label="More">
          <MoreHorizontal />
        </button>
      </span>
    </header>
  );
}

export function ThreadScene() {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  // A conversation opens at its latest turn, like every chat.
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !document.querySelector(".pc[data-full]")) el.scrollTop = el.scrollHeight;
  }, []);
  return (
    <div className="pc-app">
      <Sidebar current={THREAD_TITLE} />
      <main className="pc-main">
        <ThreadTop title={THREAD_TITLE} />
        <MobileTop title={THREAD_TITLE} />
        <div className="pc-scroll" ref={scroller}>
          <div className="pc-col pc-thread">
            <UserMessage />
            <div className="mt-7">
              <ActivityLine>Read 3 files and searched the web</ActivityLine>
            </div>
            <div className="mt-2">
              <Answer />
            </div>
            <div className="mt-8 flex flex-col gap-3">
              <TaskCard />
              <Approval />
            </div>
          </div>
        </div>
        <div className="pc-dock">
          <div className="pc-col">
            <Composer variant="dock" placeholder="Reply to Juno" action="voice" />
          </div>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Menus: @ palette, the app token panel, the model popover            */
/* ------------------------------------------------------------------ */

const TYPING_AT: Seg[] = [
  { t: "text", v: "Compare " },
  { t: "token", tok: TOK.forecast },
  { t: "text", v: " with " },
];

function PaletteDemo() {
  const { caretRef, pos } = useCaretAnchor([]);
  return (
    <Composer
      variant="home"
      focused
      overlay={pos ? <AtPalette query="" active={0} style={{ left: clampLeft(pos.left - 16, 340, pos.width), top: pos.top + 8 }} /> : null}
    >
      <DraftText segs={TYPING_AT} />
      <span className="pc-q">@</span>
      <Caret caretRef={caretRef} />
    </Composer>
  );
}

function TokenPanelDemo() {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const t = ref.current;
    const box = t?.closest(".pc-composer");
    if (!t || !box) return;
    const a = t.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    setPos({ left: clampLeft(a.left - b.left - 6, 312, b.width), top: a.bottom - b.top });
  }, []);
  return (
    <Composer variant="home" overlay={pos ? <TokenPanel app="stripe" style={{ left: pos.left, top: pos.top + 8 }} /> : null}>
      Compare <Token tok={TOK.forecast} /> with <Token tok={TOK.stripe} open tokenRef={ref} /> and ask <Token tok={TOK.mira} /> to flag renewal
      risk
    </Composer>
  );
}

function ModelDemo() {
  return (
    <Composer variant="home" modelOpen overlay={<ModelMenu style={{ right: 58, bottom: 52 }} />}>
      <DraftText segs={DRAFT} />
    </Composer>
  );
}

export function MenusScene() {
  return (
    <div className="pc-app pc-app--flush">
      <main className="pc-menus">
        <section>
          <p className="pc-small pc-quiet mb-3">Type @ to bring something in</p>
          <PaletteDemo />
        </section>
        <section>
          <p className="pc-small pc-quiet mb-3">An app in the sentence opens its page</p>
          <TokenPanelDemo />
        </section>
        <section className="pc-menus__low">
          <p className="pc-small pc-quiet mb-3">Model</p>
          <ModelDemo />
        </section>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Crew: the roster and a member's thread                              */
/* ------------------------------------------------------------------ */

export function CrewScene() {
  return (
    <div className="pc-app">
      <Sidebar current="mira" />
      <main className="pc-main">
        <MobileTop title="Crew" />
        <div className="pc-roster">
          <div className="pc-roster__list">
            <h1 className="pc-title px-2.5">Crew</h1>
            <p className="pc-small pc-quiet mt-1 px-2.5">Six teammates. Mira is waiting for you.</p>
            <div className="mt-5 flex flex-col gap-0.5" role="list">
              {CREW.map((m) => (
                <button key={m.id} type="button" className="pc-member" role="listitem" aria-current={m.id === "mira" ? "true" : undefined}>
                  <Face avatar={m.avatar} presence={m.presence} size={36} />
                  <span className="flex min-w-0 flex-col">
                    <span className="pc-member__name">{m.name}</span>
                    <span className="pc-member__role">{m.role}</span>
                  </span>
                  <span className="pc-member__state" data-presence={m.presence}>
                    {PRESENCE_LABEL[m.presence]}
                  </span>
                </button>
              ))}
            </div>
            <button type="button" className="pc-btn pc-btn--ghost mt-3">
              Add to crew
            </button>
          </div>
          <MemberThread />
        </div>
      </main>
    </div>
  );
}

function MemberThread() {
  return (
    <section className="flex min-w-0 flex-col" aria-label="Mira">
      <header className="pc-member-head">
        <Face avatar={MIRA.avatar} presence="waiting" size={40} />
        <div className="min-w-0 flex-1">
          <p className="pc-ui-m">Mira</p>
          <p className="pc-small">
            <span className="pc-quiet">Accounts</span>
            <span className="pc-quiet" aria-hidden>
              {"  ·  "}
            </span>
            <span className="pc-muted">Waiting for your answer on the Halvorsen renewal</span>
          </p>
        </div>
        <button type="button" className="pc-btn pc-btn--ghost">
          <Settings2 />
          Setup
        </button>
        <button type="button" className="pc-icon-btn" aria-label="More">
          <MoreHorizontal />
        </button>
      </header>
      <div className="pc-scroll">
        <div className="pc-col pc-thread !max-w-[640px]">
          <UserMessage segs={[{ t: "text", v: "Check usage on Halvorsen, Brightline and Oakridge and tell me which ones need a call this week." }]} />
          <div className="pc-prose mt-7">
            <p>
              Halvorsen&apos;s usage is flat since August, so the switch to monthly billing looks like a budget decision, not churn. Brightline
              is down two seats and 18% in weekly active users. I&apos;d call both this week.
            </p>
          </div>
          <div className="pc-card pc-task mt-6">
            <p className="pc-needs">Mira needs you</p>
            <p className="pc-ask__q">Oakridge&apos;s unpaid July invoice looks like a billing error, not churn. Should I still count it as renewal risk?</p>
            <div className="pc-ask__opts">
              <button type="button" className="pc-btn pc-btn--secondary">
                Count it
              </button>
              <button type="button" className="pc-btn pc-btn--secondary">
                Leave it out
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="pc-dock">
        <div className="pc-col !max-w-[640px]">
          <Composer variant="dock" placeholder="Message Mira" action="voice" />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Code: the start state and one working session                       */
/* ------------------------------------------------------------------ */

function CodeContext({ mode = "Code" }: { mode?: string }) {
  return (
    <>
      <button type="button" className="pc-ctx-btn">
        <GitBranch />
        juno-web
        <span className="pc-quiet">main</span>
        <ChevronDown />
      </button>
      <button type="button" className="pc-ctx-btn">
        <Laptop />
        This Mac
        <ChevronDown />
      </button>
      <span className="flex-1" />
      <div className="pc-seg" role="radiogroup" aria-label="Mode">
        {["Ask", "Plan", "Code"].map((m) => (
          <button key={m} type="button" aria-pressed={m === mode}>
            {m}
          </button>
        ))}
      </div>
    </>
  );
}

export function CodeStartScene() {
  return (
    <div className="pc-app">
      <Sidebar mode="code" />
      <main className="pc-main">
        <MobileTop />
        <div className="pc-home">
          <div className="pc-home__inner">
            <div className="pc-home__greet">
              <h1 className="pc-greet text-center">What should we build next?</h1>
            </div>
            <div className="h-8" />
            <Composer variant="code" context={<CodeContext mode="Plan" />} placeholder="Describe a change, or ask about the code" action="voice" focused>
              {null}
            </Composer>
            <p className="pc-small pc-quiet mt-4 text-center">
              Plan reads the repository and proposes the change. Nothing is edited until you approve the plan.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

const DIFF: { k: "ctx" | "add" | "del" | "hunk"; n?: number; s: string }[] = [
  { k: "hunk", s: "@@ -38,14 +38,28 @@ export function renewalRisk(account: Account)" },
  { k: "ctx", n: 38, s: "  const plan = account.subscription;" },
  { k: "ctx", n: 39, s: "  const lastYear = account.revenue.previousTerm;" },
  { k: "del", n: 40, s: "  if (plan.interval !== \"year\") return 0;" },
  { k: "add", n: 40, s: "  // A switch to monthly is a risk only once the" },
  { k: "add", n: 41, s: "  // annual contract has lapsed without renewal." },
  { k: "add", n: 42, s: "  if (plan.interval === \"month\") {" },
  { k: "add", n: 43, s: "    const lapsed = account.contract.endsAt < now();" },
  { k: "add", n: 44, s: "    if (!lapsed) return 0;" },
  { k: "add", n: 45, s: "    return monthlyShortfall(account, lastYear);" },
  { k: "add", n: 46, s: "  }" },
  { k: "ctx", n: 47, s: "" },
  { k: "ctx", n: 48, s: "  const expected = lastYear * (1 + account.growth);" },
  { k: "del", n: 49, s: "  return Math.max(0, expected - plan.amount);" },
  { k: "add", n: 49, s: "  return Math.max(0, expected - annualised(plan));" },
  { k: "ctx", n: 50, s: "}" },
  { k: "ctx", n: 51, s: "" },
  { k: "add", n: 52, s: "function monthlyShortfall(account: Account, lastYear: number) {" },
  { k: "add", n: 53, s: "  const run = annualised(account.subscription);" },
  { k: "add", n: 54, s: "  return Math.max(0, lastYear - run);" },
  { k: "add", n: 55, s: "}" },
];

export function CodeSessionScene() {
  return (
    <div className="pc-app">
      <Sidebar mode="code" current="s1" />
      <main className="pc-main">
        <MobileTop title="Monthly billing in renewal risk" />
        <div className="pc-session">
          <section className="flex min-w-0 flex-col" aria-label="Session">
            <header className="pc-topbar">
              <div className="min-w-0">
                <p className="pc-ui truncate">Monthly billing in renewal risk</p>
              </div>
              <span className="pc-small pc-quiet flex items-center gap-1.5">
                <GitBranch className="size-3.5" />
                renewal-monthly
              </span>
            </header>
            <div className="pc-scroll">
              <div className="pc-col pc-thread !max-w-[640px] !px-7">
                <UserMessage
                  segs={[
                    {
                      t: "text",
                      v: "Halvorsen moved to monthly billing and the risk score still treats them as annual. Fix the scorer and add a test.",
                    },
                  ]}
                />
                <div className="mt-6 flex flex-col items-start gap-0.5">
                  <ActivityLine>Read 4 files</ActivityLine>
                  <button type="button" className="pc-activity" aria-pressed="true">
                    <span className="pc-mono pc-muted">risk.ts</span>
                    <span className="pc-diff__stat !ml-0">
                      <span className="a">+18</span>
                      <span className="d">−4</span>
                    </span>
                  </button>
                  <button type="button" className="pc-activity">
                    <span className="pc-cmd">npm test -- renewals</span>
                    <span className="pc-small pc-quiet">12 passed</span>
                  </button>
                </div>
                <div className="pc-prose mt-3">
                  <p>
                    Monthly plans now count toward renewal risk only after the annual contract lapses, and the shortfall is measured against
                    the annualised run rate. I added a test for Halvorsen&apos;s case.
                  </p>
                </div>
                <div className="mt-4">
                  <ThinkingLine>Running the full suite</ThinkingLine>
                </div>
              </div>
            </div>
            <div className="pc-dock">
              <div className="pc-col !max-w-[640px] !px-7">
                <Composer
                  variant="dock"
                  context={<CodeContext />}
                  placeholder="Steer, or ask a question"
                  action="stop"
                />
              </div>
            </div>
          </section>
          <aside className="pc-inspector" aria-label="Changes">
            <div className="pc-tabs" role="tablist">
              {["Diff", "Files", "Terminal", "Tests"].map((t) => (
                <button key={t} type="button" role="tab" className="pc-tab" aria-selected={t === "Diff"}>
                  {t}
                </button>
              ))}
              <span className="flex-1" />
              <span className="pc-small pc-quiet pr-2">2 files changed</span>
            </div>
            <div className="pc-diff">
              <div className="pc-diff__file">
                <span className="pc-mono">src/lib/renewals/risk.ts</span>
                <span className="pc-diff__stat">
                  <span className="a">+18</span>
                  <span className="d">−4</span>
                </span>
              </div>
              <div className="pc-diff__lines">
                {DIFF.map((l, i) => (
                  <div key={i} className="pc-line" data-k={l.k}>
                    <span className="pc-line__n">{l.k === "hunk" ? "" : l.n}</span>
                    <span className="pc-line__s">{l.k === "add" ? "+" : l.k === "del" ? "−" : ""}</span>
                    <span className="pc-line__c">{l.s}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="pc-inspector__foot">
              <span className="pc-small pc-quiet flex-1">Waiting for the full suite</span>
              <button type="button" className="pc-btn pc-btn--secondary">
                Discard
              </button>
              <button type="button" className="pc-btn pc-btn--primary" aria-disabled="true">
                Commit
              </button>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

