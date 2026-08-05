/**
 * Generate the language-neutral design contract from the zod schemas.
 *
 * The zod schemas in src/lib/design/schema.ts are the source of truth — they are
 * what actually validates a document at runtime. This script projects them to
 * JSON Schema so the Swift `Codable` types have something executable to be
 * checked against, and so a schema change nobody mirrored fails CI instead of
 * failing on a user's Mac.
 *
 *   npx tsx scripts/generate-design-contract.ts           # write
 *   npx tsx scripts/generate-design-contract.ts --check   # verify, exit 1 on drift
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { designDocumentSchema } from "../src/lib/design/schema";
import { designOperationSchema, designTransactionSchema } from "../src/lib/design/operations";
import { DESIGN_SCHEMA_VERSION } from "../src/lib/design/types";

const output = resolve(process.cwd(), "contracts/design/design-document.v1.schema.json");

// `reused: "ref"` hoists repeated sub-schemas into $defs. Without it the
// projection inlines every paint, stroke and constraint block at every use
// site and the contract balloons past 800 KB of duplicated JSON.
const project = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any", reused: "ref" });

const contract = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://juno.app/contracts/design/design-document.v1.schema.json",
  title: "Juno Design document",
  description:
    "The persisted scene model for a Juno Design artifact, plus the operation and transaction envelopes every edit travels in. Generated from src/lib/design/schema.ts and src/lib/design/operations.ts — do not edit by hand; run `npm run design:contract`.",
  designSchemaVersion: DESIGN_SCHEMA_VERSION,
  $defs: {
    DesignDocument: project(designDocumentSchema),
    DesignOperation: project(designOperationSchema),
    DesignTransaction: project(designTransactionSchema),
  },
  $ref: "#/$defs/DesignDocument",
};

const serialized = `${JSON.stringify(contract, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(output, "utf8");
  } catch {
    console.error(`[design-contract] ${output} is missing. Run: npm run design:contract`);
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error("[design-contract] The generated contract is out of date. Run: npm run design:contract");
    process.exit(1);
  }
  console.log("[design-contract] up to date");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialized);
  console.log(`[design-contract] wrote ${output}`);
}
