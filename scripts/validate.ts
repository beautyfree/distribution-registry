#!/usr/bin/env bun
/**
 * validate.ts — schema + reachability check for all nodes/**.json.
 *
 * Exits 0 on success, 1 on any hard failure.
 * Soft-warns (stderr only) on suspicious-looking 200 responses.
 *
 * Usage:
 *   bun run validate.ts              # full validation, incl. reachability
 *   bun run validate.ts --no-fetch   # skip network checks (for fast local loops)
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODES_DIR = join(ROOT, "nodes");
const SCHEMA_PATH = join(ROOT, "schema.json");
const FETCH_TIMEOUT_MS = 10_000;

const SUSPICIOUS_BODY_PATTERNS = [
  /channel\s+deleted/i,
  /page\s+not\s+found/i,
  /this\s+group\s+has\s+been\s+(deleted|banned)/i,
  /sorry,\s+this\s+page\s+isn'?t\s+available/i,
];

type Node = {
  schema_version: number;
  id: string;
  type: string;
  name: string;
  url: string;
  [k: string]: unknown;
};

type Failure = { file: string; reason: string };

export async function walkJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkJson(p)));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

export async function loadSchema(schemaPath = SCHEMA_PATH) {
  const raw = await readFile(schemaPath, "utf8");
  return JSON.parse(raw);
}

export function makeValidator(schema: unknown) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown schema error";
  return errors
    .map((e) => {
      const path = e.instancePath || "(root)";
      return `${path} ${e.message ?? ""}`.trim();
    })
    .join("; ");
}

export async function checkReachability(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ ok: true; warning?: string } | { ok: false; reason: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // GET with redirect follow. HEAD is often 405/403 on t.me, reddit, PH, etc.,
    // so we just GET directly. We read at most ~64KB of body for suspicion check.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Some sites (reddit, cloudflare-fronted) 403 unknown UAs. Use a
        // realistic browser UA so validation mirrors what a real visitor sees.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 distribution-registry-validator",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {});
      // 403/429/503 often indicate anti-bot / rate-limit rather than a dead URL
      // (Reddit, Cloudflare-fronted sites do this to server IPs). We soft-warn
      // instead of hard-failing — the URL is live, just hostile to validators.
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        return {
          ok: true,
          warning: `HTTP ${res.status} at ${url} — likely anti-bot / rate-limit, not verified`,
        };
      }
      return { ok: false, reason: `HTTP ${res.status} at ${url}` };
    }

    // Soft warn: 200 with suspicious body (only for text-ish responses)
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 200 && (ct.includes("text") || ct.includes("html") || ct === "")) {
      const body = await res.text().catch(() => "");
      const hit = SUSPICIOUS_BODY_PATTERNS.find((r) => r.test(body));
      if (hit) {
        return { ok: true, warning: `suspicious body at ${url} (matched ${hit})` };
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { ok: true };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, reason: `timeout after ${timeoutMs}ms at ${url}` };
    }
    return { ok: false, reason: `fetch error at ${url}: ${err?.message ?? err}` };
  } finally {
    clearTimeout(t);
  }
}

export async function validateAll(opts: { fetch: boolean } = { fetch: true }): Promise<{
  failures: Failure[];
  warnings: string[];
  nodeCount: number;
}> {
  const schema = await loadSchema();
  const validate = makeValidator(schema);
  const files = await walkJson(NODES_DIR);

  const failures: Failure[] = [];
  const warnings: string[] = [];
  const seenIds = new Map<string, string>(); // id -> first file

  const parsed: { file: string; node: Node }[] = [];

  for (const file of files) {
    const rel = relative(ROOT, file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e: any) {
      failures.push({ file: rel, reason: `read error: ${e?.message ?? e}` });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e: any) {
      failures.push({ file: rel, reason: `invalid JSON: ${e?.message ?? e}` });
      continue;
    }
    if (!validate(json)) {
      failures.push({ file: rel, reason: formatAjvErrors(validate.errors) });
      continue;
    }
    const node = json as Node;

    // Slug must match filename (basename without .json)
    const slug = basename(file, ".json");
    if (node.id !== slug) {
      failures.push({ file: rel, reason: `id "${node.id}" does not match filename "${slug}"` });
      continue;
    }

    // Folder type must match node type
    const folder = basename(dirname(file));
    if (folder !== node.type) {
      failures.push({
        file: rel,
        reason: `type "${node.type}" does not match folder "${folder}"`,
      });
      continue;
    }

    // Duplicate id across all types
    if (seenIds.has(node.id)) {
      failures.push({
        file: rel,
        reason: `duplicate id "${node.id}" — first seen at ${seenIds.get(node.id)}`,
      });
      continue;
    }
    seenIds.set(node.id, rel);

    parsed.push({ file: rel, node });
  }

  if (opts.fetch) {
    // Reachability: limited concurrency
    const CONCURRENCY = 8;
    let i = 0;
    async function worker() {
      while (i < parsed.length) {
        const idx = i++;
        const { file, node } = parsed[idx];
        const r = await checkReachability(node.url);
        if (!r.ok) {
          failures.push({ file, reason: r.reason });
        } else if (r.warning) {
          warnings.push(`${file}: ${r.warning}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }

  return { failures, warnings, nodeCount: parsed.length, parsed };
}

/**
 * Generate index.json at repo root listing every valid node path.
 * Reader app fetches this to discover nodes without GitHub API quota.
 */
export async function writeIndex(parsed: { file: string; node: Node }[]): Promise<string> {
  const paths = parsed.map((p) => p.file).sort();
  const indexPath = join(ROOT, "index.json");
  const body = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      schema_version: 1,
      count: paths.length,
      nodes: paths,
    },
    null,
    2,
  ) + "\n";
  await writeFile(indexPath, body, "utf8");
  return indexPath;
}

async function main() {
  const doFetch = !process.argv.includes("--no-fetch");
  const writeManifest = !process.argv.includes("--no-index");
  const { failures, warnings, nodeCount, parsed } = await validateAll({ fetch: doFetch });

  for (const w of warnings) {
    console.error(`WARN  ${w}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL  ${failures.length} node(s) failed validation:\n`);
    for (const f of failures) {
      console.error(`  ${f.file}: ${f.reason}`);
    }
    console.error(`\nChecked ${nodeCount} node(s). ${failures.length} failed.`);
    process.exit(1);
  }

  console.log(`OK    ${nodeCount} node(s) valid${doFetch ? " (schema + reachability)" : " (schema only)"}.`);
  if (warnings.length > 0) {
    console.log(`      ${warnings.length} soft warning(s) — see above.`);
  }
  if (writeManifest && parsed.length > 0) {
    const indexPath = await writeIndex(parsed);
    console.log(`OK    wrote ${relative(ROOT, indexPath)} (${parsed.length} entries)`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Unexpected error:", e);
    process.exit(1);
  });
}
