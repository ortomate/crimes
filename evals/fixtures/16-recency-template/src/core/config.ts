// Middle tranche. Planted: hardcoded_localhost, hardcoded_local_path.

export const API_BASE = "http://localhost:8081/api";

export const CACHE_DIR = "/Users/buildbot/.cache/recency-fixture";

export function endpoint(path: string): string {
  return `${API_BASE}${path}`;
}
