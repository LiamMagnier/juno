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
                  : "textbox";
        const label =
          (element.innerText || "").trim() ||
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          element.getAttribute("value") ||
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
      html: await current.content(),
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
