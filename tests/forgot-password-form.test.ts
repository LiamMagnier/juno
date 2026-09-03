/**
 * The two states of `ForgotPasswordForm`, driven by the server's email flag.
 *
 * The forgot-password route is the one auth surface whose usefulness depends on
 * server configuration rather than on the user: without `RESEND_API_KEY` the
 * reset email cannot go out, so the form must say so and stop taking input
 * instead of accepting addresses it can never serve. The e2e suite covers the
 * page through a real browser, but only where a server happens to be running —
 * these unit tests pin both states so a regression in either is caught by
 * `npm test` alone. `renderToStaticMarkup` is the closest a `tsx --test`
 * process gets to the DOM, as in work-report-preview.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

function render(emailEnabled: boolean): string {
  return renderToStaticMarkup(createElement(ForgotPasswordForm, { emailEnabled }));
}

/** The opening tag of the email input, attributes included. */
function emailInputTag(html: string): string {
  const match = html.match(/<input\b[^>]*>/);
  assert.ok(match, "the email input must render in both states");
  return match[0];
}

/**
 * Whether a tag carries the actual `disabled` attribute. A bare /\bdisabled\b/
 * would false-positive on Tailwind's `disabled:` variant classes sitting in
 * the class attribute, so the word must be the attribute itself (React writes
 * `disabled=""`), not a `disabled:` class prefix.
 */
function hasDisabledAttribute(tag: string): boolean {
  return /(?:^|\s)disabled(?:=|>|\s|$)/.test(tag);
}

/** React's text output with entity escaping undone, as visible prose. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

test("without email configured the field and action are disabled behind an explanatory note", () => {
  const html = render(false);

  // The field is disabled — collecting an address the server cannot serve
  // would only end in a silent no-op for the requester.
  const input = emailInputTag(html);
  assert.ok(hasDisabledAttribute(input), "the email input must be disabled when email is off");

  // The submit action is disabled with it; there is nothing to submit to.
  const submit = html.match(/<button\b[^>]*type="submit"[^>]*>/);
  assert.ok(submit, "the submit button must render");
  assert.ok(hasDisabledAttribute(submit[0]), "the submit button must be disabled when email is off");

  // The reason is announced as a note (the e2e asserts on this role too), and
  // the copy says email is the missing piece rather than blaming the address.
  assert.match(html, /role="note"/, "the unavailable state must be announced as a note");
  assert.match(visibleText(html), /email.*not set up|email.*isn.t configured/i);
});

test("without email configured the form still renders as a form, not an error wall", () => {
  const html = render(false);

  // The e2e (and a human who clicked "Forgot password") still expects the
  // sign-in anatomy: labelled email field, a visible action, and the way back.
  assert.match(html, /<form\b/);
  assert.match(html, /for="forgot-email"/, "the email field keeps its label");
  assert.match(visibleText(html), /Back to sign in/);
});

test("with email configured the controls are live and no note renders", () => {
  const html = render(true);

  const input = emailInputTag(html);
  assert.ok(!hasDisabledAttribute(input), "the email input must be enabled when email is on");

  const submit = html.match(/<button\b[^>]*type="submit"[^>]*>/);
  assert.ok(submit, "the submit button must render");
  assert.ok(!hasDisabledAttribute(submit[0]), "the submit button must be enabled when email is on");

  assert.doesNotMatch(html, /role="note"/, "the unavailable note must not render when email is on");
});
