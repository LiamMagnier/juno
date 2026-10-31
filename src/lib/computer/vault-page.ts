import "server-only";
import type { Page } from "playwright";
import type { LoginFieldKind, LoginFields, LoginPagePort } from "./vault-fill";

/**
 * The fill's hands in the agent computer's Chromium (docs/design/agents-v2/VAULT.md):
 * a field locator that runs in the page's main document, and CDP
 * `Input.insertText` for the typing, over the Playwright connection the
 * computer's browser already holds (remote-browser.ts `withPage`).
 *
 * The URL is Playwright's record of the main frame's address, which the
 * browser reports, never something the page says about itself. Only the main
 * document is searched, and a field is typed into only when the document's
 * focused element is that very input, so a cross-origin frame on the page
 * can never be the thing that receives a value. Nothing here reads a field's
 * value back, only its length.
 */

/*
 * Runs inside the page. A string rather than a function, like
 * DESCRIBE_TARGET_SCRIPT in remote-browser.ts: the runner is executed through a
 * transpiler that may wrap functions in helpers the page does not have.
 */
export const LOGIN_FIELDS_SCRIPT = String.raw`(function (arg) {
  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
  }
  function kind(el) { return String(el.getAttribute("type") || "text").toLowerCase(); }
  function words(el) {
    return [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("autocomplete"), el.getAttribute("aria-label"), el.getAttribute("placeholder")]
      .join(" ").toLowerCase();
  }
  var TEXTY = { text: 1, email: 1, tel: 1, number: 1, search: 0 };
  var inputs = Array.prototype.slice.call(document.querySelectorAll("input")).filter(visible);
  var isOtp = function (el) {
    var auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.indexOf("one-time-code") >= 0) return true;
    if (!TEXTY[kind(el)]) return false;
    return /(^|[^a-z])(otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|security.?code|twofactor|two.?factor)([^a-z]|$)/.test(words(el));
  };
  var password = null, otp = null, username = null, i;
  for (i = 0; i < inputs.length; i++) {
    if (!password && kind(inputs[i]) === "password" && !isOtp(inputs[i])) password = inputs[i];
    if (!otp && isOtp(inputs[i])) otp = inputs[i];
  }
  var isUser = function (el) {
    if (isOtp(el) || !TEXTY[kind(el)] || kind(el) === "number") return false;
    var auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.indexOf("username") >= 0 || auto.indexOf("email") >= 0) return true;
    if (kind(el) === "email") return true;
    return /(user|email|e-mail|login|account|identifier|signin|sign-in)/.test(words(el));
  };
  if (password) {
    // The field before the password in the same form: the username of this form.
    var before = null;
    for (i = 0; i < inputs.length; i++) {
      if (inputs[i] === password) break;
      if (inputs[i].form === password.form && TEXTY[kind(inputs[i])] && !isOtp(inputs[i]) && kind(inputs[i]) !== "number") before = inputs[i];
    }
    username = before;
  } else {
    for (i = 0; i < inputs.length; i++) if (isUser(inputs[i])) { username = inputs[i]; break; }
  }
  var pick = { username: username, password: password, otp: otp };
  if (arg.action === "probe") return { username: !!username, password: !!password, otp: !!otp };
  if (arg.action === "focus") {
    var el = pick[arg.kind];
    if (!el) return false;
    el.focus();
    try {
      el.select();
      if (el.value && (el.selectionStart !== 0 || el.selectionEnd !== el.value.length)) el.value = "";
    } catch (e) {
      el.value = "";
    }
    return document.activeElement === el;
  }
  if (arg.action === "length") {
    var active = document.activeElement;
    if (!active || String(active.tagName).toLowerCase() !== "input") return null;
    return String(active.value || "").length;
  }
  return null;
})`;

/** The slice of a Playwright page the port uses. */
export interface LoginPage {
  url(): string;
  isClosed(): boolean;
  evaluate(expression: string): Promise<unknown>;
  context(): { newCDPSession(page: never): Promise<{ send(method: "Input.insertText", params: { text: string }): Promise<unknown>; detach(): Promise<void> }> };
}

/** A browser that can lend its page (the computer's, remote-browser.ts). */
export interface PageLender {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

export function canLendPage(browser: unknown): browser is PageLender {
  return typeof (browser as Partial<PageLender> | null)?.withPage === "function";
}

function readFields(raw: unknown): LoginFields | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return { username: value.username === true, password: value.password === true, otp: value.otp === true };
}

/** The port over one page (exported for tests with a stand-in page). */
export function loginPagePortFor(withPage: <T>(fn: (page: LoginPage) => Promise<T>) => Promise<T>): LoginPagePort {
  const run = (arg: { action: "probe" } | { action: "focus"; kind: LoginFieldKind } | { action: "length" }) =>
    withPage((page) => page.evaluate(`${LOGIN_FIELDS_SCRIPT}(${JSON.stringify(arg)})`));
  return {
    url: () => withPage(async (page) => (page.isClosed() ? "" : page.url())),
    fields: async () => readFields(await run({ action: "probe" })),
    focus: async (kind) => (await run({ action: "focus", kind })) === true,
    insertText: (text) =>
      withPage(async (page) => {
        const session = await page.context().newCDPSession(page as never);
        try {
          await session.send("Input.insertText", { text });
        } finally {
          await session.detach().catch(() => {});
        }
      }),
    focusedLength: async () => {
      const length = await run({ action: "length" });
      return typeof length === "number" && Number.isFinite(length) ? length : null;
    },
  };
}

/** The port over the computer browser's own page, or null for a browser that cannot lend one (the fake provider's). */
export function loginPagePort(browser: unknown): LoginPagePort | null {
  if (!canLendPage(browser)) return null;
  return loginPagePortFor((fn) => browser.withPage((page) => fn(page as unknown as LoginPage)));
}
