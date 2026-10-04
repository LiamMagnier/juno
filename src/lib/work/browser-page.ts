import type { Page } from "playwright";
import type { BrowserElement, BrowserPageState } from "./browser";

/** How many interactive elements one snapshot names. Mirrors the tool's cap. */
export const MAX_ELEMENTS = 60;

/**
 * What a page looks like when it is asking for a card.
 */
export const PAYMENT_FIELD =
  /card[-_ ]?number|credit[-_ ]?card|(^|[^a-z])(cvv|cvc|csc)([^a-z]|$)|security[-_ ]?code/i;

export async function snapshotPage(
  current: Page,
  navigationTimeout = 25_000
): Promise<{ page: BrowserPageState; elements: BrowserElement[]; takesPayment: boolean }> {
  await current
    .waitForLoadState("domcontentloaded", { timeout: navigationTimeout })
    .catch(() => {});
  const collected = (await current.evaluate(
    (options: { max: number; payment: string }) => {
      const { max } = options;
      const paymentField = new RegExp(options.payment, "i");
      const selector =
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
      const found: Array<{
        ref: number;
        role: string;
        label: string;
        href?: string;
        submits?: boolean;
        method?: "get" | "post";
      }> = [];
      let ref = 0;
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (found.length >= max) break;
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        if (!visible) continue;

        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        const role =
          tag === "a"
            ? "link"
            : tag === "button" || type === "submit" || type === "button"
              ? "button"
              : tag === "select"
                ? "dropdown"
                : tag === "input" && (type === "checkbox" || type === "radio")
                  ? type
                  : tag === "input" && type === "password"
                    ? "password field"
                    : "textbox";
        // A secret input's value is never a label: a password typed during a
        // takeover, or mirrored into the attribute by a framework, would
        // otherwise reach the model on the next read.
        const autocompleteHint = (element.getAttribute("autocomplete") ?? "").toLowerCase();
        const secretInput =
          tag === "input" &&
          (type === "password" ||
            type === "hidden" ||
            /one-time-code|current-password|new-password|cc-/.test(autocompleteHint));
        const label =
          (element.innerText || "").trim() ||
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          (secretInput ? "" : element.getAttribute("value")) ||
          element.getAttribute("title") ||
          "";
        const submits =
          Boolean(element.closest("form")) &&
          ((tag === "button" && (type === "" || type === "submit")) ||
            (tag === "input" && (type === "submit" || type === "image")));

        const form = element.closest("form");
        const method =
          form === null
            ? undefined
            : (form.method || "get").toLowerCase() === "get"
              ? "get"
              : "post";

        ref += 1;
        element.setAttribute("data-juno-ref", String(ref));
        found.push({
          ref,
          role,
          label: label.replace(/\s+/g, " ").slice(0, 80),
          ...(tag === "a" ? { href: element.getAttribute("href") ?? "" } : {}),
          ...(submits ? { submits: true } : {}),
          ...(method ? { method } : {}),
        });
      }

      const takesPayment = Array.from(document.querySelectorAll("input")).some(
        (input) => {
          const autocomplete = (input.getAttribute("autocomplete") ?? "").toLowerCase();
          if (autocomplete.includes("cc-number") || autocomplete.includes("cc-csc"))
            return true;
          return paymentField.test(
            `${input.getAttribute("name") ?? ""} ${input.getAttribute("id") ?? ""} ${input.getAttribute("placeholder") ?? ""}`
          );
        }
      );
      return { found, takesPayment };
    },
    { max: MAX_ELEMENTS, payment: PAYMENT_FIELD.source }
  )) as {
    found: BrowserElement[];
    takesPayment: boolean;
  };

  return {
    page: {
      url: current.url(),
      title: await current.title().catch(() => ""),
      html: redactSecretInputs(await current.content()),
      elements: collected.found,
    },
    elements: collected.found,
    takesPayment: collected.takesPayment,
  };
}

export function selectorForElement(
  elements: BrowserElement[],
  target: { ref?: number; selector?: string }
): { selector: string } | { refusal: string } {
  if (typeof target.ref === "number") {
    const known = elements.some((element) => element.ref === target.ref);
    if (!known) {
      return {
        refusal: `There is nothing numbered ${target.ref} on the page you last read. Read the page again and use a number from that list.`,
      };
    }
    return { selector: `[data-juno-ref="${target.ref}"]` };
  }
  if (target.selector) return { selector: target.selector };
  return { refusal: "A ref or a selector is required." };
}

export async function submitsFormOnPage(
  current: Page,
  selector: string
): Promise<boolean> {
  return current
    .$eval(selector, (node) => {
      const element = node as HTMLElement;
      if (!element.closest("form")) return false;
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      return (
        (tag === "button" && (type === "" || type === "submit")) ||
        (tag === "input" && (type === "submit" || type === "image"))
      );
    })
    .catch(() => false);
}

export function describeBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/**
 * Strip the value of every secret-shaped input from serialized HTML before it
 * leaves the browser driver: password, hidden, one-time-code and card fields.
 * `page.content()` serializes attributes, and a site that mirrors what was
 * typed into `value` (common for controlled inputs) would otherwise hand the
 * model a password the person typed during a takeover, or one a credential
 * fill injected. Pure, so it is tested without a browser.
 */
const INPUT_TAG = /<input\b[^>]*>/gi;
const SECRET_INPUT_SHAPE =
  /\btype\s*=\s*["']?(?:password|hidden)\b|\bautocomplete\s*=\s*["']?[^"'>]*(?:one-time-code|current-password|new-password|cc-)/i;
const VALUE_ATTRIBUTE = /\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function redactSecretInputs(html: string): string {
  return html.replace(INPUT_TAG, (tag) =>
    SECRET_INPUT_SHAPE.test(tag) ? tag.replace(VALUE_ATTRIBUTE, ' value="[hidden]"') : tag,
  );
}

/** What kind of field a target is, read by trusted code, never by the model. */
export type FieldKind = "password" | "secret" | "text" | "other";

export async function fieldKindOnPage(current: Page, selector: string): Promise<FieldKind | null> {
  return (await current
    .evaluate((sel: string) => {
      const element = document.querySelector(sel);
      if (!element) return null;
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
      if (tag === "input" && type === "password") return "password";
      if (tag === "input" && /one-time-code|cc-/.test(autocomplete)) return "secret";
      if ((tag === "input" && ["text", "email", "tel", "search", "url", ""].includes(type)) || tag === "textarea") {
        return "text";
      }
      return "other";
    }, selector)
    .catch(() => null)) as FieldKind | null;
}

/**
 * Typing into a password or one-time-code field is refused for the model:
 * a password the model can type is a password the model has seen. Saved
 * credentials go through `fill_credential`, which the broker redeems.
 */
export const SECRET_FIELD_REFUSAL =
  'That is a password or one-time-code field. Alevr does not type secrets the model knows. If this task was granted a saved credential for this site, use action "fill_credential" with its reference; otherwise ask the user to take over and type it themselves.';
