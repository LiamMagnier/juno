import { SharedChatTranscript } from "@/components/share/shared-chat-transcript";
import { AgentFace } from "@/components/agents/agent-face";
import { FileDiff, type DiffRow } from "@/components/aicss/file-diff";
import { ProductStudy } from "./product-study";
import { LandingColumn } from "./section";
import { Reveal } from "./reveal";
import type { SharedChatMessage } from "@/lib/share";

const CONVERSATION: SharedChatMessage[] = [
  { id: "example-question", role: "USER", content: "Help me turn these customer interviews into a useful product brief.", model: null, createdAt: "2026-10-01T10:00:00.000Z" },
  { id: "example-answer", role: "ASSISTANT", content: "## Start with the decision\n\nThe brief should help your team choose what to build next. Separate what people asked for from the problem they were trying to solve.\n\n**A useful structure**\n\n- The recurring problem\n- Evidence from the interviews\n- The smallest change worth testing\n\nThen make the open questions explicit, so the next conversation moves the work forward.", model: null, createdAt: "2026-10-01T10:01:00.000Z" },
];
const DIFF: DiffRow[] = [
  { old: 1, cur: 1, type: "ctx", text: "export function canPublish(document) {" },
  { old: 2, cur: null, type: "del", text: "  return document.ready;" },
  { old: null, cur: 2, type: "add", text: "  return document.ready" },
  { old: null, cur: 3, type: "add", text: "    && document.reviewed" },
  { old: null, cur: 4, type: "add", text: "    && document.ownerApproved;" },
  { old: 3, cur: 5, type: "ctx", text: "}" },
];

export function ProductOverview({ hero = false }: { hero?: boolean }) {
  return (
    <section id="features" className={hero ? "alevr-hero-stage scroll-mt-20" : "alevr-overview scroll-mt-20"}>
      <LandingColumn contentClassName={hero ? "pb-10" : "alevr-section-space"}>
        {!hero && <Reveal>
          <h2 className="alevr-section-heading font-serif">Think. Delegate. Build.</h2>
          <p className="mt-5 max-w-xl text-body-lg leading-relaxed text-muted-foreground">One workspace, three ways to move your work forward.</p>
        </Reveal>}
        <Reveal className={hero ? "" : "mt-12 sm:mt-16"} amount={0.15}>
          <ProductStudy compact={hero}
            chat={<SharedChatTranscript messages={hero ? [CONVERSATION[0], { ...CONVERSATION[1], content: "## Make the next decision clear\n\nGroup the interviews around the problem people are trying to solve. Then compare the evidence before choosing what to build.\n\n- What keeps coming up?\n- What is the smallest change worth testing?" }] : CONVERSATION} artifacts={[]} />}
            orbit={<OrbitExample compact={hero} />}
            code={<div><FileDiff file="publish.ts" rows={DIFF} /><p className="mt-6 text-body text-muted-foreground">Review the proposed change before applying it.</p></div>}
          />
        </Reveal>
      </LandingColumn>
    </section>
  );
}

function OrbitExample({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "alevr-orbit-compact" : ""}>
      <div className="flex items-center gap-5">
        <AgentFace avatar={{ shape: "prism", tone: "teal", eyes: "soft", mark: "none" }} state="idle" size={64} live={false} />
        <div><p className="font-serif text-page-title">Mira</p><p className="mt-1 text-ui text-muted-foreground">Research agent</p></div>
      </div>
      <p className="mt-8 font-serif text-title">A role you shape together.</p>
      <p className="mt-3 text-body leading-relaxed text-muted-foreground">Compare customer feedback with our product plans. Keep the evidence clear, and ask me before publishing anything.</p>
      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-6 text-ui">
        <dt className="text-muted-foreground">Research</dt><dd>Allowed</dd>
        <dt className="text-muted-foreground">Publish externally</dt><dd>Ask first</dd>
        <dt className="text-muted-foreground">Standing work</dt><dd>Weekly feedback review</dd>
      </dl>
    </div>
  );
}
