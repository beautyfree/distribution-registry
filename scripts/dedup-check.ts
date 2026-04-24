#!/usr/bin/env bun
/**
 * dedup-check.ts — flag likely-duplicate node submissions.
 *
 * Takes a list of changed node files (argv) and compares each against every
 * existing node in nodes/ using three signals:
 *
 *   1. URL normalization match (strip protocol, www, trailing slash,
 *      lowercase). Exact match = hard duplicate, non-zero exit.
 *   2. Name Levenshtein distance, normalized by max length. >0.8 = soft warn.
 *   3. Topic Jaccard overlap, same type. >0.7 = soft warn.
 *
 * URL-exact is the only hard block. Fuzzy warnings are advisory — a reviewer
 * decides whether r/SideProject and "SideProject subreddit" are actually the
 * same thing (they are) or just look similar (they don't, usually).
 *
 * Usage:
 *   bun run scripts/dedup-check.ts path/to/new-node.json [...more]
 *
 * Exit 0: no URL-exact match. Exit 1: at least one URL-exact match found.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODES_DIR = join(ROOT, "nodes");

const NAME_SIMILARITY_THRESHOLD = 0.8;
const TOPIC_OVERLAP_THRESHOLD = 0.7;

export type Node = {
  id: string;
  type: string;
  name: string;
  url: string;
  topics: string[];
};

export type Warning = {
  level: "hard" | "soft";
  newFile: string;
  existingFile: string;
  reason: string;
};

// -- similarity helpers -----------------------------------------------------

export function normalizeUrl(raw: string): string {
  let u = raw.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "");
  u = u.replace(/^www\./, "");
  u = u.replace(/\/+$/, "");
  return u;
}

/**
 * Classic iterative Levenshtein with a single-row buffer. ~O(n*m) time,
 * O(min(n,m)) space. Pure JS, no deps.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter string to minimize the row buffer.
  if (a.length < b.length) [a, b] = [b, a];

  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = prevDiag;
      } else {
        prev[j] = 1 + Math.min(prevDiag, prev[j - 1], prev[j]);
      }
      prevDiag = temp;
    }
  }
  return prev[b.length];
}

export function nameSimilarity(a: string, b: string): number {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(na, nb);
  return 1 - d / maxLen;
}

export function topicJaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map((t) => t.toLowerCase()));
  const sb = new Set(b.map((t) => t.toLowerCase()));
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// -- core check -------------------------------------------------------------

export function checkPair(
  newNode: Node,
  newFile: string,
  existing: Node,
  existingFile: string,
): Warning | null {
  if (newFile === existingFile) return null;
  if (newNode.id === existing.id) {
    return {
      level: "hard",
      newFile,
      existingFile,
      reason: `id "${newNode.id}" already exists`,
    };
  }
  if (normalizeUrl(newNode.url) === normalizeUrl(existing.url)) {
    return {
      level: "hard",
      newFile,
      existingFile,
      reason: `URL exact match after normalization (${normalizeUrl(newNode.url)})`,
    };
  }
  const ns = nameSimilarity(newNode.name, existing.name);
  if (ns >= NAME_SIMILARITY_THRESHOLD) {
    return {
      level: "soft",
      newFile,
      existingFile,
      reason: `name similarity ${ns.toFixed(2)} ("${newNode.name}" vs "${existing.name}")`,
    };
  }
  if (newNode.type === existing.type) {
    const tj = topicJaccard(newNode.topics, existing.topics);
    if (tj >= TOPIC_OVERLAP_THRESHOLD) {
      return {
        level: "soft",
        newFile,
        existingFile,
        reason: `same type (${newNode.type}) + topic overlap ${tj.toFixed(2)}`,
      };
    }
  }
  return null;
}

// -- filesystem glue --------------------------------------------------------

async function walkJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJson(p)));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

async function readNode(file: string): Promise<Node> {
  const raw = await readFile(file, "utf8");
  const n = JSON.parse(raw) as Node;
  return n;
}

export async function runDedupCheck(newFilesAbs: string[]): Promise<Warning[]> {
  const allFiles = await walkJson(NODES_DIR);
  const newSet = new Set(newFilesAbs.map((f) => join(ROOT, relative(ROOT, f))));
  const existingFiles = allFiles.filter((f) => !newSet.has(f));

  const existing: { file: string; node: Node }[] = [];
  for (const f of existingFiles) {
    try {
      existing.push({ file: f, node: await readNode(f) });
    } catch {
      // skip files that fail to parse — validate.ts will catch them
    }
  }

  const warnings: Warning[] = [];
  for (const newFile of newFilesAbs) {
    let newNode: Node;
    try {
      newNode = await readNode(newFile);
    } catch {
      continue;
    }
    for (const e of existing) {
      const w = checkPair(newNode, newFile, e.node, e.file);
      if (w) warnings.push(w);
    }
  }
  return warnings;
}

export function formatWarnings(warnings: Warning[]): string {
  if (warnings.length === 0) return "OK    no duplicate concerns.";
  const lines: string[] = [];
  for (const w of warnings) {
    const tag = w.level === "hard" ? "FAIL" : "WARN";
    lines.push(
      `${tag}  ${relative(ROOT, w.newFile)} looks like duplicate of ${relative(ROOT, w.existingFile)} (${w.reason})`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (argv.length === 0) {
    console.log("OK    no changed node files passed — nothing to check.");
    process.exit(0);
  }
  const files = argv.map((a) => (a.startsWith("/") ? a : join(process.cwd(), a)));
  const warnings = await runDedupCheck(files);
  console.log(formatWarnings(warnings));
  const hardHit = warnings.some((w) => w.level === "hard");
  process.exit(hardHit ? 1 : 0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Unexpected error:", e);
    process.exit(1);
  });
}
