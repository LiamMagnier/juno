**Findings**

- [P1] The landing-page redesign has a rendered desktop and phone-width capture, but not a persistent, same-frame implementation image for a side-by-side comparison against the selected generated direction.
  Location: landing page / Deep Research plan gate.
  Evidence: source directions are stored at `/Users/liammagnier/.codex/generated_images/01a06b00-ed45-74e3-be0b-839cff2d3ebf/exec-731b99e8-fcf4-4fbf-b5b2-a0324bfcc24e.png`, `exec-776d9c88-794c-4a6f-83d2-aaf510827895.png`, and `exec-965dba47-074a-456d-a735-f1f3712fd091.png`. The implementation was inspected through the in-app browser at a 390 × 844 CSS viewport and its normal desktop viewport, but that browser provides an ephemeral screenshot artifact rather than a project-local image path.
  Impact: visual QA cannot claim pixel-level fidelity or a completed redesign from separately viewed images.
  Fix: capture the selected source direction and the rendered implementation at the same viewport into one persistent comparison artifact, then resolve any visible P0–P2 differences before release sign-off.

- [P1] A real Deep Research run was not available in the local browser session, so the live progress, source rail, and final report states have not been visually verified end to end with production data.
  Location: `src/components/research/research-console.tsx`.
  Evidence: the plan gate was exercised from source and type checks; authenticated research-run data was unavailable in the local session.
  Impact: the key long-running state needs one final visual and interaction pass before production sign-off.
  Fix: run a representative authenticated research task, capture plan / active / completed states, and repeat this comparison.

**Open Questions**

- The three generated directions were intentionally synthesized rather than cloned. Their shared visual truths are warm editorial hierarchy, direct product proof, calm neutral surfaces, and high-trust conversion copy; exact pixel matching to any one concept is not the target.

**Implementation Checklist**

1. Capture a same-viewport combined comparison for the synthesized landing direction and its implementation.
2. Capture and test the Deep Research plan, live, report, and reduced-motion states with an authenticated run.
3. Resolve any resulting P0–P2 visual differences, then repeat this QA pass.

**Follow-up Polish**

- [P3] Consider an iOS pre-send plan/source review once the chat API accepts the same explicit `constraints` and `pinnedSources` contract as the web Research route. Do not simulate it locally with client-only state.

## Evidence

- Source visual truth: the three generated concept paths above.
- Implementation: Juno landing page in the in-app browser, inspected at its normal desktop viewport and at 390 × 844 CSS pixels; phone capture was device-scale 1.
- State: unauthenticated landing view; Research plan component code path. The live research state was unavailable in this session.
- Full-view comparison: blocked because the browser capture is ephemeral and could not be combined with the source images as required.
- Focused-region comparison: blocked for the same reason. The phone viewport did show the header, hero, two CTAs, composer preview, and model list without clipping or horizontal overflow.
- Required fidelity surfaces: typography, spacing, warm neutral token contrast, real brand/icon assets, and outcome-oriented copy were visually inspected in the implementation; pixel-level comparison remains pending.

## Comparison History

1. Initial implementation inspection found the phone-width content intact. No visual code changes were made from a same-frame image comparison because that comparison artifact could not be produced in this session.

final result: blocked
