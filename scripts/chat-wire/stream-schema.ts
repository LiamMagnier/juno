/**
 * Project the chat stream's `StreamChunk` union (src/types/chat.ts) to JSON
 * Schema.
 *
 * The request side is a zod schema and goes through `z.toJSONSchema`, the way
 * the Design contract does. The stream side has no zod schema: it is a
 * TypeScript union the route builds frames against, so the only honest source
 * is the type itself. This walks it with the compiler's own checker, which
 * means a field added to a frame (or to a type a frame carries, like
 * `ClientMessage`) changes the projection without anyone mirroring it by hand.
 *
 * Shape only: no descriptions, so a comment edit in chat.ts never drifts the
 * contract. Named interfaces and aliases become `$defs`; anonymous object
 * literals stay inline; string-literal unions become sorted `enum`s so an
 * unrelated file creating the same literal first cannot reorder them.
 */
import ts from "typescript";
import { resolve } from "node:path";

export type JsonSchema = { [key: string]: unknown };

export interface StreamProjection {
  /** One schema per union member, in declaration order. */
  variants: JsonSchema[];
  /** Every named type the variants reach, by name. */
  defs: Record<string, JsonSchema>;
}

const PRIMITIVE_ALIASES = new Set(["Record", "Partial", "Readonly", "Pick", "Omit", "Exclude", "Extract", "NonNullable"]);

export function projectStreamUnion(root: string, typeName = "StreamChunk"): StreamProjection {
  const file = resolve(root, "src/types/chat.ts");
  const program = ts.createProgram([file], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: { "@/*": ["./src/*"] },
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
    resolveJsonModule: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`[chat-wire] cannot read ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`[chat-wire] ${file} is not a module`);
  const exported = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === typeName);
  if (!exported) throw new Error(`[chat-wire] ${file} does not export ${typeName}`);
  const union = checker.getDeclaredTypeOfSymbol(exported);

  const defs: Record<string, JsonSchema> = {};
  const inProgress = new Set<string>();

  const position = (type: ts.Type): string => {
    const declaration = type.symbol?.declarations?.[0] ?? type.aliasSymbol?.declarations?.[0];
    if (!declaration) return "~";
    const where = declaration.getSourceFile().fileName;
    return `${where}:${String(declaration.getStart()).padStart(9, "0")}`;
  };

  const definitionName = (type: ts.Type): string | null => {
    const alias = type.aliasSymbol;
    if (alias && !PRIMITIVE_ALIASES.has(alias.name) && !(type.aliasTypeArguments?.length)) {
      return alias.name;
    }
    const symbol = type.symbol;
    if (symbol && symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class) && !isGenericReference(type)) {
      return symbol.name;
    }
    return null;
  };

  const isGenericReference = (type: ts.Type): boolean =>
    !!(type.flags & ts.TypeFlags.Object) &&
    !!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) &&
    ((type as ts.TypeReference).typeArguments?.length ?? 0) > 0;

  const literalEnum = (members: readonly ts.Type[]): JsonSchema | null => {
    if (members.length && members.every((member) => member.flags & ts.TypeFlags.StringLiteral)) {
      const values = members.map((member) => (member as ts.StringLiteralType).value).sort();
      return values.length === 1 ? { type: "string", const: values[0] } : { type: "string", enum: values };
    }
    if (members.length && members.every((member) => member.flags & ts.TypeFlags.NumberLiteral)) {
      const values = members.map((member) => (member as ts.NumberLiteralType).value).sort((a, b) => a - b);
      return values.length === 1 ? { type: "number", const: values[0] } : { type: "number", enum: values };
    }
    return null;
  };

  const objectSchema = (type: ts.Type): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = declaration
        ? checker.getTypeOfSymbolAtLocation(property, declaration)
        : checker.getTypeOfSymbol(property);
      if (propertyType.getCallSignatures().length) continue;
      properties[property.name] = convert(propertyType);
      if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
    }
    const schema: JsonSchema = { type: "object", properties };
    if (required.length) schema.required = required;
    const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (index) schema.additionalProperties = convert(index.type);
    return schema;
  };

  const convertUnion = (members: readonly ts.Type[]): JsonSchema => {
    let rest = members.filter((member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    const nullable = rest.some((member) => member.flags & ts.TypeFlags.Null);
    rest = rest.filter((member) => !(member.flags & ts.TypeFlags.Null));
    const hasTrue = rest.some((member) => member.flags & ts.TypeFlags.BooleanLiteral && (member as { intrinsicName?: string }).intrinsicName === "true");
    const hasFalse = rest.some((member) => member.flags & ts.TypeFlags.BooleanLiteral && (member as { intrinsicName?: string }).intrinsicName === "false");
    const branches: JsonSchema[] = [];
    if (hasTrue && hasFalse) {
      branches.push({ type: "boolean" });
      rest = rest.filter((member) => !(member.flags & ts.TypeFlags.BooleanLiteral));
    }
    const strings = rest.filter((member) => member.flags & ts.TypeFlags.StringLiteral);
    if (strings.length) {
      branches.push(literalEnum(strings)!);
      rest = rest.filter((member) => !(member.flags & ts.TypeFlags.StringLiteral));
    }
    for (const member of [...rest].sort((a, b) => position(a).localeCompare(position(b)))) {
      branches.push(convert(member));
    }
    if (nullable) branches.push({ type: "null" });
    if (branches.length === 1) return branches[0];
    // `T | null` for a scalar T reads better as a type list than as anyOf.
    if (
      branches.length === 2 &&
      nullable &&
      typeof branches[0].type === "string" &&
      Object.keys(branches[0]).every((key) => key === "type" || key === "enum")
    ) {
      const [first] = branches;
      return first.enum
        ? { type: [first.type, "null"], enum: [...(first.enum as unknown[]), null] }
        : { type: [first.type, "null"] };
    }
    return { anyOf: branches };
  };

  function convert(type: ts.Type): JsonSchema {
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.StringLiteral) return { type: "string", const: (type as ts.StringLiteralType).value };
    if (flags & ts.TypeFlags.NumberLiteral) return { type: "number", const: (type as ts.NumberLiteralType).value };
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return { type: "boolean", const: (type as { intrinsicName?: string }).intrinsicName === "true" };
    }

    const name = definitionName(type);
    if (name && (type.isUnion() || flags & ts.TypeFlags.Object || type.isIntersection())) {
      if (!defs[name] && !inProgress.has(name)) {
        inProgress.add(name);
        defs[name] = convertStructure(type);
        inProgress.delete(name);
      }
      return { $ref: `#/$defs/${name}` };
    }
    return convertStructure(type);
  }

  function convertStructure(type: ts.Type): JsonSchema {
    if (type.isUnion()) return convertUnion(type.types);
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: element ? convert(element) : {} };
    }
    if (checker.isTupleType(type)) {
      return { type: "array", prefixItems: checker.getTypeArguments(type as ts.TypeReference).map(convert) };
    }
    if (type.flags & ts.TypeFlags.Object || type.isIntersection()) return objectSchema(type);
    return {};
  }

  if (!union.isUnion()) throw new Error(`[chat-wire] ${typeName} is not a union`);
  const variants = [...union.types]
    .sort((a, b) => position(a).localeCompare(position(b)))
    .map((variant) => objectSchema(variant));

  const sortedDefs: Record<string, JsonSchema> = {};
  for (const key of Object.keys(defs).sort()) sortedDefs[key] = defs[key];
  return { variants, defs: sortedDefs };
}
