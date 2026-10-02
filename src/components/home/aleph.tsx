import { InView } from "./in-view";

/**
 * Where the name comes from. The photograph is the brand's own plate (a path
 * running to the horizon); the aleph is set in Newsreader over it. The series
 * under it lights one step at a time when the panel arrives, then rests.
 */
export function Aleph() {
  return (
    <section className="alv-aleph" aria-labelledby="alv-aleph-title">
      <div className="alv-col alv-aleph-grid">
        <InView className="alv-aleph-glyph alv-seq" amount={0.4}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand plate */}
          <img src="/brand/home-horizon-dark.webp" alt="" loading="lazy" decoding="async" />
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
