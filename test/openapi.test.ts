import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sqliteDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { Guard } from "../src/service.js";

// Keeps openapi.yaml honest: every route the app serves must be documented, and nothing
// documented may be missing from the app.

const spec = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");

function documented(): Set<string> {
  const out = new Set<string>();
  let path = "";
  for (const line of spec.split(/\r?\n/)) {
    const p = /^  (\/[^:]*):\s*$/.exec(line);
    if (p) path = p[1]!.replace(/\{(\w+)\}/g, ":$1");
    const m = /^    (get|post|put|delete|patch):/.exec(line);
    if (m && path) out.add(`${m[1]!.toUpperCase()} ${path}`);
  }
  return out;
}

describe("openapi.yaml", () => {
  it("documents exactly the routes the app serves", () => {
    const app = createApp({ guard: new Guard(sqliteDb()), ownerKeys: ["x".repeat(24)] });
    const served = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    expect([...served].sort()).toEqual([...documented()].sort());
  });
});
