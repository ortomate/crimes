import ts from "typescript";
import {
  calleeTail,
  endLineOf,
  isExported,
  receiverPath,
  startLineOf,
  stringLiteralText,
  unwrap,
} from "./ast-util.js";
import type { ContractField, ContractSource, ObjectContract } from "./types.js";

/**
 * Object-contract extraction — the parser half of `contract_drift`.
 *
 * A "contract" here is any declaration that pins down the shape of a
 * record: what fields exist, whether each is required, and what each one
 * holds. The detector's job is to notice when the same record is pinned
 * down twice and the two pinnings disagree.
 *
 * ## Supported forms
 *
 * | form                              | example                                   |
 * | --------------------------------- | ----------------------------------------- |
 * | `interface`                       | `interface User { id: string }`            |
 * | object type alias                 | `type User = { id: string }`               |
 * | Zod object schema                 | `const User = z.object({ id: z.string() })`|
 * | Valibot object schema             | `const User = v.object({ id: v.string() })`|
 *
 * Zod and Valibot are in because they are already in the dependency
 * surface of the ecosystem this detector targets and both express
 * optionality and enums structurally, so the field-level comparison is
 * exact rather than guessed. Support is **syntactic** — no module
 * resolution, no type checker — so a schema built by a helper
 * (`makeSchema()`) is not captured, and that is the right trade: a
 * contract nobody can read statically is a contract this detector cannot
 * responsibly compare.
 *
 * ## Deliberately unsupported
 *
 * JSON Schema, OpenAPI, GraphQL SDL, and ORM model definitions. Each is a
 * separate parsing problem living in a separate file format, and each
 * would need its own resolution rules before a field-level comparison
 * could be trusted. Adding them later is additive: the detector consumes
 * {@link ObjectContract}, not the syntax that produced it.
 *
 * ## Partial contracts
 *
 * A declaration that extends, intersects, or spreads something the
 * collector did not expand is marked `partial`. The detector must never
 * report a "missing field" against a partial contract — the field may
 * well be present via the part that wasn't expanded.
 */

/** Cap per file. A generated `.d.ts` can hold thousands of interfaces. */
const MAX_CONTRACTS_PER_FILE = 80;

/** Below this, two contracts sharing fields is coincidence. */
export const MIN_CONTRACT_FIELDS = 2;

const ZOD_RECEIVERS = /^(z|zod)$/;
const VALIBOT_RECEIVERS = /^(v|valibot)$/;

export function collectObjectContract(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: ObjectContract[],
): void {
  if (out.length >= MAX_CONTRACTS_PER_FILE) return;

  if (ts.isInterfaceDeclaration(node)) {
    const fields = membersToFields(node.members, sourceFile);
    if (fields.length < MIN_CONTRACT_FIELDS) return;
    out.push({
      name: node.name.text,
      source: "interface",
      exported: isExported(node),
      line: startLineOf(node, sourceFile),
      endLine: endLineOf(node, sourceFile),
      fields,
      partial: (node.heritageClauses?.length ?? 0) > 0,
    });
    return;
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const parsed = typeAliasContract(node, sourceFile);
    if (parsed) out.push(parsed);
    return;
  }

  if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
    const schema = schemaContract(
      node.name.text,
      unwrap(node.initializer),
      sourceFile,
      isExportedVariable(node),
    );
    if (schema) out.push(schema);
  }
}

function typeAliasContract(
  node: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
): ObjectContract | undefined {
  // `type User = { … }` — the plain case.
  if (ts.isTypeLiteralNode(node.type)) {
    const fields = membersToFields(node.type.members, sourceFile);
    if (fields.length < MIN_CONTRACT_FIELDS) return undefined;
    return {
      name: node.name.text,
      source: "type_literal",
      exported: isExported(node),
      line: startLineOf(node, sourceFile),
      endLine: endLineOf(node, sourceFile),
      fields,
      partial: false,
    };
  }

  // `type User = Base & { … }` — expand only the literal members and mark
  // the result partial so no "missing field" claim is ever made from it.
  if (ts.isIntersectionTypeNode(node.type)) {
    const fields: ContractField[] = [];
    let sawOpaque = false;
    for (const member of node.type.types) {
      if (ts.isTypeLiteralNode(member)) {
        fields.push(...membersToFields(member.members, sourceFile));
      } else {
        sawOpaque = true;
      }
    }
    if (fields.length < MIN_CONTRACT_FIELDS) return undefined;
    return {
      name: node.name.text,
      source: "type_literal",
      exported: isExported(node),
      line: startLineOf(node, sourceFile),
      endLine: endLineOf(node, sourceFile),
      fields: dedupeFields(fields),
      partial: sawOpaque,
    };
  }

  return undefined;
}

