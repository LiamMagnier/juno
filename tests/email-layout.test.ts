import test from "node:test";
import assert from "node:assert/strict";
import { renderEmailLayout, escapeEmailHtml, emailParagraph } from "@/lib/email-layout";
import { passwordReset, taskResult } from "@/lib/email-templates";
import { workNotificationEmail } from "@/lib/work/notify/email";

test("the shared email envelope escapes dynamic headings, link labels and URL attributes", () => {
  const html = renderEmailLayout({
    heading: 'Café <script>alert("x")</script>',
    bodyHtml: emailParagraph(escapeEmailHtml('<img src=x onerror="attack()">')),
    cta: { label: '<b>Open</b>', href: 'https://example.test/reset?a=1&b="quoted"' },
  });
  assert.doesNotMatch(html, /<script>|<img src=x|<b>Open/);
  assert.match(html, /Caf&#233; &lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.test\/reset\?a=1&amp;b=&quot;quoted&quot;"/);
  assert.match(html, /&lt;b&gt;Open&lt;\/b&gt;/);
});

test("recovery and task mail retain their actionable links, expiration and text alternatives", () => {
  const reset = passwordReset("https://example.test/reset?token=one-use");
  assert.match(reset.html, /expires in one hour/);
  assert.match(reset.text, /https:\/\/example.test\/reset\?token=one-use/);
  const result = taskResult("Research <draft>", "<script>untrusted</script>", "https://example.test/thread");
  assert.doesNotMatch(result.html, /<script>/);
  assert.match(result.html, /Research &lt;draft&gt;/);
  assert.match(result.text, /Open the thread: https:\/\/example.test\/thread/);
  assert.doesNotMatch(result.subject, /—/);
});

test("work mail retains the real requested action and both Continuum logo appearances", () => {
  const result = workNotificationEmail({
    message: { subject: "Review changes", summary: "Mira needs your approval.", action: "Review and decide" },
    urgency: "blocking", taskUrl: "https://example.test/task",
  });
  assert.match(result.html, /Waiting for you/);
  assert.match(result.html, /Review and decide/);
  assert.match(result.html, /email-lockup-light.png/);
  assert.match(result.html, /email-lockup-dark.png/);
  assert.match(result.html, /prefers-color-scheme:dark/);
  assert.doesNotMatch(result.html, /juno-mark|#faf7f0|#c2410c/);
  assert.match(result.text, /Mira needs your approval/);
});
