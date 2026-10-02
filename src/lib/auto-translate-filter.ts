/**
 * What AutoTranslate leaves alone, and which DOM mutations it bothers to look
 * at (SPEC §10.4).
 *
 * A streaming answer mutates its text node on every token, a run clock every
 * second, a reasoning excerpt every few hundred milliseconds. None of that is
 * translatable UI copy — it is marked `data-no-auto-translate`, or it is code,
 * or it is what the user typed — but the old scanner walked the whole body on
 * every mutation anyway. These two functions are the decisions that stop it:
 * one prunes excluded subtrees from a walk, the other drops mutation records
 * that happen inside them before they can schedule a scan.
 *
 * Pure and DOM-free (over minimal `ElementLike` / `MutationRecordLike`
 * shapes), so they are unit-tested without jsdom (§13 harness rule 4).
 */

/** Never translated: opted out, verbatim, typed by the user, or not text at all. */
export const EXCLUDED_SELECTOR = [
  "[data-no-auto-translate]",
  "[translate='no']",
  "[contenteditable='true']",
  "code",
  "pre",
  "script",
  "style",
  "svg",
  "math",
  "textarea",
].join(",");

/**
 * The same list for attributes, minus `textarea`: a textarea's content is the
 * user's, but its `placeholder` is UI copy ("Message Juno…").
 */
export const ATTRIBUTE_EXCLUDED_SELECTOR = EXCLUDED_SELECTOR.split(",")
  .filter((selector) => selector !== "textarea")
  .join(",");

export interface ElementLike {
  closest(selector: string): unknown;
  tagName: string;
  getAttribute(name: string): string | null;
}

/** A node as a mutation record carries it: an element, or a text node with its parent element. */
export interface NodeLike {
  nodeType: number;
  parentElement?: ElementLike | null;
}

export interface MutationRecordLike {
  type: "childList" | "characterData" | "attributes" | string;
  target: NodeLike;
  addedNodes?: ArrayLike<NodeLike>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function asElement(node: NodeLike | null | undefined): ElementLike | null {
  if (!node) return null;
  if (node.nodeType === ELEMENT_NODE) return node as unknown as ElementLike;
  return node.parentElement ?? null;
}

/**
 * Whether `element` sits in a subtree AutoTranslate must not touch. `purpose`
 * "attributes" lets a textarea's placeholder through.
 */
export function isExcludedFromTranslation(element: ElementLike | null, purpose: "text" | "attributes" = "text"): boolean {
  if (!element) return false;
  return Boolean(element.closest(purpose === "attributes" ? ATTRIBUTE_EXCLUDED_SELECTOR : EXCLUDED_SELECTOR));
}

/**
 * The roots worth rescanning after a batch of mutations. A record inside an
 * excluded subtree is dropped whole — a token appended to a streaming answer
 * never schedules a scan. Otherwise the record's target (an attribute or text
 * change) or its added nodes (a subtree inserted) become dirty roots, each
 * once.
 */
export function filterMutations<N extends NodeLike>(records: ReadonlyArray<MutationRecordLike & { target: N; addedNodes?: ArrayLike<N> }>): N[] {
  const roots: N[] = [];
  const seen = new Set<N>();
  const add = (node: N) => {
    if (seen.has(node)) return;
    seen.add(node);
    roots.push(node);
  };
  for (const record of records) {
    const target = asElement(record.target);
    if (isExcludedFromTranslation(target, record.type === "attributes" ? "attributes" : "text")) continue;
    if (record.type === "childList") {
      for (const node of Array.from(record.addedNodes ?? [])) {
        if (node.nodeType !== ELEMENT_NODE && node.nodeType !== TEXT_NODE) continue;
        if (node.nodeType === ELEMENT_NODE && isExcludedFromTranslation(node as unknown as ElementLike)) continue;
        add(node);
      }
      continue;
    }
    add(record.target);
  }
  return roots;
}
