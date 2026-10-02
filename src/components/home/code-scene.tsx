import { Check, FileCode, GitBranch, Terminal } from "@/components/ui/icons";
import { InView } from "./in-view";

/**
 * Alevr Code on a charcoal slab: the one deliberate dark object on the page.
 * The session plays in order once it is on screen: the ask, what was read,
 * the change, the tests, then the review that waits for you.
 */

const DIFF: { n: string; t: "ctx" | "add" | "del"; s: string }[] = [
  { n: "12", t: "ctx", s: "export async function startTrial(account: Account) {" },
  { n: "13", t: "del", s: "  return createWorkspace(account, { template: \"blank\" });" },
  { n: "13", t: "add", s: "  const template = templateFor(account.role) ?? \"blank\";" },
  { n: "14", t: "add", s: "  return createWorkspace(account, { template });" },
  { n: "15", t: "ctx", s: "}" },
];

const delay = (i: number) => ({ transitionDelay: `${i * 260}ms` });

export function CodeScene() {
  return (
    <section className="alv-code" id="code" aria-labelledby="alv-code-title">
      <div className="alv-col">
        <div className="alv-slab">
          <div className="alv-slab-grid">
            <div>
              <h2 id="alv-code-title" className="alv-h2">Code that waits for your review.</h2>
              <p className="alv-lede">Alevr Code reads your repository, makes the change, runs the tests and shows you the diff before anything lands.</p>
              <dl className="alv-slab-points" style={{ marginTop: 56 }}>
                <div><dt>Always in context</dt><dd>The project, branch and files it works on stay in view.</dd></div>
                <div><dt>Every step in the open</dt><dd>Files read, commands run and tests passed, as they happen.</dd></div>
                <div><dt>Nothing lands unreviewed</dt><dd>Approve, edit or reject each change.</dd></div>
              </dl>
            </div>
            <InView className="alv-term alv-seq" amount={0.3}>
              <div className="alv-term-bar"><span className="alv-traffic"><i /><i /><i /></span><GitBranch className="size-3.5" aria-hidden />trial-templates</div>
              <div className="alv-term-body">
                <div className="alv-term-ask alv-pop" style={delay(0)}>New trials should start from the template for their role, not a blank workspace.</div>
                <div className="alv-term-step alv-pop" style={delay(1)}><FileCode aria-hidden />Read <b>4 files</b> in src/onboarding</div>
                <div className="alv-term-step alv-pop" style={delay(2)}><Terminal aria-hidden />Ran <b>npm test onboarding</b></div>
                <div className="alv-diff alv-pop" style={delay(3)}>
                  <div className="alv-diff-head"><span>src/onboarding/trial.ts</span><span><em>+2</em> <del>−1</del></span></div>
                  {DIFF.map((r, i) => <div key={i} className="alv-diff-row" data-t={r.t}><span>{r.n}</span><span>{r.t === "add" ? "+ " : r.t === "del" ? "- " : "  "}{r.s}</span></div>)}
                </div>
                <div className="alv-term-step alv-pop" style={delay(4)}><Check aria-hidden style={{ color: "#74c68a" }} /><b>18 tests passed</b></div>
                <div className="alv-review alv-pop" style={delay(5)}>
                  <span>1 file changed</span>
                  <span className="alv-review-btns"><i>Reject</i><i>Review changes</i></span>
                </div>
              </div>
            </InView>
          </div>
        </div>
      </div>
    </section>
  );
}
