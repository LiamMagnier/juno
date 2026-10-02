# Public pages: structural overhaul

## Brief and audit before source changes

The owner rejected the previous layout and motion and explicitly requested a complete ground-up visual rework. This authorizes replacing public composition while retaining routes, primary navigation labels, brand masters, form fields/order, legal/consent copy and working behaviors. Work remains limited to juno-rf-public / rf/public-pages; excluded app component directories are untouched. No push, merge or deploy.

Reading this as a full visual overhaul for design-conscious consumers, architectural and product-led. DESIGN_VARIANCE 8 / MOTION_INTENSITY 7 / VISUAL_DENSITY 3. Tailwind 3, existing owned Radix controls and Framer Motion 12 remain the single foundation. Newsreader, Inter, Continuum and semantic neutral V3 colors are explicit brand requirements, overriding generic font defaults.

Observed debt: the homepage is a photograph with copy pasted above it; subsequent sections have the same column and pace. Auth is a generic equal split with a dark picture rail, a boxed caption and oversized unused areas. Recovery repeats the photograph/text split, making errors look like marketing. Motion is almost entirely small 6-8px fades, often suppressed by a once-session hero gate; tab selection replaces one static card. The scenery repeats across download/auth/home without communicating different page jobs. Legal reading lacks orientation; shares lack a distinct document surface. These structural patterns are retired.

Preserve: exact identity, routes/anchors, signed-in redirects, canonical/schema/OG metadata, real provider readiness, reset/token handling, form validation/autofill/password visibility, truthful release availability/checksums, live share/security controls, actual public transcript and diff renderers, registry-derived plans/models, legal bodies and mail semantics.

## New composition and motion contract

- Homepage: an asymmetric editorial introduction with a dedicated vertical architectural image and visible product invitation, followed by a large product stage. Product selection animates a shared selection indicator and the incoming real content. Capabilities, model breadth, origin, metering, pricing and platforms each retain their own content job and distinct shape.
- Auth: a focused access surface centered on its real form, a smaller offset material study and concise product identity. No full-height photograph rail or caption pasted over imagery. Form focus and submit state remain immediate.
- Recovery: oversized semantic error identifier on the page ground, compact stable copy and deterministic actions. An architectural image is supporting, never more prominent than recovery.
- Legal and engineering: editorial document frame with a separate route index and readable article. Legal text stays byte-for-byte unchanged.
- Shares: deliberate public reading/document frame; source/preview/report/version and sandbox contracts remain intact. Download becomes a platform-specific introduction, not another landscape hero.
- Motion: one public primitive owns entry/scroll sequence and measured pointer feedback; continuous values use motion values, never React state. Motion communicates hierarchy, content selection or acknowledged hover/press. All motion honors reduced motion, coarse pointers and visibility. No fake activity, decorative logo loop, scroll hijack or background shader.

Verification and final preflight will be recorded after the implementation, using live routes in both modes and phone widths, required checks before each local commit, and a production Lighthouse diagnostic.
