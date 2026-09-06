import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseFile, type ParsedFile } from "@crimes/language-js";
import { parsePyFile, type ParsedPyFile } from "@crimes/language-py";
import { profileAsync, profileSync } from "./profile.js";

interface Entry {
  source: string;
  js?: ParsedFile;
  py?: ParsedPyFile;
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

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

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
    while (this.bytes + entry.bytes > this.maxBytes || this.entries.size >= 4096) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(path, entry);
    this.bytes += entry.bytes;
  }
}
