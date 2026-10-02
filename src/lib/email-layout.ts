/** One V3 envelope for transactional and work mail. Inline light styles are
 * the fallback for Outlook; capable clients get Newsreader/Inter and dark mode. */
import { env } from "@/lib/env";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const EMAIL_COLORS = { ground: "#fcfcfd", surface: "#ffffff", ink: "#191b1e", muted: "#686b70", edge: "#e3e4e6", well: "#eff0f1" } as const;
export const EMAIL_SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
export const EMAIL_SERIF = "Newsreader, Georgia, 'Times New Roman', serif";

export function emailAppUrl(path = ""): string { return `${env.appUrl.replace(/\/$/, "")}${path}`; }

export function escapeEmailHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[^\x00-\x7f]/gu, c => `&#${c.codePointAt(0)};`);
}

export function emailParagraph(html: string): string {
  return `<p class="alevr-email-copy" style="margin:0 0 16px;font-family:${EMAIL_SANS};font-size:14px;line-height:1.6;color:${EMAIL_COLORS.ink};">${html}</p>`;
}

export function renderEmailLayout(opts: {
  heading: string;
  /** Trusted template markup only; caller must escape any user content. */
  bodyHtml: string;
  cta: { label: string; href: string };
  context?: string;
  footer?: { label: string; href: string };
}): string {
  const { ground, surface, ink, muted, edge } = EMAIL_COLORS;
  const absolute = (path: string) => escapeEmailHtml(emailAppUrl(path));
  const footer = opts.footer ? `<a class="alevr-email-muted" href="${escapeEmailHtml(opts.footer.href)}" style="color:${muted};text-decoration:underline;">${escapeEmailHtml(opts.footer.label)}</a>` : "Go further.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeEmailHtml(opts.heading)}</title>
<style>
@font-face { font-family:Newsreader; src:url('${absolute("/fonts/newsreader-regular.ttf")}') format('truetype'); font-weight:400; }
@font-face { font-family:Inter; src:url('${absolute("/fonts/inter-latin.woff2")}') format('woff2'); font-weight:400 600; }
.alevr-email-logo-dark { display:none; }
@media(max-width:480px) { .alevr-email-content { padding:28px 24px !important; } }
@media(prefers-color-scheme:dark) {
  .alevr-email-ground { background-color:#18191b !important; }
  .alevr-email-content { background-color:#222326 !important; border-color:#37383c !important; }
  .alevr-email-copy, .alevr-email-heading { color:#e8e9eb !important; }
  .alevr-email-muted { color:#95979c !important; }
  .alevr-email-cta { background-color:#e8e9eb !important; color:#18191b !important; }
  .alevr-email-well { background-color:#2d2e31 !important; color:#e8e9eb !important; }
  .alevr-email-rule { border-color:#37383c !important; }
  .alevr-email-logo-light { display:none !important; }
  .alevr-email-logo-dark { display:block !important; }
}
</style></head>
<body class="alevr-email-ground" style="margin:0;background-color:${ground};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="alevr-email-ground" style="background-color:${ground};padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;"><tr><td class="alevr-email-content" style="background-color:${surface};border:1px solid ${edge};border-radius:12px;padding:36px;">
<a href="${absolute("")}" aria-label="${PRODUCT_NAME}" style="display:inline-block;margin:0 0 32px;text-decoration:none;">
<img class="alevr-email-logo-light" src="${absolute("/brand/email-lockup-light.png")}" alt="${PRODUCT_NAME}" width="116" height="28" style="display:block;border:0;width:116px;height:28px;">
<!--[if !mso]><!--><img class="alevr-email-logo-dark" src="${absolute("/brand/email-lockup-dark.png")}" alt="${PRODUCT_NAME}" width="116" height="28" style="display:none;border:0;width:116px;height:28px;"><!--<![endif]-->
</a>
<h1 class="alevr-email-heading" style="margin:0 0 20px;font-family:${EMAIL_SERIF};font-size:32px;font-weight:400;line-height:1.2;color:${ink};">${escapeEmailHtml(opts.heading)}</h1>
${opts.bodyHtml}
${opts.context ? `<p class="alevr-email-muted" style="margin:20px 0 0;font-family:${EMAIL_SANS};font-size:12px;line-height:1.5;color:${muted};">${escapeEmailHtml(opts.context)}</p>` : ""}
<p style="margin:28px 0 0;font-family:${EMAIL_SANS};font-size:14px;"><a class="alevr-email-cta" href="${escapeEmailHtml(opts.cta.href)}" style="display:inline-block;background-color:${ink};color:${ground};border-radius:8px;padding:12px 20px;font-weight:500;text-decoration:none;">${escapeEmailHtml(opts.cta.label)}</a></p>
</td></tr><tr><td align="center" style="padding:24px 8px 0;"><p class="alevr-email-muted" style="margin:0;font-family:${EMAIL_SANS};font-size:12px;line-height:1.6;color:${muted};">${PRODUCT_NAME} · ${footer}</p></td></tr></table>
</td></tr></table></body></html>`;
}
