import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildArdUrn,
  deriveArdTrustManifest,
  extractErrorMessage,
  mapEntryToArd,
  resolveArdUpdatedAt,
  writeArdCatalog,
  type ArdCatalog,
} from "../ard-catalog.js";
import { ARD_SPEC_VERSION, getArdPublisherFqdn } from "../ard/types.js";
import type { AssetCatalogEntry } from "../types.js";

void test("ARD URNs use the current urn:air namespace and public identifier grammar", () => {
  const urn = buildArdUrn(entry(), "Example.COM");
  assert.match(urn, /^urn:air:example\.com:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/u);
  assert.doesNotMatch(urn, /^urn:ai:/u);
});

void test("ARD mapping emits exactly one of url or data and keeps round-trip metadata", () => {
  const urlBacked = mapEntryToArd(entry(), "ar27111994.dev", "2.1.0");
  assert.equal(urlBacked.url, "https://example.com/skill");
  assert.equal("data" in urlBacked, false);
  assert.deepEqual(urlBacked.metadata, {
    assetKind: "skill",
    sourceId: "fixture-source",
    compatibilityMode: "native",
  });
  assert.ok((urlBacked.representativeQueries?.length ?? 0) >= 2);
  assert.ok((urlBacked.representativeQueries?.length ?? 0) <= 5);

  const inline = mapEntryToArd(
    entry({
      source: {
        ...entry().source,
        originUrl: "not-a-uri",
      },
    }),
    "ar27111994.dev",
    "2.1.0",
  );
  assert.equal("url" in inline, false);
  assert.deepEqual(inline.data, {
    assetKind: "skill",
    sourceId: "fixture-source",
    compatibilityMode: "native",
    manifestEntry: "skills/fixture/SKILL.md",
  });
});

void test("ARD trust manifests use a schema-valid HTTPS identity and do not invent attestations", () => {
  const manifest = deriveArdTrustManifest(entry());
  assert.deepEqual(manifest, {
    identity: `https://${getArdPublisherFqdn()}`,
    identityType: "https",
  });

  const untrusted = entry({
    source: {
      ...entry().source,
      authorityTier: "unverified-community",
      publisherVerified: false,
    },
    trust: { score: 10, signals: [] },
  });
  assert.equal(deriveArdTrustManifest(untrusted), undefined);
});

void test("invalid and epoch update timestamps are omitted", () => {
  assert.equal(
    resolveArdUpdatedAt(
      entry({ maintenance: { ...entry().maintenance, lastUpdated: "" } }),
    ),
    undefined,
  );
  assert.equal(
    resolveArdUpdatedAt(
      entry({
        maintenance: {
          ...entry().maintenance,
          lastUpdated: "1970-01-01T00:00:00.000Z",
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    resolveArdUpdatedAt(
      entry({
        maintenance: {
          ...entry().maintenance,
          lastUpdated: "2026-08-01T12:00:00Z",
        },
      }),
    ),
    "2026-08-01T12:00:00.000Z",
  );
});

void test("writeArdCatalog emits a canonical generated catalog that validates against the vendored public schema", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-harness-ard-v1-"));
  try {
    await import("../files.js").then(({ writeJsonLinesFile }) =>
      writeJsonLinesFile(
        join(projectRoot, "discover", "output", "catalog.selected.jsonl"),
        [
          entry(),
          entry({
            id: "fixture-inline",
            displayName: "Inline Fixture",
            source: { ...entry().source, originUrl: "local-only" },
          }),
        ],
      ),
    );
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "agent-harness", version: "2.1.0" }),
      "utf8",
    );

    const result = await writeArdCatalog(projectRoot);
    assert.equal(result.entryCount, 2);
    const catalog = JSON.parse(
      await readFile(result.filePath, "utf8"),
    ) as ArdCatalog;
    assert.equal(catalog.specVersion, ARD_SPEC_VERSION);
    assert.equal(catalog.host?.displayName, "Agent Harness");
    assert.deepEqual(Object.keys(catalog).sort(), [
      "entries",
      "host",
      "specVersion",
    ]);
    assert.ok(
      catalog.entries.every((item) => item.identifier.startsWith("urn:air:")),
    );
    assert.ok(
      catalog.entries.every(
        (item) => Number("url" in item) + Number("data" in item) === 1,
      ),
    );

    const { validateJsonSchema } =
      await import("../../scripts/validate-ard-schema.mjs");
    const schema = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "discover",
          "schema",
          "ard-ai-catalog-1.0.schema.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(validateJsonSchema(catalog, schema), []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

void test("writeArdCatalog remains valid when Prettier is unavailable", async () => {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-ard-fallback-"),
  );
  try {
    await import("../files.js").then(({ writeJsonLinesFile }) =>
      writeJsonLinesFile(
        join(projectRoot, "discover", "output", "catalog.selected.jsonl"),
        [entry()],
      ),
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) =>
      warnings.push(args.map(String).join(" "));
    try {
      const result = await writeArdCatalog(projectRoot, "2.1.0", async () => {
        throw new Error("formatter unavailable");
      });
      const catalog = JSON.parse(
        await readFile(result.filePath, "utf8"),
      ) as ArdCatalog;
      assert.equal(catalog.specVersion, "1.0");
      assert.match(warnings.join("\n"), /formatter unavailable/u);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

void test("extractErrorMessage safely handles Error, primitives, null, and undefined", () => {
  assert.equal(extractErrorMessage(new Error("boom")), "boom");
  assert.equal(extractErrorMessage("plain"), "plain");
  assert.equal(extractErrorMessage(42), "42");
  assert.equal(extractErrorMessage(null), "unknown error");
  assert.equal(extractErrorMessage(undefined), "unknown error");
});

function entry(overrides: Partial<AssetCatalogEntry> = {}): AssetCatalogEntry {
  const base: AssetCatalogEntry = {
    id: "fixture.skill",
    displayName: "Fixture Skill",
    assetKind: "skill",
    hosts: ["codex"],
    compatibilityMode: "native",
    source: {
      sourceId: "fixture-source",
      authorityTier: "trusted-community",
      sourceKind: "repo",
      sourcePriority: 80,
      originUrl: "https://example.com/skill",
      publisher: "Fixture Publisher",
      publisherVerified: true,
    },
    trust: { score: 80, signals: ["publisher-verified"] },
    capabilities: ["testing", "typescript", "quality"],
    install: {
      method: "github-tree-metadata",
      manifestEntry: "skills/fixture/SKILL.md",
    },
    evidence: {
      manifestFound: true,
      readmeFound: true,
      examplesFound: false,
      docsLinked: true,
    },
    maintenance: {
      lastUpdated: "2026-08-01T12:00:00.000Z",
      stars: 3,
      releaseCadence: "active",
    },
    risk: {
      level: "low",
      hasHooks: false,
      hasExecScripts: false,
      requiresNetwork: false,
    },
    contextCost: { sizeClass: "tiny", estimatedPromptWeight: 1 },
    fit: { portfolioFit: 0.8, hostFit: 1 },
    dedupe: { candidateRankHint: "fixture" },
    status: {
      cataloged: true,
      mirrorEligible: true,
      installEligible: true,
      activationEligible: true,
    },
  };
  return { ...base, ...overrides };
}
