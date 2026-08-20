import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resetClaudeCodeNativeHost,
  writeClaudeCodeNativeFiles,
} from "../host-adapters/claude-code-native.js";
import type {
  MaterializedNativeAssets,
  NativeAsset,
} from "../host-adapters/native-utils.js";

void test("Claude Code wire writes a valid local marketplace/plugin tree and reset preserves unrelated entries", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-claude-plugin-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".claude-plugin",
      "marketplace.json",
    );
    await import("../files.js").then(({ writeJsonFile }) =>
      writeJsonFile(marketplacePath, {
        name: "team-tools",
        owner: { name: "Team" },
        plugins: [{ name: "existing", source: "./plugins/existing" }],
      }),
    );

    await writeClaudeCodeNativeFiles({
      workspaceRoot,
      managedRoot: join(workspaceRoot, ".claude", "agent-harness"),
      nativeAssets: [
        nativeAsset("claude.skill", "skill", "Skill body"),
        nativeAsset("claude.agent", "agent", "Agent body"),
        nativeAsset("claude.prompt", "prompt-pack", "Prompt body"),
      ],
      materializedAssets: emptyMaterializedAssets(),
      mcpServers: [],
    });

    const manifest = JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          "plugins",
          "agent-harness",
          ".claude-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(manifest.name, "agent-harness");
    assert.equal("commands" in manifest, false);
    assert.equal("agents" in manifest, false);
    assert.equal("skills" in manifest, false);

    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      name: string;
      plugins: Array<Record<string, unknown>>;
    };
    assert.equal(marketplace.name, "team-tools");
    assert.deepEqual(
      marketplace.plugins.find((plugin) => plugin.name === "agent-harness"),
      {
        name: "agent-harness",
        source: "./plugins/agent-harness",
        description: "Curated Agent Harness project assets for Claude Code.",
      },
    );
    assert.ok(marketplace.plugins.some((plugin) => plugin.name === "existing"));

    for (const relativePath of [
      ["plugins", "agent-harness", "skills", "agent-harness", "SKILL.md"],
      ["plugins", "agent-harness", "agents", "agent-harness.md"],
      ["plugins", "agent-harness", "commands", "agent-harness.md"],
    ]) {
      assert.ok(
        (await readFile(join(workspaceRoot, ...relativePath), "utf8")).length >
          0,
      );
    }

    await resetClaudeCodeNativeHost(workspaceRoot, undefined);
    await assert.rejects(
      readFile(
        join(
          workspaceRoot,
          "plugins",
          "agent-harness",
          ".claude-plugin",
          "plugin.json",
        ),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    const resetMarketplace = JSON.parse(
      await readFile(marketplacePath, "utf8"),
    ) as { plugins: Array<Record<string, unknown>> };
    assert.deepEqual(resetMarketplace.plugins, [
      { name: "existing", source: "./plugins/existing" },
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function nativeAsset(
  assetId: string,
  assetKind: "skill" | "agent" | "prompt-pack",
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
