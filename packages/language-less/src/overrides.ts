/**
 * Variable definitions a bundle never uses.
 *
 * LESS evaluates variables lazily: within one scope the **last**
 * definition wins, and it wins for every use, including uses that come
 * before it in the source. So when a bundle's imports define the same
 * top-level variable twice, the earlier definition is dead in that
 * bundle — an edit to it changes nothing, and nothing says so.
 *
 * A bundle is a LESS file no other LESS file imports. Its evaluation
 * order is simulated by walking its imports in source order, interleaved
 * with its own definitions by line; `(css)` imports and `.css` paths are
 * not evaluated, and a file is evaluated once unless imported
 * `(multiple)`. A definition is reported only when it is dead in **every**
 * bundle that reaches it: a base value that one bundle overrides and
 * another uses — the deliberate theme pattern — is live. Imports inside a
 * block are not followed: what they define is scoped to that block, so
 * it neither overrides nor is overridden by the bundle's globals.
 *
 * Imports that do not resolve inside the repository can only add
 * definitions, so they never make a reported definition live.
 */

import { isExternal, resolveImport, type LessProject } from "./resolve.js";

export interface OverriddenVariable {
  file: string;
  line: number;
  name: string;
  value?: string;
  /** The definition that wins, in the first bundle (by path) that reaches both. */
  winner: { file: string; line: number; value?: string };
  /** Bundles in which this definition is evaluated, all of which override it. */
  bundles: string[];
}

interface Definition {
  file: string;
  line: number;
  name: string;
  value?: string;
}

export function findOverriddenVariables(project: LessProject): OverriddenVariable[] {
  const files = [...project.files.keys()].sort();
  const imported = new Set<string>();
  const targets = new Map<
    string,
    { line: number; path: string; options: string[]; nested: boolean; to?: string }[]
  >();
  for (const file of files) {
    const parsed = project.files.get(file)!;
    const list = parsed.imports.map((imp) => {
      const evaluated =
        !imp.options.includes("css") &&
        !isExternal(imp.path) &&
        (imp.options.includes("less") || !imp.path.toLowerCase().endsWith(".css"));
      const to = evaluated ? resolveImport(project, file, imp.path) : undefined;
      if (to !== undefined && project.files.has(to)) imported.add(to);
      return {
        line: imp.line,
        path: imp.path,
        options: imp.options,
        nested: imp.nested,
        ...(to !== undefined && project.files.has(to) ? { to } : {}),
      };
    });
    targets.set(file, list);
  }
  const bundles = files.filter((f) => !imported.has(f));

  // Per definition key: in how many bundles it was evaluated, and in how
  // many of those it lost.
  const seen = new Map<
    string,
    { def: Definition; bundles: string[]; lost: number; winner?: Definition }
  >();
  const key = (d: Definition): string => `${d.file}\0${d.line}\0${d.name}`;

  // `(multiple)` re-evaluates a file each time it is imported, so a chain
  // of files importing the next twice would cost 2^n visits. Each bundle
  // gets a budget proportional to the repository; one that runs out is
  // abandoned, and everything it reached counts as live there, so an
  // incomplete simulation can never produce a report.
  const budget = 4 * files.length + 64;
  for (const bundle of bundles) {
    const order: Definition[] = [];
    const evaluated = new Set<string>();
    let visits = 0;
    let abandoned = false;
    const visit = (file: string, stack: Set<string>): void => {
      if (abandoned || stack.has(file)) return;
      visits += 1;
      if (visits > budget) {
        abandoned = true;
        return;
      }
      stack.add(file);
      const parsed = project.files.get(file)!;
      const events: (
        | { line: number; def: Definition }
        | { line: number; to: string; multiple: boolean }
      )[] = [
        ...parsed.variables.map((v) => ({
          line: v.line,
          def: {
            file,
            line: v.line,
            name: v.name,
            ...(v.value !== undefined ? { value: v.value } : {}),
          },
        })),
        ...(targets.get(file) ?? [])
          .filter((t) => t.to !== undefined && !t.nested)
          .map((t) => ({
            line: t.line,
            to: t.to!,
            multiple: t.options.includes("multiple"),
          })),
      ];
      events.sort((a, b) => a.line - b.line || ("def" in a ? 1 : -1));
      for (const ev of events) {
        if ("def" in ev) order.push(ev.def);
        else if (ev.multiple || !evaluated.has(ev.to)) {
          evaluated.add(ev.to);
          visit(ev.to, stack);
        }
      }
      stack.delete(file);
    };
    evaluated.add(bundle);
    visit(bundle, new Set());

    if (abandoned) {
      for (const d of order) {
        const k = key(d);
        const entry = seen.get(k) ?? { def: d, bundles: [], lost: 0 };
        if (!entry.bundles.includes(bundle)) entry.bundles.push(bundle);
        seen.set(k, entry);
      }
      continue;
    }
    const last = new Map<string, Definition>();
    for (const d of order) last.set(d.name, d);
    const counted = new Set<string>();
    for (const d of order) {
      const k = key(d);
      if (counted.has(k)) continue;
      counted.add(k);
      const entry = seen.get(k) ?? { def: d, bundles: [], lost: 0 };
      entry.bundles.push(bundle);
      const winner = last.get(d.name)!;
      if (key(winner) !== k) {
        entry.lost += 1;
        entry.winner ??= winner;
      }
      seen.set(k, entry);
    }
  }

  const out: OverriddenVariable[] = [];
  for (const { def, bundles: reached, lost, winner } of seen.values()) {
    if (lost === 0 || lost < reached.length || winner === undefined) continue;
    out.push({
      ...def,
      winner: {
        file: winner.file,
        line: winner.line,
        ...(winner.value !== undefined ? { value: winner.value } : {}),
      },
      bundles: reached,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
