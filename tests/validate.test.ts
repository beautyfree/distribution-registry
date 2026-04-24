/**
 * Tests for schema validation and URL reachability.
 *
 * Run:  bun test tests/
 *
 * We exercise the pure helpers from scripts/validate.ts against in-memory
 * JSON fixtures (for schema) and a local Bun HTTP server (for reachability).
 * This keeps tests deterministic and offline.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  loadSchema,
  makeValidator,
  formatAjvErrors,
  checkReachability,
} from "../scripts/validate.ts";

let validate: ReturnType<typeof makeValidator>;

beforeAll(async () => {
  const schema = await loadSchema();
  validate = makeValidator(schema);
});

const validNode = () => ({
  schema_version: 1,
  id: "test-node",
  type: "telegram-chat",
  name: "Test Node",
  url: "https://t.me/testnode",
  audience_size: 100,
  topics: ["indie-hackers"],
  post_rules: "No spam.",
  post_format: "casual",
  language: "en",
  last_verified_at: "2026-04-24",
  contributor: "devall",
});

describe("schema validation", () => {
  test("valid node passes", () => {
    const ok = validate(validNode());
    expect(ok).toBe(true);
  });

  test("missing required field rejects with clear message", () => {
    const n = validNode() as any;
    delete n.name;
    const ok = validate(n);
    expect(ok).toBe(false);
    const msg = formatAjvErrors(validate.errors);
    expect(msg).toMatch(/name/);
    expect(msg).toMatch(/required/i);
  });

  test("unknown type rejects", () => {
    const n = validNode();
    (n as any).type = "myspace-group";
    const ok = validate(n);
    expect(ok).toBe(false);
    const msg = formatAjvErrors(validate.errors);
    expect(msg).toMatch(/type|enum/i);
  });

  test("invalid URL format rejects", () => {
    const n = validNode();
    n.url = "not a url";
    const ok = validate(n);
    expect(ok).toBe(false);
    const msg = formatAjvErrors(validate.errors);
    expect(msg).toMatch(/uri|format/i);
  });

  test("schema_version mismatch (e.g. 2) rejects", () => {
    const n = validNode();
    (n as any).schema_version = 2;
    const ok = validate(n);
    expect(ok).toBe(false);
    const msg = formatAjvErrors(validate.errors);
    expect(msg).toMatch(/schema_version|const|1/);
  });

  test("unknown field rejects (additionalProperties: false)", () => {
    const n = validNode() as any;
    n.secret_power = "invisibility";
    const ok = validate(n);
    expect(ok).toBe(false);
  });

  test("empty topics array rejects", () => {
    const n = validNode();
    n.topics = [];
    const ok = validate(n);
    expect(ok).toBe(false);
  });

  test("post_rules over 500 chars rejects", () => {
    const n = validNode();
    n.post_rules = "x".repeat(501);
    const ok = validate(n);
    expect(ok).toBe(false);
  });

  test("audience_size negative rejects", () => {
    const n = validNode();
    n.audience_size = -1;
    const ok = validate(n);
    expect(ok).toBe(false);
  });

  test("language must be 2-letter ISO code", () => {
    const n = validNode();
    n.language = "eng";
    expect(validate(n)).toBe(false);
  });

  test("contributor handle without @ passes", () => {
    const n = validNode();
    n.contributor = "devall";
    expect(validate(n)).toBe(true);
  });
});

describe("duplicate slug detection", () => {
  // Simulated at the registry walk level — we duplicate the logic here.
  test("duplicate slug across types is caught", () => {
    const seen = new Map<string, string>();
    const nodes = [
      { id: "shared-slug", file: "nodes/telegram-chat/shared-slug.json" },
      { id: "shared-slug", file: "nodes/subreddit/shared-slug.json" },
    ];
    const failures: string[] = [];
    for (const n of nodes) {
      if (seen.has(n.id)) {
        failures.push(`${n.file}: duplicate id "${n.id}" (first seen ${seen.get(n.id)})`);
      } else {
        seen.set(n.id, n.file);
      }
    }
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/duplicate/);
    expect(failures[0]).toMatch(/shared-slug/);
  });
});

describe("URL reachability", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/ok") return new Response("hello", { status: 200 });
        if (url.pathname === "/404") return new Response("not found", { status: 404 });
        if (url.pathname === "/500") return new Response("boom", { status: 500 });
        if (url.pathname === "/403") return new Response("forbidden", { status: 403 });
        if (url.pathname === "/429") return new Response("too many", { status: 429 });
        if (url.pathname === "/deleted") {
          return new Response("<html>This channel deleted by owner</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url.pathname === "/slow") {
          await new Promise((r) => setTimeout(r, 5000));
          return new Response("late", { status: 200 });
        }
        if (url.pathname === "/redirect") {
          return new Response(null, { status: 302, headers: { Location: "/ok" } });
        }
        return new Response("default", { status: 200 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("200 OK passes", async () => {
    const r = await checkReachability(`${baseUrl}/ok`);
    expect(r.ok).toBe(true);
  });

  test("follows redirects", async () => {
    const r = await checkReachability(`${baseUrl}/redirect`);
    expect(r.ok).toBe(true);
  });

  test("404 fails with URL in error message", async () => {
    const r = await checkReachability(`${baseUrl}/404`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/404/);
      expect(r.reason).toContain(`${baseUrl}/404`);
    }
  });

  test("403 soft-warns (anti-bot tolerated)", async () => {
    const r = await checkReachability(`${baseUrl}/403`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/403/);
  });

  test("429 soft-warns (rate-limit tolerated)", async () => {
    const r = await checkReachability(`${baseUrl}/429`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/429/);
  });

  test("500 fails", async () => {
    const r = await checkReachability(`${baseUrl}/500`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/500/);
  });

  test("timeout fails", async () => {
    const r = await checkReachability(`${baseUrl}/slow`, 200);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timeout/i);
  }, 3000);

  test("200 with suspicious body triggers soft warning", async () => {
    const r = await checkReachability(`${baseUrl}/deleted`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/suspicious/i);
  });
});