function membersToFields(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile,
): ContractField[] {
  const fields: ContractField[] = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue;
    const name = memberName(member.name, sourceFile);
    if (name === undefined) continue;
    const typeNode = member.type;
    const rendered = typeNode
      ? renderType(typeNode, sourceFile)
      : { text: "unknown", nullable: false, nested: false, enumMembers: undefined };

    const field: ContractField = {
      name,
      type: rendered.text,
      optional: member.questionToken !== undefined,
      nullable: rendered.nullable,
      nested: rendered.nested,
      line: startLineOf(member, sourceFile),
    };
    if (rendered.enumMembers) field.enumMembers = rendered.enumMembers;
    fields.push(field);
  }
  return fields;
}

interface RenderedType {
  text: string;
  nullable: boolean;
  nested: boolean;
  enumMembers?: string[];
}

/**
 * Normalise a type node to a comparable string.
 *
 * `null` and `undefined` members are lifted out of unions into the
 * `nullable` flag so `string | null` and `string` compare as "same base
 * type, different nullability" rather than as two unrelated types — the
 * distinction the detector actually wants to report.
 */
function renderType(node: ts.TypeNode, sourceFile: ts.SourceFile): RenderedType {
  if (ts.isUnionTypeNode(node)) {
    const parts: string[] = [];
    let nullable = false;
    let nested = false;
    const literals: string[] = [];
    let allLiterals = true;

    for (const member of node.types) {
      if (isNullLike(member)) {
        nullable = true;
        continue;
      }
      const rendered = renderType(member, sourceFile);
      nested = nested || rendered.nested;
      parts.push(rendered.text);
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        literals.push(member.literal.text);
      } else {
        allLiterals = false;
      }
    }
    const result: RenderedType = {
      text: [...parts].sort().join(" | ") || "never",
      nullable,
      nested,
    };
    if (allLiterals && literals.length > 0) result.enumMembers = [...literals].sort();
    return result;
  }

  if (ts.isArrayTypeNode(node)) {
    const inner = renderType(node.elementType, sourceFile);
    return { text: `${inner.text}[]`, nullable: false, nested: inner.nested };
  }

  if (ts.isTypeLiteralNode(node)) {
    const keys = node.members
      .map((m) =>
        ts.isPropertySignature(m) ? memberName(m.name, sourceFile) : undefined,
      )
      .filter((n): n is string => n !== undefined)
      .sort();
    return { text: `{${keys.join(",")}}`, nullable: false, nested: true };
  }

  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) {
      return {
        text: JSON.stringify(literal.text),
        nullable: false,
        nested: false,
        enumMembers: [literal.text],
      };
    }
    if (isNullLike(node)) return { text: "null", nullable: true, nested: false };
    return { text: literal.getText(sourceFile), nullable: false, nested: false };
  }

  const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  return { text, nullable: false, nested: false };
}

function isNullLike(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  return false;
}

