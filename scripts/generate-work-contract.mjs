/**
 * Emits the Swift half of the Juno Work vocabulary.
 *
 * Both halves derive from `contracts/work/juno-work-v1.json`, so the Swift
 * enums and the TypeScript unions cannot disagree: there is one file to change
 * and two outputs that follow from it. The capability manifest already proved
 * why this matters and where it stops short — it keeps Swift in step but leaves
 * the TypeScript union hand-written, so a value added to the manifest reaches
 * the Mac and never reaches the server. Here the TypeScript half
 * (src/lib/work/contract.ts) asserts this file against src/lib/work/domain.ts,
 * and this script asserts it against the checked-in Swift, which closes the
 * loop on all three.
 *
 * The Swift is generated rather than written because the failure it prevents is
 * silent: a client that cannot name a status renders a run it does not
 * understand as nothing at all, and nothing at all is what a user sees when a
 * task is waiting on their approval.
 *
 *   node scripts/generate-work-contract.mjs --output=<path>.swift
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const contractPath = resolve("contracts/work/juno-work-v1.json");
const outputArg = process.argv.find((value) => value.startsWith("--output="));
if (!outputArg) {
  throw new Error("Pass --output=/absolute/path/to/JunoWorkContract.swift");
}
const outputPath = resolve(outputArg.slice("--output=".length));

const source = await readFile(contractPath, "utf8");
const contract = JSON.parse(source);

if (typeof contract.version !== "number") {
  throw new Error("Work contract is missing a numeric version.");
}
if (!contract.vocabularies || typeof contract.vocabularies !== "object") {
  throw new Error("Work contract is missing its vocabularies.");
}

const vocabularies = Object.entries(contract.vocabularies);
if (vocabularies.length === 0) {
  throw new Error("Work contract declares no vocabularies.");
}

/**
 * Rejects a contract that would produce Swift that compiles but lies.
 *
 * Every check here is one a reader of the JSON would not catch: a value listed
 * twice becomes a duplicate Swift case (a compile error, which is fine), but an
 * attribute missing from a single value becomes a non-exhaustive switch, and an
 * attribute of the wrong type becomes a Bool that reads `"false"`.
 */
for (const [id, vocabulary] of vocabularies) {
  for (const field of ["constant", "swiftEnum", "summary"]) {
    if (typeof vocabulary[field] !== "string" || vocabulary[field].length === 0) {
      throw new Error(`Vocabulary "${id}" is missing ${field}.`);
    }
  }
  if (!Array.isArray(vocabulary.values) || vocabulary.values.length === 0) {
    throw new Error(`Vocabulary "${id}" lists no values.`);
  }

  const seen = new Set();
  for (const entry of vocabulary.values) {
    if (typeof entry.value !== "string" || entry.value.length === 0) {
      throw new Error(`Vocabulary "${id}" has a value with no name.`);
    }
    if (typeof entry.summary !== "string" || entry.summary.length === 0) {
      throw new Error(`"${id}.${entry.value}" has no summary; every value must say what it means.`);
    }
    if (seen.has(entry.value)) {
      throw new Error(`"${id}" lists "${entry.value}" twice.`);
    }
    seen.add(entry.value);
  }

  for (const attribute of vocabulary.attributes ?? []) {
    if (typeof attribute.name !== "string" || typeof attribute.summary !== "string") {
      throw new Error(`Vocabulary "${id}" has an attribute with no name or summary.`);
    }
    if (attribute.type === "reference") {
      const referenced = contract.vocabularies[attribute.vocabulary];
      if (!referenced) {
        throw new Error(
          `"${id}.${attribute.name}" refers to vocabulary "${attribute.vocabulary}", which does not exist.`,
        );
      }
    } else if (!["boolean", "string", "integer"].includes(attribute.type)) {
      throw new Error(`"${id}.${attribute.name}" has unsupported type "${attribute.type}".`);
    }

    for (const entry of vocabulary.values) {
      const held = entry[attribute.name];
      if (held === undefined) {
        throw new Error(`"${id}.${entry.value}" is missing the ${attribute.name} attribute.`);
      }
      if (attribute.type === "boolean" && typeof held !== "boolean") {
        throw new Error(`"${id}.${entry.value}.${attribute.name}" must be a boolean.`);
      }
      if (attribute.type === "integer" && !Number.isSafeInteger(held)) {
        throw new Error(`"${id}.${entry.value}.${attribute.name}" must be an integer.`);
      }
      if (attribute.type === "string" && typeof held !== "string") {
        throw new Error(`"${id}.${entry.value}.${attribute.name}" must be a string.`);
      }
      if (attribute.type === "reference") {
        const referenced = contract.vocabularies[attribute.vocabulary];
        if (!referenced.values.some((candidate) => candidate.value === held)) {
          throw new Error(
            `"${id}.${entry.value}.${attribute.name}" is "${held}", which "${attribute.vocabulary}" does not list.`,
          );
        }
      }
    }
  }
}

