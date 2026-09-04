import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexHooksManifest,
  mergeCodexPluginMarketplace,
  resetCodexNativeHost,
  writeCodexNativeFiles,
} from "../host-adapters/codex-native.js";
import { nativeWireInternals } from "../host-adapters/native-wire.js";
import type {
  MaterializedNativeAssets,
  NativeAsset,
} from "../host-adapters/native-utils.js";
import { pathExists, writeJsonFile } from "../files.js";
import { sanitizeAssetId } from "../lib/safe-paths.js";

/** Computes the deterministic Codex profile filename for an asset id. */
function codexProfileFileName(assetId: string): string {
  const slug = sanitizeAssetId(assetId).replace(/[^a-zA-Z0-9_-]+/gu, "-");
  return `agent-harness-${slug}.toml`;
}

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
    assert.equal(buildCodexHooksManifest(), null);

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
      interface: { displayName: 42 },
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

void test("Codex marketplace preserves a user-owned same-name plugin on apply and reset", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-marketplace-owner-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const userOwnedEntry = {
      name: "agent-harness",
      source: {
        source: "github",
        repo: "example-user/external-agent-harness",
        ref: "v9.9.9",
      },
      policy: { installation: "MANUAL", authentication: "NONE" },
    };
    await writeJsonFile(marketplacePath, {
      name: "team-marketplace",
      interface: { displayName: "Team Marketplace" },
      plugins: [userOwnedEntry],
    });

    await mergeCodexPluginMarketplace(marketplacePath);
    const merged = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    assert.deepEqual(merged.plugins[0], userOwnedEntry);
    assert.ok(
      merged.plugins.some(
        (plugin) =>
          plugin.name === "agent-harness" &&
          typeof plugin.source === "object" &&
          plugin.source !== null &&
          (plugin.source as Record<string, unknown>).path ===
            "./plugins/agent-harness",
      ),
    );

    await resetCodexNativeHost(workspaceRoot, undefined);
    const reset = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    assert.deepEqual(reset.plugins, [userOwnedEntry]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("current Codex marketplace repairs a non-string interface display name", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-interface-edge-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    await writeJsonFile(marketplacePath, {
      interface: { displayName: 42 },
      plugins: [],
    });

    assert.equal(await mergeCodexPluginMarketplace(marketplacePath), "current");
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      interface: { displayName: unknown };
    };
    assert.equal(marketplace.interface.displayName, "Agent Harness Local");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset rethrows unexpected agent-profile directory errors", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-reset-edge-"),
  );
  try {
    await mkdir(join(workspaceRoot, ".codex"), { recursive: true });
    await writeFile(join(workspaceRoot, ".codex", "agents"), "not-a-directory");
    await assert.rejects(resetCodexNativeHost(workspaceRoot, undefined), {
      code: "ENOTDIR",
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset preserves an unmarked plugin and tolerates a missing agents path", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-reset-missing-path-"),
  );
  try {
    const userFile = join(
      workspaceRoot,
      "plugins",
      "agent-harness",
      "user-owned.md",
    );
    await mkdir(join(workspaceRoot, "plugins", "agent-harness"), {
      recursive: true,
    });
    await writeFile(userFile, "user content\n", "utf8");
    await resetCodexNativeHost(workspaceRoot, undefined);
    assert.equal(await readFile(userFile, "utf8"), "user content\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex write refuses to claim a pre-existing unmarked plugin directory", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-claim-guard-"),
  );
  try {
    // A user-owned plugin directory that already exists WITHOUT our marker is
    // a collision, not an adoptable directory (Greptile P1).
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "user-owned.md"),
      "user content\n",
      "utf8",
    );

    await assert.rejects(
      writeCodexNativeFiles({
        workspaceRoot,
        managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
        nativeAssets: [nativeAsset("codex.agent", "agent", "Agent body")],
        materializedAssets: emptyMaterializedAssets(),
        mcpServers: [],
      }),
      /Refusing to claim existing unmarked agent-harness plugin directory/u,
    );
    // The user's directory and its content are untouched.
    assert.equal(
      await readFile(join(pluginRoot, "user-owned.md"), "utf8"),
      "user content\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex write re-adopts an already-marked plugin directory", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-readopt-"),
  );
  try {
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    // Our marker proves prior Agent Harness ownership; re-apply is safe.
    await writeJsonFile(join(pluginRoot, ".agent-harness-managed.json"), {
      managedBy: "agent-harness",
      markerVersion: 1,
      pluginName: "agent-harness",
    });

    await writeCodexNativeFiles({
      workspaceRoot,
      managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
      nativeAssets: [nativeAsset("codex.agent", "agent", "Agent body")],
      materializedAssets: emptyMaterializedAssets(),
      mcpServers: [],
    });

    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    assert.equal(manifest.name, "agent-harness");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset restores a displaced user-owned agent profile instead of deleting it", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-profile-restore-"),
  );
  try {
    // Pre-existing user-owned profile whose deterministic name collides with
    // what the adapter writes (Greptile P1).
    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    const collidingProfile = join(
      agentsDir,
      codexProfileFileName("codex.agent"),
    );
    await writeFile(collidingProfile, "user TOML content\n", "utf8");

    // Keep the plugin dir owned so write succeeds; only the profile collision
    // matters for this assertion. Ensure the plugin dir is marked (re-apply).
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    await writeJsonFile(join(pluginRoot, ".agent-harness-managed.json"), {
      managedBy: "agent-harness",
      markerVersion: 1,
      pluginName: "agent-harness",
    });

    await writeCodexNativeFiles({
      workspaceRoot,
      managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
      nativeAssets: [nativeAsset("codex.agent", "agent", "Agent body")],
      materializedAssets: emptyMaterializedAssets(),
      mcpServers: [],
    });
    // Apply displaced the user profile with harness content.
    await assert.match(
      await readFile(collidingProfile, "utf8"),
      /^name = "codex\.agent"/mu,
    );

    await resetCodexNativeHost(workspaceRoot, undefined);
    // Reset restores the pre-apply user content rather than deleting the file.
    assert.equal(
      await readFile(collidingProfile, "utf8"),
      "user TOML content\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset preserves unrelated agent-harness-prefixed profiles when no ownership record exists", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-norecord-"),
  );
  try {
    // No apply ran here, so no ownership manifest exists. A user-owned
    // `agent-harness-*.toml` in the agents dir must NOT be prefix-deleted.
    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    const userProfile = join(agentsDir, "agent-harness-user-custom.toml");
    await writeFile(userProfile, "user custom profile\n", "utf8");

    await resetCodexNativeHost(workspaceRoot, undefined);
    assert.equal(await readFile(userProfile, "utf8"), "user custom profile\n");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex re-apply preserves the original priorContent and the manifest is removed on reset", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-readd-"),
  );
  try {
    // Keep the plugin dir owned so write succeeds; the profile ownership is
    // what this test exercises.
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    await writeJsonFile(join(pluginRoot, ".agent-harness-managed.json"), {
      managedBy: "agent-harness",
      markerVersion: 1,
      pluginName: "agent-harness",
    });

    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    const collidingProfile = join(
      agentsDir,
      codexProfileFileName("codex.agent"),
    );
    // User-owned colliding profile displaced by the first apply.
    await writeFile(collidingProfile, "user ORIGINAL content\n", "utf8");

    const firstApply = () =>
      writeCodexNativeFiles({
        workspaceRoot,
        managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
        nativeAssets: [nativeAsset("codex.agent", "agent", "Agent body")],
        materializedAssets: emptyMaterializedAssets(),
        mcpServers: [],
      });

    await firstApply();
    await assert.match(
      await readFile(collidingProfile, "utf8"),
      /^name = "codex\.agent"/mu,
    );

    // Re-apply over the harness-written file must NOT re-snapshot harness
    // bytes as the new "prior" — the original user content must survive.
    await firstApply();

    await resetCodexNativeHost(workspaceRoot, undefined);
    assert.equal(
      await readFile(collidingProfile, "utf8"),
      "user ORIGINAL content\n",
    );
    // The ownership manifest itself must not dangle in the user's tree.
    assert.equal(
      await pathExists(join(agentsDir, ".agent-harness-profiles.json")),
      false,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex no-agent re-apply consumes profile ownership: restores displaced user content", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-noagent-reapply-"),
  );
  try {
    // Keep the plugin dir owned so write succeeds; the profile ownership is
    // what this test exercises.
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    await writeJsonFile(join(pluginRoot, ".agent-harness-managed.json"), {
      managedBy: "agent-harness",
      markerVersion: 1,
      pluginName: "agent-harness",
    });
    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    const collidingProfile = join(
      agentsDir,
      codexProfileFileName("codex.agent"),
    );
    // User-owned colliding profile displaced by the first (agent) apply.
    await writeFile(collidingProfile, "user ORIGINAL content\n", "utf8");

    const applyWithAgents = () =>
      writeCodexNativeFiles({
        workspaceRoot,
        managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
        nativeAssets: [nativeAsset("codex.agent", "agent", "Agent body")],
        materializedAssets: emptyMaterializedAssets(),
        mcpServers: [],
      });
    const applyWithoutAgents = () =>
      writeCodexNativeFiles({
        workspaceRoot,
        managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
        nativeAssets: [nativeAsset("codex.skill", "skill", "Skill body")],
        materializedAssets: emptyMaterializedAssets(),
        mcpServers: [],
      });

    await applyWithAgents();
    await assert.match(
      await readFile(collidingProfile, "utf8"),
      /^name = "codex\.agent"/mu,
    );

    // Re-apply WITHOUT agent assets must consume the previous ownership:
    // restore the displaced user profile, remove the generated one, and drop
    // the manifest — so nothing strands in the tree (Greptile P1 / CodeRabbit).
    await applyWithoutAgents();
    assert.equal(
      await readFile(collidingProfile, "utf8"),
      "user ORIGINAL content\n",
      "displaced user content restored by the no-agent re-apply",
    );
    assert.equal(
      await pathExists(join(agentsDir, ".agent-harness-profiles.json")),
      false,
      "ownership manifest consumed by the no-agent re-apply",
    );

    // A later reset is profile-safe and must not disturb the restored file.
    await resetCodexNativeHost(workspaceRoot, undefined);
    assert.equal(
      await readFile(collidingProfile, "utf8"),
      "user ORIGINAL content\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset drops hostile profile-manifest entries instead of traversing outside .codex/agents", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-hostile-"),
  );
  try {
    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    // A real file OUTSIDE the agents dir that a traversal would try to reach.
    const outside = join(workspaceRoot, "escape-target.toml");
    await writeFile(outside, "keep me\n", "utf8");
    // A real non-managed user profile that must NOT be touched (no prefix).
    const userProfile = join(agentsDir, "user.toml");
    await writeFile(userProfile, "user\n", "utf8");
    // A real mis-typed priorContent record must be ignored, not written over.
    const misTyped = join(agentsDir, codexProfileFileName("bad.agent"));
    await writeFile(misTyped, "harness-written\n", "utf8");
    // A harness-created profile that IS validly owned → removed on reset.
    const okProfile = join(agentsDir, codexProfileFileName("ok.agent"));
    await writeFile(okProfile, "generated\n", "utf8");

    await writeJsonFile(join(agentsDir, ".agent-harness-profiles.json"), {
      schemaVersion: 1,
      profiles: [
        { fileName: "../../escape-target.toml", priorContent: null },
        { fileName: "user.toml", priorContent: null },
        { fileName: codexProfileFileName("bad.agent"), priorContent: 42 },
        { fileName: codexProfileFileName("ok.agent"), priorContent: null },
        "not-an-object",
        { fileName: 42, priorContent: null },
      ],
    });

    await resetCodexNativeHost(workspaceRoot, undefined);

    assert.equal(
      await readFile(outside, "utf8"),
      "keep me\n",
      "path-traversal filename must not escape .codex/agents",
    );
    assert.equal(
      await readFile(userProfile, "utf8"),
      "user\n",
      "non-prefixed profile preserved",
    );
    assert.equal(
      await readFile(misTyped, "utf8"),
      "harness-written\n",
      "mis-typed priorContent record ignored (over-preservation)",
    );
    assert.equal(
      await pathExists(okProfile),
      false,
      "validly-owned harness profile removed",
    );
    assert.equal(
      await pathExists(join(agentsDir, ".agent-harness-profiles.json")),
      false,
      "ownership manifest consumed after reset",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset preserves a user-owned fresh-shaped marketplace it did not create", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-market-userowned-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const ownershipManifest = join(
      workspaceRoot,
      ".agents",
      "plugins",
      ".agent-harness-marketplace.json",
    );
    // A user-owned `agent-harness-local` marketplace that matches the managed
    // shape but that Agent Harness never created must survive reset
    // (Greptile P1: never infer whole-file ownership from a shape heuristic).
    const userOwned = {
      name: "agent-harness-local",
      interface: { displayName: "User's own local shopping list" },
      plugins: [],
    };
    await writeJsonFile(marketplacePath, userOwned);

    await resetCodexNativeHost(workspaceRoot, undefined);

    assert.deepEqual(
      JSON.parse(await readFile(marketplacePath, "utf8")),
      userOwned,
      "user-owned fresh-shaped marketplace must survive reset (Greptile P1)",
    );
    assert.equal(
      await pathExists(ownershipManifest),
      false,
      "no ownership manifest dangles in the user's tree",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset deletes only marketplace files Agent Harness actually created", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-market-created-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const ownershipManifest = join(
      workspaceRoot,
      ".agents",
      "plugins",
      ".agent-harness-marketplace.json",
    );
    // (a) Agent Harness created the file from scratch on apply → records
    //     whole-file ownership and reset deletes it entirely.
    await mergeCodexPluginMarketplace(marketplacePath);
    assert.equal(await pathExists(marketplacePath), true);
    assert.equal(await pathExists(ownershipManifest), true);

    // (b) A managed file the user edited after apply is stripped of the
    //     managed entry but never wholesale-deleted.
    await writeJsonFile(marketplacePath, {
      name: "agent-harness-local",
      interface: { displayName: "Agent Harness Local" },
      plugins: [
        {
          name: "agent-harness",
          source: { source: "local", path: "./plugins/agent-harness" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
      provenance: "user edit",
    });

    await resetCodexNativeHost(workspaceRoot, undefined);

    // (a) swallowed a fresh-shaped file; (b) survives (extra key → not the
    // pristine managed shape), with the managed entry stripped.
    const survivor = JSON.parse(await readFile(marketplacePath, "utf8")) as {
      provenance?: string;
      plugins: unknown[];
    };
    assert.equal(survivor.provenance, "user edit");
    assert.deepEqual(survivor.plugins, []);
    assert.equal(await pathExists(ownershipManifest), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex marketplace ownership survives an unchanged reapply so reset removes the harness-created file", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-market-reapply-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    const ownershipManifest = join(
      workspaceRoot,
      ".agents",
      "plugins",
      ".agent-harness-marketplace.json",
    );
    // First apply creates the marketplace from nothing → records created:true.
    await mergeCodexPluginMarketplace(marketplacePath);
    assert.equal(await pathExists(marketplacePath), true);
    assert.equal(await pathExists(ownershipManifest), true);

    // Unchanged reapply: the file now exists, so createdNow would be false —
    // but the prior created:true ownership must be PRESERVED (Greptile P1:
    // "marketplace ownership is lost on reapply").
    await mergeCodexPluginMarketplace(marketplacePath);
    const ownership = JSON.parse(await readFile(ownershipManifest, "utf8")) as {
      created: boolean;
    };
    assert.equal(ownership.created, true);

    // Reset must therefore still delete the whole harness-created file.
    await resetCodexNativeHost(workspaceRoot, undefined);
    assert.equal(
      await pathExists(marketplacePath),
      false,
      "marketplace created by harness and reapplied unchanged is deleted on reset",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reapply with a smaller agent set reconciles orphaned profiles", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-reduced-set-"),
  );
  try {
    const pluginRoot = join(workspaceRoot, "plugins", "agent-harness");
    await mkdir(pluginRoot, { recursive: true });
    await writeJsonFile(join(pluginRoot, ".agent-harness-managed.json"), {
      managedBy: "agent-harness",
      markerVersion: 1,
      pluginName: "agent-harness",
    });

    const agentsDir = join(workspaceRoot, ".codex", "agents");
    await mkdir(agentsDir, { recursive: true });
    const alphaProfile = join(agentsDir, codexProfileFileName("codex.alpha"));
    const betaProfile = join(agentsDir, codexProfileFileName("codex.beta"));
    const gammaProfile = join(agentsDir, codexProfileFileName("codex.gamma"));
    // beta displaces a user-owned profile on the first apply.
    await writeFile(betaProfile, "user BETA content\n", "utf8");
    // gamma does NOT pre-exist, so apply creates it as a pure harness-owned
    // profile (priorContent null → the removePath reconcile arm).

    const apply = (assetIds: string[]) =>
      writeCodexNativeFiles({
        workspaceRoot,
        managedRoot: join(workspaceRoot, ".codex", "agent-harness"),
        nativeAssets: assetIds.map((id) =>
          nativeAsset(id, "agent", `${id} body`),
        ),
        materializedAssets: emptyMaterializedAssets(),
        mcpServers: [],
      });

    await apply(["codex.alpha", "codex.beta", "codex.gamma"]);
    assert.equal(await pathExists(alphaProfile), true);
    assert.equal(await pathExists(betaProfile), true);
    assert.equal(await pathExists(gammaProfile), true);

    // Reapply with only alpha: beta and gamma are no longer in the incoming
    // set, so they must be reconciled — beta's displaced user content is
    // restored, gamma (harness-created) is removed — instead of stranded in
    // the tree (Greptile P1: "reduced agent sets strand profiles").
    await apply(["codex.alpha"]);
    assert.equal(
      await readFile(betaProfile, "utf8"),
      "user BETA content\n",
      "beta's displaced user content restored on reduced reapply",
    );
    assert.equal(
      await pathExists(gammaProfile),
      false,
      "gamma's harness-created profile removed on reduced reapply",
    );
    assert.equal(
      await pathExists(alphaProfile),
      true,
      "alpha profile still written",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test("Codex reset preserves a user's replacement of a harness-created marketplace", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "agent-harness-codex-market-replaced-"),
  );
  try {
    const marketplacePath = join(
      workspaceRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    );
    // Harness creates the marketplace from scratch → records created:true with
    // a fingerprint of the exact bytes it wrote.
    await mergeCodexPluginMarketplace(marketplacePath);
    assert.equal(await pathExists(marketplacePath), true);

    // User REPLACES the whole file with their own minimal marketplace that
    // happens to use the agent-harness-local name + a three-key shape.
    await writeJsonFile(marketplacePath, {
      name: "agent-harness-local",
      interface: { displayName: "My Company Marketplace" },
      plugins: [],
      sourcedBy: "user",
    });

    // Reset must NOT delete the user's replacement wholesale — the bytes no
    // longer match the harness fingerprint, so it is preserved; only the
    // managed entry is stripped (there is none) (Greptile P1: "marketplace
    // replacement is deleted by reset").
    await resetCodexNativeHost(workspaceRoot, undefined);
    const survivor = JSON.parse(
      await readFile(marketplacePath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(survivor.sourcedBy, "user");
    assert.deepEqual(survivor.interface, {
      displayName: "My Company Marketplace",
    });
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
