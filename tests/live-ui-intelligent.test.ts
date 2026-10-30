import test from "node:test";
import assert from "node:assert/strict";
import { LiveScope } from "@/lib/live-ui/expr";
import { liveDefaults, parseLiveUI } from "@/lib/live-ui/spec";
import { liveUISummaryLines } from "@/lib/live-ui/summary";
import { scaleQuantity } from "@/components/chat/live-ui/live-ui-intelligent";

/* The intelligent-UI views (docs/design/LIVE_UI.md §2.4): what the parser
   keeps, forgives and drops, and how a recipe scales. */

const one = (view: unknown) => {
  const { spec, error } = parseLiveUI(JSON.stringify(view));
  assert.ok(spec, error);
  return spec!;
};

test("a recipe keeps quantities, forgives strings, and needs ingredients or steps", () => {
  const spec = one({ ui: [{ type: "recipe", servings: "4", ingredients: ["salt", { name: "flour", qty: 250, unit: "g" }, { qty: 2 }], steps: ["Mix.", { text: "Bake.", minutes: 25 }] }] });
  const r = spec.ui[0];
  assert.equal(r.type, "recipe");
  if (r.type !== "recipe") return;
  assert.equal(r.servings, 4);
  assert.equal(r.yieldLabel, "servings");
  assert.deepEqual(r.ingredients.map((i) => i.name), ["salt", "flour"]);
  assert.equal(r.steps[1].minutes, 25);
  assert.equal(one({ ui: [{ type: "recipe", ingredients: [], steps: [] }, { type: "text", text: "x" }] }).ui.length, 1);
});

test("choices need two options; a bare string sends itself", () => {
  const spec = one({ ui: [{ type: "choices", question: "Which?", options: ["A", { label: "B", prompt: "I pick B" }] }, { type: "choices", options: ["only"] }] });
  assert.equal(spec.ui.length, 1);
  const c = spec.ui[0];
  if (c.type !== "choices") return assert.fail(c.type);
  assert.deepEqual(c.options.map((o) => o.prompt), ["A", "I pick B"]);
  assert.equal(c.multi, false);
});

test("compare keeps a valid recommendation only; cards clamp ratings; aliases resolve", () => {
  const spec = one({
    ui: [
      { type: "versus", recommend: 5, options: [{ name: "A", pros: ["x"] }, { name: "B", cons: ["y"] }] },
      { type: "places", items: [{ title: "Café", rating: 9, tags: ["a", "b", "c", "d", "e"] }] },
      { type: "deck", cards: [{ front: "Q", back: "A" }, { front: "no back" }] },
    ],
  });
  const [cmp, cards, deck] = spec.ui;
  if (cmp.type !== "compare" || cards.type !== "cards" || deck.type !== "flashcards") return assert.fail("types");
  assert.equal(cmp.recommend, undefined);
  assert.equal(cards.items[0].rating, 5);
  assert.equal(cards.items[0].tags.length, 4);
  assert.equal(deck.cards.length, 1);
});

test("tabs hold ordinary components, and every new view prints a summary", () => {
  const spec = one({
    ui: [
      { type: "tabs", tabs: [{ label: "One", children: [{ type: "text", text: "Hello" }] }, { label: "Two", children: [{ type: "callout", text: "Note" }] }] },
      { type: "recipe", servings: 2, ingredients: [{ name: "eggs", qty: 3 }], steps: [{ text: "Whisk.", minutes: 1 }] },
    ],
  });
  const lines = liveUISummaryLines(spec);
  for (const want of ["One", "Hello", "Two", "Note", "For 2 servings", "• 3 eggs", "1. Whisk. (1 min)"]) assert.ok(lines.includes(want), want);
});

test("an input inside a tab has its default in scope before the reader touches it", () => {
  const spec = one({
    let: { total: "price * qty" },
    ui: [
      {
        type: "tabs",
        tabs: [
          { label: "Plan", children: [{ type: "slider", id: "price", label: "Price", min: 0, max: 100, value: 20 }] },
          { label: "Order", children: [{ type: "stepper", id: "qty", label: "Qty", min: 1, max: 10, value: 3 }, { type: "metric", label: "Total", value: "total" }] },
        ],
      },
    ],
  });
  assert.deepEqual(liveDefaults(spec), { price: 20, qty: 3 });
  assert.equal(new LiveScope({ inputs: liveDefaults(spec), lets: spec.lets, data: spec.data }).evaluate("total").value, 60);
});

test("a recipe scales like a cook: grams to kg, whole things stay whole, spoons snap to fractions", () => {
  assert.deepEqual(scaleQuantity(2000, "g"), { qty: "2", unit: "kg" });
  assert.deepEqual(scaleQuantity(333.3, "g"), { qty: "335", unit: "g" });
  assert.equal(scaleQuantity(1.67, undefined, 1).qty, "1½");
  assert.equal(scaleQuantity(0.2, "head", 1).qty, "½");
  assert.equal(scaleQuantity(0.83, "bunch", 0.5).qty, "¾");
  assert.equal(scaleQuantity(1.33, "tbsp", 1).qty, "1⅓");
});
