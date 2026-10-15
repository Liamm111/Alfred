import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENTITY_SCHEMAS, Packet, parseEvent, replayScenario, EVENT_TYPES, SCHEMA_VERSION } from "../src/index.js";

const FX = join(import.meta.dirname, "../fixtures");
const read = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));
const list = (d: string) => readdirSync(join(FX, d)).filter((f) => f.endsWith(".json"));

describe("public fixtures", () => {
  it("one valid fixture per entity, all accepted", () => {
    expect(list("valid").map((f) => f.replace(".json", "")).sort()).toEqual(Object.keys(ENTITY_SCHEMAS).sort());
    for (const f of list("valid")) {
      const name = f.replace(".json", "") as keyof typeof ENTITY_SCHEMAS;
      expect(ENTITY_SCHEMAS[name].safeParse(read(`valid/${f}`)).success, f).toBe(true);
    }
  });
  it("every invalid fixture is rejected", () => {
    const files = list("invalid");
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      const { entity, value } = read(`invalid/${f}`);
      expect(ENTITY_SCHEMAS[entity as keyof typeof ENTITY_SCHEMAS].safeParse(value).success, f).toBe(false);
    }
  });
  it("one event fixture per event type, all accepted; refusals carry the right code", () => {
    expect(list("events").map((f) => f.replace(".json", "")).sort()).toEqual([...EVENT_TYPES].sort());
    for (const f of list("events")) expect(parseEvent(read(`events/${f}`)).ok, f).toBe(true);
    for (const f of list("events_invalid")) {
      const { expect: code, value } = read(`events_invalid/${f}`);
      const r = parseEvent(value);
      expect(r.ok, f).toBe(false);
      if (!r.ok) expect(r.code, f).toBe(code);
    }
  });
  it("scenarios replay to their expected states", () => {
    const files = list("scenarios");
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) expect(() => replayScenario(read(`scenarios/${f}`)), f).not.toThrow();
  });
  it("contain only synthetic, non-sensitive values", () => {
    const all = ["valid", "invalid", "events", "events_invalid", "scenarios"].flatMap((d) =>
      list(d).map((f) => readFileSync(join(FX, d, f), "utf8")),
    );
    for (const txt of all) {
      expect(txt).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i); // emails
      expect(txt).not.toMatch(/(bearer|eyJ[a-zA-Z0-9_-]{10,}|sk_live|secret|password|token)/i);
      expect(txt).not.toMatch(/zoom\.us\/j\//i);
    }
  });
  it("generated artefacts are not out of date (npm run gen:check)", () => {
    expect(() =>
      execFileSync("npx", ["tsx", "scripts/gen-all.ts", "--check"], { cwd: join(FX, ".."), stdio: "pipe" }),
    ).not.toThrow();
  });
});

describe("schema guarantees", () => {
  const good = read("valid/Packet.json");
  it("no raw media can be smuggled in a packet", () => {
    for (const k of ["raw_audio", "raw_image", "payload", "audio_base64", "frame", "bytes"])
      expect(Packet.safeParse({ ...good, [k]: "AAAA" }).success, k).toBe(false);
  });
  it("JSON Schemas on disk are strict objects mirroring the Zod schemas", () => {
    for (const name of Object.keys(ENTITY_SCHEMAS)) {
      const js = read("../schemas/" + name + ".schema.json");
      expect(js.additionalProperties).toBe(false);
      expect(js.required.length).toBe(Object.keys(js.properties).length);
    }
  });
  it("schema_version is pinned", () => {
    expect(Packet.safeParse({ ...good, schema_version: "1.0.1" }).success).toBe(false);
    expect(good.schema_version).toBe(SCHEMA_VERSION);
  });
  it("zod and generated Swift agree on every enum value and field name", () => {
    const swift = readFileSync(join(FX, "../swift/AlfredContracts/Sources/AlfredContracts/Contracts.generated.swift"), "utf8");
    for (const [name, schema] of Object.entries(ENTITY_SCHEMAS)) {
      const js = z.toJSONSchema(schema, { io: "output" }) as any;
      for (const key of Object.keys(js.properties)) expect(swift, `${name}.${key}`).toContain(`= "${key}"`);
      for (const p of Object.values<any>(js.properties)) for (const e of p.enum ?? []) expect(swift).toContain(`= "${e}"`);
    }
  });
});
