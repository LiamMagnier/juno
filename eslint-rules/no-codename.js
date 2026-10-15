/**
 * brand/no-codename — the product is called Alevr everywhere a person reads.
 *
 * "Juno" is the repository's codename. It stays in identifiers, file and folder
 * names, storage keys, env vars, database names, bundle ids, routes and URLs,
 * where renaming would break running clients for no reader's benefit. It must
 * never reach a sentence: an error, a toast, a title, a download name, an
 * email, or a prompt the model may repeat back. Display names come from
 * `src/lib/brand/names.ts` (`PRODUCT_NAME`), so a sentence that names the
 * product reads `${PRODUCT_NAME} could not reach …`.
 *
 * The rule looks at string literals, template-literal text and JSX text for
 * the capitalised word. Lower-case `juno` is left alone on purpose: it is the
 * spelling of the stable identifiers (`juno:composer-seed`, `juno_runtime`).
 *
 * Two kinds of literal are protocol rather than prose and are allowed:
 *
 *   - the value of a `User-Agent` header (names.ts: the User-Agent the server
 *     sends keeps its stable spelling, so third parties' allowlists hold);
 *   - an HTTP header name beginning `X-Juno-`, which native clients and
 *     scripts read by that exact name.
 *
 * Anything else that genuinely has to say the codename takes an
 * `eslint-disable-next-line brand/no-codename -- <why>` at the line.
 *
 * CommonJS for the same reason as no-arbitrary-text.js: this package declares
 * no `type`, so a plain `.js` file here parses as CJS.
 */

const CODENAME = /\bJuno\b/;
const HEADER_NAME = /^x-juno-/i;
const USER_AGENT_KEY = /^user-agent$/i;
const USER_AGENT_CONSTANT = /^user_?agent$/i;

/** True when `text` names the codename as a word (pure, shared with tests). */
function namesCodename(text) {
  return typeof text === "string" && CODENAME.test(text) && !HEADER_NAME.test(text.trim());
}

function propertyKeyName(property) {
  if (!property || property.type !== "Property") return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

/** The literal is (part of) the value of a `User-Agent` property. */
function isUserAgentValue(node) {
  let current = node;
  // Walk up through a template literal or a concatenation to the property.
  while (current.parent && (current.parent.type === "TemplateLiteral" || current.parent.type === "BinaryExpression")) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) return false;
  if (parent.type === "Property" && parent.value === current) return USER_AGENT_KEY.test(propertyKeyName(parent) ?? "");
  // `const USER_AGENT = \`… Juno/1.0 …\`` — a header value held in a constant first.
  if (parent.type === "VariableDeclarator" && parent.init === current && parent.id.type === "Identifier") {
    return USER_AGENT_CONSTANT.test(parent.id.name);
  }
  return false;
}

const MESSAGE =
  "Users never see the codename. Write the product's name with PRODUCT_NAME from @/lib/brand/names (or \"Alevr\" where that module cannot be imported).";

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the codename \"Juno\" in user-visible strings; the product is Alevr.",
    },
    schema: [],
    messages: { codename: MESSAGE },
  },
  namesCodename,
  create(context) {
    const report = (node) => context.report({ node, messageId: "codename" });
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        // An import or export path is a file name, not prose.
        const parent = node.parent;
        if (parent && (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" || parent.type === "ExportAllDeclaration" || parent.type === "ImportExpression")) return;
        // A property KEY is an identifier spelled as a string.
        if (parent && parent.type === "Property" && parent.key === node && !parent.computed) return;
        if (!namesCodename(node.value)) return;
        if (isUserAgentValue(node)) return;
        report(node);
      },
      TemplateElement(node) {
        const text = node.value.cooked ?? node.value.raw;
        if (!namesCodename(text)) return;
        if (isUserAgentValue(node)) return;
        report(node);
      },
      JSXText(node) {
        if (namesCodename(node.value)) report(node);
      },
    };
  },
};