function memberName(
  name: ts.PropertyName | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  void sourceFile;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Runtime validation schemas (Zod / Valibot)
 * ------------------------------------------------------------------ */

/**
 * `const User = z.object({ id: z.string(), role: z.enum(["admin"]) })`.
 *
 * Chained refinements on the *object* (`.strict()`, `.partial()`) are
 * walked through to reach the `z.object(...)` call. `.partial()` flips
 * every field to optional, which the collector honours — otherwise it
 * would report a drift that the schema author explicitly declared.
 */
function schemaContract(
  name: string,
  init: ts.Expression,
  sourceFile: ts.SourceFile,
  exported: boolean,
): ObjectContract | undefined {
  const found = findObjectSchemaCall(init);
  if (!found) return undefined;

  const arg = found.call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;

  const fields: ContractField[] = [];
  let partial = false;
  for (const prop of arg.properties) {
    if (ts.isSpreadAssignment(prop)) {
      partial = true;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const fieldName = memberName(prop.name, sourceFile);
    if (fieldName === undefined) continue;
    const described = describeSchemaField(unwrap(prop.initializer), found.library);
    fields.push({
      name: fieldName,
      type: described.type,
      optional: described.optional || found.allOptional,
      nullable: described.nullable,
      nested: described.nested,
      line: startLineOf(prop, sourceFile),
      ...(described.enumMembers ? { enumMembers: described.enumMembers } : {}),
    });
  }

  if (fields.length < MIN_CONTRACT_FIELDS) return undefined;

  return {
    name,
    source: found.library,
    exported,
    line: startLineOf(init, sourceFile),
    endLine: endLineOf(init, sourceFile),
    fields,
    partial,
  };
}

interface FoundSchema {
  call: ts.CallExpression;
  library: ContractSource;
  /** `.partial()` was applied somewhere in the chain. */
  allOptional: boolean;
}

function findObjectSchemaCall(expr: ts.Expression): FoundSchema | undefined {
  let allOptional = false;
  let cur: ts.Expression = unwrap(expr);

  for (let depth = 0; depth < 12; depth++) {
    if (!ts.isCallExpression(cur)) return undefined;
    const tail = calleeTail(cur);
    if (tail === undefined) return undefined;

    if (tail === "object") {
      // The receiver of `.object` names the library. It must be a bare
      // identifier — `z` / `v` / `zod` / `valibot` — because a schema
      // reached through some other object is not one this collector can
      // vouch for.
      const receiver = receiverPath(cur);
      if (receiver !== undefined && ZOD_RECEIVERS.test(receiver)) {
        return { call: cur, library: "zod", allOptional };
      }
      if (receiver !== undefined && VALIBOT_RECEIVERS.test(receiver)) {
        return { call: cur, library: "valibot", allOptional };
      }
      return undefined;
    }

    if (tail === "partial") allOptional = true;

    // Walk left through the chain: `z.object({…}).strict()` →
    // the receiver of `.strict` is the `z.object({…})` call.
    if (ts.isPropertyAccessExpression(cur.expression)) {
      cur = unwrap(cur.expression.expression);
      continue;
    }
    return undefined;
  }
  return undefined;
}

interface DescribedField {
  type: string;
  optional: boolean;
  nullable: boolean;
  nested: boolean;
  enumMembers?: string[];
}

/**
 * Reduce a schema expression to a comparable field description.
 *
 * `z.string().optional()` → `{ type: "string", optional: true }`.
 * `v.optional(v.string())` → the same, from Valibot's wrapper form.
 */
function describeSchemaField(
  expr: ts.Expression,
  library: ContractSource,
): DescribedField {
  const result: DescribedField = {
    type: "unknown",
    optional: false,
    nullable: false,
    nested: false,
  };

  let cur: ts.Expression = unwrap(expr);
  const chain: string[] = [];

  // Valibot expresses modifiers as wrappers: `v.optional(v.string())`.
  for (let depth = 0; depth < 12; depth++) {
    if (!ts.isCallExpression(cur)) break;
    const tail = calleeTail(cur);
    if (tail === undefined) break;

    if (
      library === "valibot" &&
      (tail === "optional" || tail === "nullable" || tail === "nullish") &&
      cur.arguments.length > 0
    ) {
      if (tail === "optional" || tail === "nullish") result.optional = true;
      if (tail === "nullable" || tail === "nullish") result.nullable = true;
      cur = unwrap(cur.arguments[0]!);
      continue;
    }

    chain.push(tail);

    if (tail === "enum" || tail === "picklist") {
      const arg = cur.arguments[0];
      if (arg && ts.isArrayLiteralExpression(arg)) {
        const members = arg.elements
          .map((e) => stringLiteralText(unwrap(e as ts.Expression)))
          .filter((v): v is string => v !== undefined);
        if (members.length > 0) result.enumMembers = [...members].sort();
      }
    }
    if (tail === "literal") {
      const arg = cur.arguments[0];
      const value = arg ? stringLiteralText(unwrap(arg)) : undefined;
      if (value !== undefined) result.enumMembers = [value];
    }
    if (tail === "object") result.nested = true;

    if (ts.isPropertyAccessExpression(cur.expression)) {
      cur = unwrap(cur.expression.expression);
      continue;
    }
    break;
  }

  // The chain is innermost-last: `z.string().min(1).optional()` collects
  // `["optional", "min", "string"]`.
  for (const link of chain) {
    if (link === "optional") result.optional = true;
    else if (link === "nullable") result.nullable = true;
    else if (link === "nullish") {
      result.optional = true;
      result.nullable = true;
    }
  }

  const base = chain.find((link) => SCHEMA_BASE_TYPES.has(link));
  if (base !== undefined) {
    result.type = SCHEMA_TYPE_ALIASES[base] ?? base;
  } else if (result.enumMembers) {
    result.type = result.enumMembers
      .map((m) => JSON.stringify(m))
      .sort()
      .join(" | ");
  }

  if (chain.includes("array")) result.type = `${result.type}[]`;

  return result;
}

/** Base-type constructors both libraries share, plus each one's extras. */
const SCHEMA_BASE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "date",
  "object",
  "array",
  "enum",
  "picklist",
  "literal",
  "record",
  "map",
  "set",
  "any",
  "unknown",
  "null",
  "undefined",
  "void",
  "never",
]);

/**
 * Map schema base names onto the TypeScript spelling so a Zod schema and
 * an interface describing the same record compare field-for-field.
 */
const SCHEMA_TYPE_ALIASES: Record<string, string> = {
  date: "Date",
  object: "object",
  picklist: "enum",
};

function isExportedVariable(node: ts.VariableDeclaration): boolean {
  // `export const X = …` — the modifier lives on the VariableStatement,
  // two levels up from the declaration.
  const list = node.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  const statement = list.parent;
  if (!statement || !ts.isVariableStatement(statement)) return false;
  return isExported(statement);
}

function dedupeFields(fields: ContractField[]): ContractField[] {
  const byName = new Map<string, ContractField>();
  for (const field of fields) {
    // Later members of an intersection win, matching TS's own resolution.
    byName.set(field.name, field);
  }
  return [...byName.values()];
}
