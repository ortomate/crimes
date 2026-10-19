import type { ImportGraph } from "./types.js";

/**
 * Strongly connected components of the import graph, as a map from file
 * to component id. Files on no cycle get a component of their own.
 *
 * Iterative Tarjan: Java, Kotlin and Swift graphs reach thousands of
 * files in one component, deeper than a recursive walk can go.
 */
export function componentIds(graph: ImportGraph): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;

  const successors = (file: string): string[] =>
    (graph.out.get(file) ?? []).map((e) => e.to).filter((to): to is string => !!to);

  for (const root of graph.files) {
    if (index.has(root)) continue;
    const work: { file: string; next: string[]; at: number }[] = [];
    const open = (file: string): void => {
      index.set(file, counter);
      low.set(file, counter);
      counter += 1;
      stack.push(file);
      onStack.add(file);
      work.push({ file, next: successors(file), at: 0 });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.at < frame.next.length) {
        const to = frame.next[frame.at]!;
        frame.at += 1;
        if (!index.has(to)) open(to);
        else if (onStack.has(to)) {
          low.set(frame.file, Math.min(low.get(frame.file)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent)
        low.set(parent.file, Math.min(low.get(parent.file)!, low.get(frame.file)!));
      if (low.get(frame.file) === index.get(frame.file)) {
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.set(member, components);
        } while (member !== frame.file);
        components += 1;
      }
    }
  }
  return component;
}
