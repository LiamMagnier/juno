/* eslint-disable @next/next/no-html-link-for-pages -- Root recovery must navigate without the failed app router. */
"use client";

import { PRODUCT_NAME } from "@/lib/brand/names";
import { AlevrLockup } from "@/components/brand/alevr-lockup";

// This boundary replaces the root layout, so its V3 surface and font fallbacks
// must work without Providers, global CSS or an initialized theme context.
const STYLES = `
  :root { color-scheme: light dark; --foreground: 216 9.091% 10.784%; --background: 240 20% 99.020%; }
  * { box-sizing: border-box; }
  .alevr-dppx-hi { display:none; }
  @media(min-resolution:1.5dppx) { .alevr-dppx-lo { display:none; } .alevr-dppx-hi { display:inline; } }
  body { margin:0; min-height:100dvh; background:#fcfcfd; color:#191b1e; font-family:Inter,system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  header { padding:24px 32px; }
  header a { display:inline-flex; align-items:center; min-height:44px; color:inherit; }
  header a > span { position:relative; display:inline-block; flex-shrink:0; vertical-align:middle; }
  main { min-height:calc(100dvh - 100px); max-width:1120px; margin:auto; padding:64px 32px; display:grid; grid-template-columns:minmax(0,.7fr) minmax(0,1fr); gap:96px; align-items:center; }
  .code { margin:0; font-family:Newsreader,Georgia,serif; font-size:220px; line-height:1; letter-spacing:-.07em; color:currentColor; opacity:.28; }
  h1 { margin:0; font-family:Newsreader,Georgia,serif; font-size:48px; line-height:1.1; font-weight:400; letter-spacing:-.02em; text-wrap:balance; }
  p { margin:20px 0 0; color:#686b70; font-size:14px; line-height:1.6; }
  .actions { margin-top:32px; display:flex; flex-wrap:wrap; gap:12px; }
  .actions a,button { font:500 14px Inter,system-ui,sans-serif; min-height:44px; padding:12px 20px; border:0; border-radius:8px; color:#191b1e; background:#eff0f1; cursor:pointer; text-decoration:none; transition:background-color 120ms cubic-bezier(.33,1,.68,1); }
  .actions > :first-child { background:#191b1e; color:#fcfcfd; }
  .actions > :first-child:hover { background:#4e5054; }
  .actions a:hover { background:#e6e7e9; }
  :focus-visible { outline:2px solid #2d49c9; outline-offset:3px; }
  .reference { font-size:12px; overflow-wrap:anywhere; }
  @font-face { font-family:Inter; src:url('/fonts/inter-latin.woff2') format('woff2'); font-weight:400 600; font-display:swap; }
  @font-face { font-family:Newsreader; src:url('/fonts/newsreader-regular.ttf') format('truetype'); font-weight:400; font-display:swap; }
  @media(prefers-color-scheme:dark) {
    :root { --foreground:220 6.977% 91.569%; --background:220 5.882% 10%; }
    body { background:#18191b; color:#e8e9eb; } p { color:#95979c; }
    .actions a,button { background:#2d2e31; color:#e8e9eb; } .actions a:hover { background:#37383c; }
    .actions > :first-child { background:#e8e9eb; color:#18191b; } .actions > :first-child:hover { background:#b4b6ba; }
    :focus-visible { outline-color:#97a6e6; }
  }
  @media(max-width:767px) { header { padding:20px 24px; } main { grid-template-columns:minmax(0,1fr); padding:48px 24px; gap:40px; } h1 { font-size:40px; } .code { font-size:140px; } }
  @keyframes public-enter { from { opacity:.5; transform:translateY(24px); } to { opacity:1; transform:none; } }
  @media(prefers-reduced-motion:no-preference) { main h1 { animation:public-enter 650ms cubic-bezier(.33,1,.68,1) both; } main p { animation:public-enter 650ms cubic-bezier(.33,1,.68,1) 70ms both; } .actions { animation:public-enter 650ms cubic-bezier(.33,1,.68,1) 140ms both; } }
  @media(prefers-reduced-motion:reduce) { .actions a,button { transition:none; } }
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{`Something went wrong · ${PRODUCT_NAME}`}</title><meta name="robots" content="noindex" /></head>
      <body>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <header><a href="/" aria-label={`${PRODUCT_NAME} home`}><AlevrLockup height={26} tone="current" decorative /></a></header>
        <main>
          <div aria-hidden="true"><p className="code">500</p></div>
          <div>
          <h1>Something went wrong</h1>
          <p>We couldn’t load this page. Try again in a moment. Your saved work is still there.</p>
          <div className="actions"><button type="button" onClick={reset}>Try again</button><a href="/">Go to the home page</a></div>
          {error.digest && <p className="reference">Reference {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
