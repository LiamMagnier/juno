"use client";

/**
 * Last-resort error boundary.
 *
 * `global-error` replaces the root layout, so it catches the one class of
 * failure nothing else can: an exception thrown *by* `app/layout.tsx` itself.
 * That layout awaits `auth()`, which hits the database on every request — so
 * any database outage (Neon suspended, compute quota exhausted, pooler
 * unreachable) took the whole site down to Next's bare white
 * "Application error: a server-side exception has occurred" page. This renders
 * something that at least looks like Juno and tells the visitor to come back.
 *
 * Deliberately self-contained: no globals.css, no next/font, no shared
 * component. The root layout is what provides those, and the root layout is
 * exactly what has already failed by the time we get here. Colours are the two
 * brand backgrounds inlined (light `#faf9f6` / dark `#16140f`, matching the
 * `themeColor` viewport entries), switched on `prefers-color-scheme` because
 * next-themes — which normally puts `.dark` on <html> — is not mounted either.
 */

const STYLES = `
  .juno-fallback-body {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem 1.25rem;
    background: #faf9f6;
    color: #1f1e1c;
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    -webkit-font-smoothing: antialiased;
  }
  .juno-fallback-card {
    width: 100%;
    max-width: 30rem;
    text-align: center;
  }
  .juno-fallback-mark {
    width: 2.5rem;
    height: 2.5rem;
    margin: 0 auto;
    display: block;
  }
  .juno-fallback-eyebrow {
    margin: 1.75rem 0 0;
    font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8a6d3f;
  }
  .juno-fallback-title {
    margin: 0.5rem 0 0;
    font-size: 1.5rem;
    font-weight: 500;
    line-height: 1.25;
  }
  .juno-fallback-copy {
    margin: 0.75rem 0 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 0.875rem;
    line-height: 1.6;
    color: #6b6862;
  }
  .juno-fallback-actions {
    margin-top: 1.75rem;
    display: flex;
    gap: 0.625rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .juno-fallback-button {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 0.875rem;
    padding: 0.5rem 1.125rem;
    border-radius: 10px;
    border: 1px solid #e5dfd2;
    background: #ffffff;
    color: #1f1e1c;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  .juno-fallback-button:hover { border-color: #cfc6b3; }
  .juno-fallback-button--primary {
    background: #1f1e1c;
    border-color: #1f1e1c;
    color: #faf9f6;
  }
  .juno-fallback-button--primary:hover { background: #38352f; border-color: #38352f; }
  .juno-fallback-digest {
    margin: 1.5rem 0 0;
    font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
    font-size: 0.6875rem;
    color: #9a968d;
    word-break: break-all;
  }
  @media (prefers-color-scheme: dark) {
    .juno-fallback-body { background: #16140f; color: #f0ece1; }
    .juno-fallback-mark { filter: invert(1); }
    .juno-fallback-eyebrow { color: #c9a86a; }
    .juno-fallback-copy { color: #a8a297; }
    .juno-fallback-button { background: #211e19; border-color: #38342c; color: #f0ece1; }
    .juno-fallback-button:hover { border-color: #4d4840; }
    .juno-fallback-button--primary { background: #f0ece1; border-color: #f0ece1; color: #16140f; }
    .juno-fallback-button--primary:hover { background: #ffffff; border-color: #ffffff; }
    .juno-fallback-digest { color: #6f6a60; }
  }
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="juno-fallback-body">
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <main className="juno-fallback-card">
          {/* Plain <img>, not next/image: the optimizer is itself a server route. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/juno-mark.png" alt="Juno" width={512} height={512} className="juno-fallback-mark" />
          <p className="juno-fallback-eyebrow">Temporarily unavailable</p>
          <h1 className="juno-fallback-title">Juno can&rsquo;t reach its backend</h1>
          <p className="juno-fallback-copy">
            Your conversations are safe — the server just can&rsquo;t read them right now. This is on our side, not
            yours. Try again in a few minutes.
          </p>
          <div className="juno-fallback-actions">
            <button type="button" onClick={reset} className="juno-fallback-button juno-fallback-button--primary">
              Try again
            </button>
            {/* A real document load, not a client nav: the point is to ask the
                server to render the root layout again from scratch. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="juno-fallback-button">
              Reload Juno
            </a>
          </div>
          {error.digest && <p className="juno-fallback-digest">Reference: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
