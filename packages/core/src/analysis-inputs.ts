import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseFile, type ParsedFile } from "@crimes/language-js";
import { parseJavaFile, type ParsedJavaFile } from "@crimes/language-java";
import { parseKotlinFile, type ParsedKotlinFile } from "@crimes/language-kotlin";
import { parsePyFile, type ParsedPyFile } from "@crimes/language-py";
import { parseSwiftFile, type ParsedSwiftFile } from "@crimes/language-swift";
import { profileAsync, profileSync } from "./profile.js";

interface Entry {
  source: string;
  js?: ParsedFile;
  py?: ParsedPyFile;
  java?: ParsedJavaFile;
  kotlin?: ParsedKotlinFile;
  swift?: ParsedSwiftFile;
  bytes: number;
}

/**
 * Read/parse reuse for ONE repository analysis. Nothing survives a scan,
 * touches disk, or crosses repositories. Parsed values contain extracted
 * data, not compiler ASTs. Consumers treat them as immutable.
 *
 * The budget counts UTF-16 source plus serialized parsed data; object
 * overhead is measured separately by the benchmark's process peak RSS.
 * Eviction changes cost only. Zero budget is the uncached parity oracle.
 */
export class AnalysisInputs {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<string>>();
  private bytes = 0;

  constructor(private readonly maxBytes = 128 * 1024 * 1024) {}

  readSync(path: string): string {
    const cached = this.get(path);
    if (cached) return cached.source;
    const source = profileSync("input.read", () => readFileSync(path, "utf8"));
    this.put(path, { source, bytes: source.length * 2 });
    return source;
  }

  async read(path: string): Promise<string> {
    const cached = this.get(path);
    if (cached) return cached.source;
    const pending = this.pending.get(path);
    if (pending) return pending;
    const reading = profileAsync("input.read", () => readFile(path, "utf8"));
    this.pending.set(path, reading);
    try {
      const source = await reading;
      this.put(path, { source, bytes: source.length * 2 });
      return source;
    } finally {
      this.pending.delete(path);
    }
  }

  js(path: string, source: string): ParsedFile {
    const cached = this.get(path);
    if (cached?.source === source && cached.js) return cached.js;
    const parsed = profileSync("input.parse-js", () =>
      parseFile({ absolutePath: path, source }),
    );
    this.put(path, {
      source,
      js: parsed,
      bytes: 2 * (source.length + JSON.stringify(parsed).length),
    });
    return parsed;
  }

  async py(path: string, source: string): Promise<ParsedPyFile> {
    const cached = this.get(path);
    if (cached?.source === source && cached.py) return cached.py;
    const parsed = await profileAsync("input.parse-py", () =>
      parsePyFile({ absolutePath: path, source }),
    );
    this.put(path, {
      source,
      py: parsed,
      bytes: 2 * (source.length + JSON.stringify(parsed).length),
    });
    return parsed;
  }

  async java(path: string, source: string): Promise<ParsedJavaFile> {
    const cached = this.get(path);
    if (cached?.source === source && cached.java) return cached.java;
    const parsed = await profileAsync("input.parse-java", () =>
      parseJavaFile({ absolutePath: path, source }),
    );
    this.put(path, {
      source,
      java: parsed,
      bytes: 2 * (source.length + JSON.stringify(parsed).length),
    });
    return parsed;
  }

  async kotlin(path: string, source: string): Promise<ParsedKotlinFile> {
    const cached = this.get(path);
    if (cached?.source === source && cached.kotlin) return cached.kotlin;
    const parsed = await profileAsync("input.parse-kotlin", () =>
      parseKotlinFile({ absolutePath: path, source }),
    );
    this.put(path, {
      source,
      kotlin: parsed,
      bytes: 2 * (source.length + JSON.stringify(parsed).length),
    });
    return parsed;
  }

  async swift(path: string, source: string): Promise<ParsedSwiftFile> {
    const cached = this.get(path);
    if (cached?.source === source && cached.swift) return cached.swift;
    const parsed = await profileAsync("input.parse-swift", () =>
      parseSwiftFile({ absolutePath: path, source }),
    );
    this.put(path, {
      source,
      swift: parsed,
      bytes: 2 * (source.length + JSON.stringify(parsed).length),
    });
    return parsed;
  }

  private get(path: string): Entry | undefined {
    const entry = this.entries.get(path);
    if (entry) {
      this.entries.delete(path);
      this.entries.set(path, entry);
    }
    return entry;
  }

  private put(path: string, entry: Entry): void {
    const previous = this.entries.get(path);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(path);
    if (entry.bytes > this.maxBytes) return;
    while (this.bytes + entry.bytes > this.maxBytes || this.entries.size >= 16384) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(path, entry);
    this.bytes += entry.bytes;
  }
}
