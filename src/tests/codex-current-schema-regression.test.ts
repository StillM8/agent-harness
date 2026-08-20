import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexHooksManifest,
  resetCodexNativeHost,
  writeCodexNativeFiles,
} from "../host-adapters/codex-native.js";
import { nativeWireInternals } from "../host-adapters/native-wire.js";
import type {
  MaterializedNativeAssets,
  NativeAsset,
} from "../host-adapters/native-utils.js";
import { writeJsonFile } from "../files.js";

void test("native preview specs advertise the current Claude and Codex managed paths", () => {
  const codexPaths =
    nativeWireInternals.nativeHostSpecs.codex.targetPathSegments.map(
      (segments) => segments.join("/"),
    );
  assert.ok(
    codexPaths.includes("plugins/agent-harness/.codex-plugin/plugin.json"),
  );
  assert.ok(codexPaths.includes(".agents/plugins/marketplace.json"));
  assert.ok(!codexPaths.includes(".codex/hooks.json"));

  const claudePaths = nativeWireInternals.nativeHostSpecs[
    "claude-code"
  ].targetPathSegments.map((segments) => segments.join("/"));
  assert.ok(
    claudePaths.includes("plugins/agent-harness/.claude-plugin/plugin.json"),
  );
  assert.ok(claudePaths.includes(".claude-plugin/marketplace.json"));
});

void test("Codex wire emits current marketplace, plugin manifest, and project custom-agent TOML", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-current-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    await writeJsonFile(marketplacePath, {
      name: "team-marketplace",
      interface: { displayName: "Team Marketplace" },
      plugins: [
        {
          name: "existing",
          source: { source: "local", path: "./plugins/existing" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    const nativeAssets: NativeAsset[] = [
      nativeAsset("codex.skill", "skill", "Skill body"),
      nativeAsset("codex.agent", "agent", "Agent body\nwith multiple lines"),
      nativeAsset("codex.hook", "hook", "not a structured Codex hook"),
    ];
    await writeCodexNativeFiles({
      workspaceRoot,
      managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
      nativeAssets,
      materializedAssets: emptyMaterializedAssets(),
      mcpServers: [],
    });

    const marketplace = JSON.parse(
      await readFile(marketplacePath, "utf8"),
    ) as Record<string, unknown> & {
      plugins: Array<Record<string, unknown>>;
    };
    assert.equal("schemaVersion" in marketplace, false);
    assert.deepEqual(marketplace.interface, {
      displayName: "Team Marketplace",
    });
    const managedEntry = marketplace.plugins.find(
      (plugin) => plugin.name === "agent-harness",
    );
    assert.deepEqual(managedEntry, {
      name: "agent-harness",
      source: { source: "local", path: "./plugins/agent-harness" },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    });
    assert.ok(marketplace.plugins.some((plugin) => plugin.name === "existing"));

    const manifest = JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          "plugins",
          "agent-harness",
          ".codex-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(manifest.name, "agent-harness");
    assert.equal(manifest.version, "2.1.0");
    assert.equal(manifest.skills, "./skills/");
    assert.equal("hooks" in manifest, false);
    assert.deepEqual(
      (manifest.interface as Record<string, unknown>).displayName,
      "Agent Harness",
    );
    assert.equal(buildCodexHooksManifest(nativeAssets), null);

    const agentFiles = await readdir(join(workspaceRoot, ".codex", "agents"));
    const managedAgents = agentFiles.filter(
      (file) => file.startsWith("agent-harness-") && file.endsWith(".toml"),
    );
    assert.equal(managedAgents.length, 1);
    const agentToml = await readFile(
      join(workspaceRoot, ".codex", "agents", managedAgents[0]),
      "utf8",
    );
    assert.match(agentToml, /^name = "codex\.agent"/mu);
    assert.match(
      agentToml,
      /developer_instructions = "Agent body\\nwith multiple lines"/u,
    );

    await assert.rejects(
      readFile(join(workspaceRoot, ".codex", "hooks.json"), "utf8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(
        join(
          workspaceRoot,
          ".agents",
          "plugins",
          "agent-harness",
          ".codex-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
      { code: "ENOENT" },
    );

    await resetCodexNativeHost(workspaceRoot, undefined);
    await assert.rejects(
      readFile(
        join(
          workspaceRoot,
          "plugins",
          "agent-harness",
          ".codex-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    const remainingAgentFiles = await readdir(
      join(workspaceRoot, ".codex", "agents"),
    ).catch(() => []);
    assert.equal(
      remainingAgentFiles.some((file) => file.startsWith("agent-harness-")),
      false,
    );

    const resetMarketplace = JSON.parse(
      await readFile(marketplacePath, "utf8"),
    ) as { plugins: Array<{ name: string }> };
    assert.deepEqual(
      resetMarketplace.plugins.map((plugin) => plugin.name),
      ["existing"],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("legacy Codex marketplaces are preserved non-destructively", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-legacy-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    await writeJsonFile(marketplacePath, {
      schemaVersion: 2,
      plugins: [{ name: "existing", path: "./existing" }],
    });

    await writeCodexNativeFiles({
      workspaceRoot,
      managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
      nativeAssets: [nativeAsset("codex.skill", "skill", "Skill")],
      materializedAssets: emptyMaterializedAssets(),
      mcpServers: [],
    });

    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      schemaVersion: number;
      plugins: Array<Record<string, unknown>>;
    };
    assert.equal(marketplace.schemaVersion, 2);
    assert.deepEqual(
      marketplace.plugins.find((plugin) => plugin.name === "agent-harness"),
      { name: "agent-harness", path: "./agent-harness" },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function nativeAsset(
  assetId: string,
  assetKind: NativeAsset["assetKind"],
  content: string,
): NativeAsset {
  return {
    assetId,
    assetKind,
    displayName: assetId,
    compatibilityMode: "native",
    content,
  };
}

function emptyMaterializedAssets(): MaterializedNativeAssets {
  return {
    instructionFiles: [],
    agentFiles: [],
    skillDirs: [],
    pluginDirs: [],
    hookFiles: [],
    hookContentPathByAssetId: {},
    workflowFiles: [],
    referenceFiles: [],
    extensionIds: [],
    mcpServers: [],
  };
}
