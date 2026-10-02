import { ProviderLogo } from "@/components/brand/provider-logo";
import { LABS, MODELS_FLOOR, TOTAL_LABS } from "@/components/landing/lab-marquee";

/** The one marquee on the page: every lab in the picker, read from the model registry. */
export function Labs() {
  const row = LABS.map(({ provider, label }) => ({ provider, label: label.split(" · ").pop() ?? label }));
  return (
    <section className="alv-labs" aria-labelledby="alv-labs-title">
      <div className="alv-col alv-labs-head">
        <p id="alv-labs-title" className="alv-body">{MODELS_FLOOR}+ models from {TOTAL_LABS} labs, in one workspace</p>
      </div>
      <div className="alv-marquee">
        <ul className="alv-marquee-track" aria-label="Labs in the model picker">
          {[...row, ...row].map(({ provider, label }, i) => (
            <li key={`${provider}-${i}`} aria-hidden={i >= row.length || undefined}>
              <ProviderLogo provider={provider} className="size-6" />{label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
