/**
 * Tests for dedup-check.ts — URL normalization, name similarity,
 * topic Jaccard, and the pair-check orchestrator.
 *
 * Run:  bun test tests/
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeUrl,
  levenshtein,
  nameSimilarity,
  topicJaccard,
  checkPair,
  type Node,
} from "../scripts/dedup-check.ts";

const mkNode = (over: Partial<Node> = {}): Node => ({
  id: "sample",
  type: "subreddit",
  name: "r/SideProject",
  url: "https://www.reddit.com/r/SideProject/",
  topics: ["side-projects", "indie-hackers", "showcase"],
  ...over,
});

describe("normalizeUrl", () => {
  test("strips protocol, www, trailing slash", () => {
    expect(normalizeUrl("https://www.reddit.com/r/SideProject/")).toBe(
      "reddit.com/r/sideproject",
    );
    expect(normalizeUrl("http://reddit.com/r/SideProject")).toBe("reddit.com/r/sideproject");
  });
  test("variants of the same URL normalize to the same string", () => {
    const a = normalizeUrl("https://www.reddit.com/r/SideProject/");
    const b = normalizeUrl("https://reddit.com/r/sideproject");
    expect(a).toBe(b);
  });
});

describe("levenshtein", () => {
  test("identical strings: 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });
  test("empty vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
  test("single edit", () => {
    expect(levenshtein("kitten", "sitten")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("nameSimilarity", () => {
  test("identical names: 1", () => {
    expect(nameSimilarity("Ramen Club", "Ramen Club")).toBe(1);
  });
  test("case and whitespace insensitive", () => {
    expect(nameSimilarity("Ramen Club", "  ramen club  ")).toBe(1);
  });
  test("fuzzy match above 0.8 for close names", () => {
    const s = nameSimilarity("r/SideProject", "r/sideprojects");
    expect(s).toBeGreaterThan(0.8);
  });
  test("different names score low", () => {
    const s = nameSimilarity("Product Hunt", "BetaList");
    expect(s).toBeLessThan(0.5);
  });
});

describe("topicJaccard", () => {
  test("identical topic sets: 1", () => {
    expect(topicJaccard(["a", "b"], ["a", "b"])).toBe(1);
  });
  test("disjoint: 0", () => {
    expect(topicJaccard(["a"], ["b"])).toBe(0);
  });
  test("case-insensitive overlap", () => {
    expect(topicJaccard(["AI", "LLM"], ["ai", "llm"])).toBe(1);
  });
  test("partial overlap", () => {
    // {a,b,c} vs {b,c,d}: intersection=2, union=4 -> 0.5
    expect(topicJaccard(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });
});

describe("checkPair", () => {
  test("exact URL match triggers hard duplicate", () => {
    const a = mkNode({ id: "a", url: "https://www.reddit.com/r/SideProject/" });
    const b = mkNode({ id: "b", url: "https://reddit.com/r/sideproject" });
    const w = checkPair(a, "a.json", b, "b.json");
    expect(w).not.toBeNull();
    expect(w!.level).toBe("hard");
    expect(w!.reason).toMatch(/URL exact match/);
  });

  test("duplicate id triggers hard duplicate", () => {
    const a = mkNode({ id: "same", url: "https://example.com/a" });
    const b = mkNode({ id: "same", url: "https://example.com/b" });
    const w = checkPair(a, "a.json", b, "b.json");
    expect(w).not.toBeNull();
    expect(w!.level).toBe("hard");
    expect(w!.reason).toMatch(/id/);
  });

  test("fuzzy name match above threshold triggers soft warn", () => {
    const a = mkNode({
      id: "new",
      name: "r/SideProjects",
      url: "https://www.reddit.com/r/SideProjects/",
      topics: ["unrelated"],
    });
    const b = mkNode({
      id: "existing",
      name: "r/SideProject",
      url: "https://www.reddit.com/r/SideProject/",
      topics: ["something-else"],
    });
    const w = checkPair(a, "a.json", b, "b.json");
    expect(w).not.toBeNull();
    expect(w!.level).toBe("soft");
    expect(w!.reason).toMatch(/name similarity/);
  });

  test("topic overlap + same type triggers soft warn", () => {
    const a = mkNode({
      id: "new",
      name: "Totally Different Name Alpha",
      url: "https://example.com/x",
      topics: ["side-projects", "indie-hackers", "showcase"],
    });
    const b = mkNode({
      id: "existing",
      name: "Completely Other Thing Zulu",
      url: "https://example.com/y",
      topics: ["side-projects", "indie-hackers", "showcase"],
    });
    const w = checkPair(a, "a.json", b, "b.json");
    expect(w).not.toBeNull();
    expect(w!.level).toBe("soft");
    expect(w!.reason).toMatch(/topic overlap/);
  });

  test("topic overlap but different type: no warning", () => {
    const a = mkNode({
      id: "new",
      name: "Totally Different Name Alpha",
      type: "discord-server",
      url: "https://example.com/x",
      topics: ["side-projects", "indie-hackers", "showcase"],
    });
    const b = mkNode({
      id: "existing",
      name: "Completely Other Thing Zulu",
      type: "subreddit",
      url: "https://example.com/y",
      topics: ["side-projects", "indie-hackers", "showcase"],
    });
    expect(checkPair(a, "a.json", b, "b.json")).toBeNull();
  });

  test("genuinely different nodes: no warning", () => {
    const a = mkNode({
      id: "producthunt",
      name: "Product Hunt",
      type: "directory",
      url: "https://www.producthunt.com",
      topics: ["launches", "startups"],
    });
    const b = mkNode({
      id: "localllama",
      name: "r/LocalLLaMA",
      type: "subreddit",
      url: "https://www.reddit.com/r/LocalLLaMA/",
      topics: ["llm", "local-ai", "open-source"],
    });
    expect(checkPair(a, "a.json", b, "b.json")).toBeNull();
  });

  test("same file compared to itself: no warning", () => {
    const a = mkNode({ id: "x", url: "https://example.com/x" });
    expect(checkPair(a, "same.json", a, "same.json")).toBeNull();
  });
});