/** Digest of the contract text, so a client can prove which one it was built from. */
const digest = createHash("sha256").update(source).digest("hex");

/**
 * Swift keywords that also happen to be Juno Work values.
 *
 * `public` and `internal` are sensitivity levels here and declaration modifiers
 * there, so the case names have to be back-ticked. Escaping the wider keyword
 * set costs nothing and means a future value named `default` or `operator`
 * generates rather than failing to compile.
 */
const SWIFT_KEYWORDS = new Set([
  "Any", "as", "associatedtype", "await", "break", "case", "catch", "class", "continue", "default",
  "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil",
  "open", "operator", "precedencegroup", "private", "protocol", "public", "repeat", "rethrows",
  "return", "self", "Self", "static", "struct", "subscript", "super", "switch", "throw", "throws",
  "true", "try", "typealias", "var", "where", "while",
]);

/** `waiting_input` and `work.file.permanent_delete` both become one Swift identifier. */
const swiftCase = (value) => {
  const identifier = value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");
  return SWIFT_KEYWORDS.has(identifier) ? `\`${identifier}\`` : identifier;
};

const escape = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const swiftType = (attribute) => {
  switch (attribute.type) {
    case "boolean":
      return "Bool";
    case "integer":
      return "Int";
    case "string":
      return "String";
    default:
      return contract.vocabularies[attribute.vocabulary].swiftEnum;
  }
};

const swiftLiteral = (attribute, held) => {
  switch (attribute.type) {
    case "boolean":
      return held ? "true" : "false";
    case "integer":
      return String(held);
    case "string":
      return `"${escape(held)}"`;
    default:
      return `.${swiftCase(held)}`;
  }
};

/**
 * One computed property per attribute, as an exhaustive switch.
 *
 * A dictionary keyed by case would be shorter and would return an optional,
 * which every call site would then have to unwrap with a default — and the
 * default is exactly where the wrong answer gets invented. A switch over a
 * generated enum cannot miss a case.
 */
const emitAttribute = (vocabulary, attribute) => {
  const lines = [
    "",
    `    /// ${attribute.summary}`,
    `    public var ${attribute.name}: ${swiftType(attribute)} {`,
    "        switch self {",
  ];
  for (const entry of vocabulary.values) {
    lines.push(`        case .${swiftCase(entry.value)}: return ${swiftLiteral(attribute, entry[attribute.name])}`);
  }
  lines.push("        }", "    }");
  return lines;
};

const emitVocabulary = (vocabulary) => {
  const conformances = ["String", "CaseIterable", "Codable", "Sendable"];
  if (vocabulary.ordered) conformances.push("Comparable");

  const lines = [`/// ${vocabulary.summary}`, `public enum ${vocabulary.swiftEnum}: ${conformances.join(", ")} {`];
  for (const entry of vocabulary.values) {
    lines.push(`    /// ${entry.summary}`);
    lines.push(`    case ${swiftCase(entry.value)} = "${escape(entry.value)}"`);
  }
  for (const attribute of vocabulary.attributes ?? []) {
    lines.push(...emitAttribute(vocabulary, attribute));
  }
  if (vocabulary.ordered) {
    lines.push(
      "",
      "    /// Ordering follows the contract's own order, so a comparison between two",
      "    /// of these is answered the same way on both platforms.",
      "    private var rank: Int {",
      `        ${vocabulary.swiftEnum}.allCases.firstIndex(of: self) ?? 0`,
      "    }",
      "",
      `    public static func < (lhs: ${vocabulary.swiftEnum}, rhs: ${vocabulary.swiftEnum}) -> Bool {`,
      "        lhs.rank < rhs.rank",
      "    }",
    );
  }
  lines.push("}");
  return lines.join("\n");
};

const swift = `// Generated by scripts/generate-work-contract.mjs. Do not edit.
//
// Source of truth: contracts/work/juno-work-v1.json
// The TypeScript half (src/lib/work/contract.ts) derives from the same file and
// asserts it against src/lib/work/domain.ts, so the three cannot drift. CI
// regenerates this and fails on a diff.
import Foundation

public enum JunoWorkContract {
    /// Bumped whenever a value is added or its meaning changes.
    public static let version = ${contract.version}
    /// SHA-256 of the contract this was generated from.
    public static let digest = "${digest}"
}

${vocabularies.map(([, vocabulary]) => emitVocabulary(vocabulary)).join("\n\n")}
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, swift, "utf8");
console.log(
  `Wrote ${outputPath} (work contract v${contract.version}, ${vocabularies.length} vocabularies, digest ${digest.slice(0, 12)}…)`,
);
