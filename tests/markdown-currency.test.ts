import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  CURRENCY_SENTINEL,
  protectCurrency,
  remarkRestoreCurrency,
  restoreCurrency,
} from "@/components/chat/markdown-currency";

/*
 * Prices in a research report rendered as italic KaTeX with the spaces eaten
 * ("100–250priceband,ClaudeMax5x("). These are the exact strings from that
 * report, parsed by the same remark pipeline the chat and the report reader
 * use, and the real maths that must keep working beside them.
 */

const BAND = "$100–$250 price band, Claude Max 5x ($100/month)";
const ALTERNATIVE =
  "ChatGPT Pro $100 ($100/month) is the alternative when ecosystem breadth matters more than raw coding throughput, and $200 buys the higher tier.";

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

function parse(markdown: string): Node {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRestoreCurrency);
  return processor.runSync(processor.parse(protectCurrency(markdown))) as Node;
}

function collect(node: Node, type: string, out: string[] = []): string[] {
  if (node.type === type && typeof node.value === "string") out.push(node.value);
  node.children?.forEach((child) => collect(child, type, out));
  return out;
}

const text = (node: Node) => collect(node, "text").join("");

test("the price band from the report is prose, not maths", () => {
  const tree = parse(BAND);
  assert.deepEqual(collect(tree, "inlineMath"), []);
  assert.equal(text(tree), BAND);
});

test("the alternative paragraph keeps every dollar and every space", () => {
  const tree = parse(ALTERNATIVE);
  assert.deepEqual(collect(tree, "inlineMath"), []);
  assert.equal(text(tree), ALTERNATIVE);
});

test("both paragraphs together, as the report wrote them", () => {
  const tree = parse(`${BAND}\n\n${ALTERNATIVE}`);
  assert.deepEqual(collect(tree, "inlineMath"), []);
  assert.match(text(tree), /\$100–\$250 price band/);
  assert.match(text(tree), /ChatGPT Pro \$100 \(\$100\/month\) is the alternative/);
});

test("unprotected, remark-math does read the band as maths (the bug this guards)", () => {
  const processor = unified().use(remarkParse).use(remarkMath);
  const tree = processor.runSync(processor.parse(BAND)) as Node;
  assert.ok(collect(tree, "inlineMath").length > 0);
});

test("real inline maths still renders", () => {
  assert.deepEqual(collect(parse("Energy is $E = mc^2$ here."), "inlineMath"), ["E = mc^2"]);
  assert.deepEqual(collect(parse("Area $x^2$ and $2^{10}$."), "inlineMath"), ["x^2", "2^{10}"]);
  assert.deepEqual(collect(parse("A lone $2$ is a formula."), "inlineMath"), ["2"]);
});

test("display maths and the backslash forms are untouched", () => {
  const display = parse("$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$");
  assert.equal(collect(display, "math").length, 1);
  const inline = "Cost $5 then \\(y = 2\\) holds.";
  assert.equal(protectCurrency(inline), `Cost ${CURRENCY_SENTINEL}5 then \\(y = 2\\) holds.`);
});

test("a price beside a formula: the price stays prose, the formula stays maths", () => {
  const tree = parse("It costs $5, and $x+1$ is odd.");
  assert.deepEqual(collect(tree, "inlineMath"), ["x+1"]);
  assert.match(text(tree), /It costs \$5, and/);
});

test("prose that opens on a figure is money even when the TeX closer rule would pass", () => {
  const tree = parse("Plans run from $5 a month to 10$ in some regions.");
  assert.deepEqual(collect(tree, "inlineMath"), []);
});

test("code is verbatim and the length never changes (source offsets depend on it)", () => {
  const fenced = "```sh\necho $100 $HOME\n```";
  assert.equal(protectCurrency(fenced), fenced);
  const inlineCode = "Run `echo $5` for $5.";
  assert.equal(protectCurrency(inlineCode), `Run \`echo $5\` for ${CURRENCY_SENTINEL}5.`);
  for (const sample of [BAND, ALTERNATIVE, inlineCode, fenced]) {
    assert.equal(protectCurrency(sample).length, sample.length);
    assert.equal(restoreCurrency(protectCurrency(sample)), sample);
  }
});

test("an escaped dollar stays an escape", () => {
  assert.equal(protectCurrency("\\$5 and \\$6"), "\\$5 and \\$6");
});

test("a dollar inside a link's text is restored", () => {
  const tree = parse("[Pro at $100](https://example.com/pricing)");
  assert.equal(text(tree), "Pro at $100");
});
