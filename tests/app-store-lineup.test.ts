import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_STORE_PRODUCT_IDS, planFromAppStoreProductId } from "@/lib/billing/app-store";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every paid tier has a monthly and a yearly App Store product", () => {
  for (const [slug, plan] of [["lite", "LITE"], ["pro", "PRO"], ["plus", "PLUS"], ["max", "MAX"], ["max20", "MAX20"], ["ultra", "ULTRA"]] as const) {
    assert.equal(planFromAppStoreProductId(`com.liammagnier.juno.${slug}.monthly`), plan);
    assert.equal(planFromAppStoreProductId(`com.liammagnier.juno.${slug}.yearly`), plan);
  }
  assert.equal(Object.keys(APP_STORE_PRODUCT_IDS).length, 12);
});

test("the documented product list matches the server's", () => {
  const doc = readFileSync(path.join(ROOT, "docs/pricing/APP_STORE_PRODUCTS.md"), "utf8");
  for (const id of Object.keys(APP_STORE_PRODUCT_IDS)) assert.ok(doc.includes(`\`${id}\``), `${id} is documented`);
});
