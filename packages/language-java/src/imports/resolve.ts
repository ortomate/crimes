/**
 * Java type resolution for the repo-wide import graph.
 *
 * Java differs from JS and Python in the way that matters most for blast
 * radius: a class uses every other class in its own package **without an
 * import**. Resolving `import` declarations alone gave a central
 * domain class — referenced by 187 files — a handful of edges. So an edge is
 * drawn for each of:
 *
 * 1. a single-type import (`import com.acme.om.Film;`), whether or
 *    not the name is used;
 * 2. a referenced simple name declared in the file's own package;
 * 3. a referenced simple name declared in a package the file imports on
 *    demand (`import com.acme.om.*;`).
 *
 * Java's shadowing order is respected: a single-type import beats the
 * same package, which beats an on-demand import. A name imported from
 * outside the repo (`java.util.List`) therefore never falls through to a
 * same-package class that happens to share it.
 *
 * Only top-level types are indexed by simple name. A nested type is
 * reached as `Outer.Inner`, whose `Outer` already draws the edge.
 */

/** What resolution needs from one parsed file. */
export interface JavaFileTypesInput {
  /** Repo-relative POSIX path. */
  file: string;
  packageName?: string;
  /** Declared types: simple name, and the enclosing type when nested. */
  types: { name: string; enclosingType?: string }[];
  imports: { name: string; static: boolean; wildcard: boolean }[];
  referencedTypes: string[];
}

export interface JavaTypeIndex {
  /** Fully qualified name (`pkg.Outer`, `pkg.Outer.Inner`) → file. */
  byQualifiedName: Map<string, string>;
  /** Package → top-level simple name → file. */
  byPackage: Map<string, Map<string, string>>;
}

export interface JavaResolvedEdge {
  from: string;
  /** Repo-relative target, or `""` for a type outside the repo. */
  to: string;
  /** The qualified name the edge stands for. */
  specifier: string;
  external: boolean;
}

/**
 * Index every file's declared types. Files are taken in path order, so
 * when two files declare the same qualified name (a duplicated module,
 * a copied fixture) the result is stable: the first path wins.
 */
export function buildJavaTypeIndex(files: readonly JavaFileTypesInput[]): JavaTypeIndex {
  const byQualifiedName = new Map<string, string>();
  const byPackage = new Map<string, Map<string, string>>();
  const sorted = [...files].sort((a, b) => a.file.localeCompare(b.file));
  for (const f of sorted) {
    const pkg = f.packageName ?? "";
    const prefix = pkg === "" ? "" : `${pkg}.`;
    const byName = new Map(f.types.map((t) => [t.name, t]));
    for (const t of f.types) {
      const qualified = `${prefix}${qualifiedTypePath(t, byName)}`;
      if (!byQualifiedName.has(qualified)) byQualifiedName.set(qualified, f.file);
      if (t.enclosingType === undefined) {
        let names = byPackage.get(pkg);
        if (!names) {
          names = new Map();
          byPackage.set(pkg, names);
        }
        if (!names.has(t.name)) names.set(t.name, f.file);
      }
    }
  }
  return { byQualifiedName, byPackage };
}

/** Resolve one file's imports and type references into edges. */
export function resolveJavaReferences(
  index: JavaTypeIndex,
  file: JavaFileTypesInput,
): JavaResolvedEdge[] {
  const edges = new Map<string, JavaResolvedEdge>();
  const add = (to: string, specifier: string): void => {
    if (to === file.file) return;
    const key = to === "" ? `external:${specifier}` : to;
    if (!edges.has(key)) {
      edges.set(key, { from: file.file, to, specifier, external: to === "" });
    }
  };

  const singleTypeNames = new Set<string>();
  const onDemand: string[] = [];
  for (const imp of file.imports) {
    if (imp.name === "") continue;
    if (imp.wildcard) {
      // `import static a.b.C.*` names a type; `import a.b.*` a package.
      const typeFile = imp.static ? index.byQualifiedName.get(imp.name) : undefined;
      if (typeFile !== undefined) add(typeFile, imp.name);
      else onDemand.push(imp.name);
      continue;
    }
    // A static import names a member; its type is everything before it.
    const typeName = imp.static ? imp.name.slice(0, imp.name.lastIndexOf(".")) : imp.name;
    const target = resolveQualified(index, typeName);
    add(target ?? "", typeName);
    if (!imp.static) singleTypeNames.add(typeName.slice(typeName.lastIndexOf(".") + 1));
  }

  const ownPackage = index.byPackage.get(file.packageName ?? "");
  for (const name of file.referencedTypes) {
    if (singleTypeNames.has(name)) continue;
    const local = ownPackage?.get(name);
    if (local !== undefined) {
      add(local, qualify(file.packageName, name));
      continue;
    }
    for (const pkg of onDemand) {
      const target = index.byPackage.get(pkg)?.get(name);
      if (target !== undefined) {
        add(target, `${pkg}.${name}`);
        break;
      }
    }
  }

  return [...edges.values()].sort(
    (a, b) => a.to.localeCompare(b.to) || a.specifier.localeCompare(b.specifier),
  );
}

/**
 * `a.b.Outer.Inner` resolves to whichever prefix names an indexed type,
 * longest first, so an import of a nested type lands on its file.
 */
function resolveQualified(index: JavaTypeIndex, name: string): string | undefined {
  let candidate = name;
  while (candidate.includes(".")) {
    const hit = index.byQualifiedName.get(candidate);
    if (hit !== undefined) return hit;
    candidate = candidate.slice(0, candidate.lastIndexOf("."));
  }
  return index.byQualifiedName.get(candidate);
}

function qualifiedTypePath(
  t: { name: string; enclosingType?: string },
  byName: Map<string, { name: string; enclosingType?: string }>,
): string {
  const parts = [t.name];
  let outer = t.enclosingType;
  const seen = new Set<string>([t.name]);
  while (outer !== undefined && !seen.has(outer)) {
    parts.unshift(outer);
    seen.add(outer);
    outer = byName.get(outer)?.enclosingType;
  }
  return parts.join(".");
}

function qualify(pkg: string | undefined, name: string): string {
  return pkg === undefined || pkg === "" ? name : `${pkg}.${name}`;
}
