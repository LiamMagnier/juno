import { InView } from "./in-view";

/**
 * Where the name comes from, set in type alone: the aleph on the ink panel
 * the voice cell uses, and the series under it, which lights one step at a
 * time when the panel arrives, then rests. It stood on a photograph (a path to
 * the horizon under a dark gradient), the render the owner asked to rework.
 */
export function Aleph() {
  return (
    <section className="alv-aleph" aria-labelledby="alv-aleph-title">
      <div className="alv-col alv-aleph-grid">
        <InView className="alv-aleph-glyph alv-seq" amount={0.4}>
          <span className="alv-aleph-mark" aria-hidden>ℵ<sub>0</sub></span>
          <span className="alv-aleph-series alv-annot" aria-hidden>
            {["ℵ₀", "ℵ₁", "ℵ₂", "ℵ₃", "…"].map((s, i) => <span key={s} className="alv-pop" style={{ transitionDelay: `${300 + i * 180}ms` }}>{s}</span>)}
          </span>
        </InView>
        <div className="alv-aleph-copy">
          <h2 id="alv-aleph-title" className="alv-h2">Knowledge that keeps expanding.</h2>
          <blockquote>Alevr is inspired by aleph, the symbol mathematics uses for infinite cardinalities.</blockquote>
          <p className="alv-body">Each infinity holds the last and opens onto a larger one. That is the idea behind the product: every answer, agent and finished piece of work becomes the ground for the next question.</p>
          <p className="alv-say"><b>Alevr</b><span className="alv-caption">Said AL-ver.</span></p>
        </div>
      </div>
    </section>
  );
}
