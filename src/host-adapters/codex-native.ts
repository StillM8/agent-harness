import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  readJsonFileOrNull,
  removePath,
  writeJsonFile,
  writeTextFile,
} from "../files.js";
import { sanitizeAssetId } from "../lib/safe-paths.js";
import type {
  ManagedTextFileSnapshot,
  NativeConfigOperation,
} from "../types.js";
import {
  applyStructuredNativeConfig,
  assertJsonObject,
  buildManagedInstructionLines,
  buildNativeAssetContentSections,
  buildSkillFile,
  isJsonObject,
  removeEmptyParentDirectories,
  removeManagedSectionFile,
  restoreManagedTextFileSnapshot,
  upsertManagedSectionFile,
} from "./native-utils.js";
import type { NativeAsset, WireNativeFilesOptions } from "./native-utils.js";
import {
  removeManagedMarketplaceEntries,
  replaceManagedMarketplaceEntry,
} from "./marketplace-utils.js";

const CODEX_PLUGIN_NAME = "agent-harness";
const CODEX_PLUGIN_VERSION = "2.1.0";
const CODEX_MARKETPLACE_NAME = "agent-harness-local";
const CODEX_AGENT_FILE_PREFIX = "agent-harness-";
const CODEX_PLUGIN_SOURCE_PATH = `./plugins/${CODEX_PLUGIN_NAME}`;
const CODEX_LEGACY_PLUGIN_PATH = `./${CODEX_PLUGIN_NAME}`;
const CODEX_MANAGED_MARKETPLACE_ENTRY = {
  name: CODEX_PLUGIN_NAME,
  localSourcePath: CODEX_PLUGIN_SOURCE_PATH,
  legacyPath: CODEX_LEGACY_PLUGIN_PATH,
} as const;

type CodexMarketplaceStyle = "current" | "legacy";

/**
 * Writes Codex-native managed files using the current repo/team plugin and
 * custom-agent contracts. Hooks are intentionally not synthesized: the
 * current Codex plugin validator rejects unsupported hook fields, and raw
 * hook assets are not sufficient to construct a valid event-map safely.
 */
export async function writeCodexNativeFiles(
  options: WireNativeFilesOptions,
): Promise<NativeConfigOperation[]> {
  const managedLines = buildManagedInstructionLines({
    hostName: "OpenAI Codex",
    managedRoot: options.managedRoot,
    nativeAssets: options.nativeAssets,
    materializedAssets: options.materializedAssets,
    mcpServers: options.mcpServers,
  });

  await upsertManagedSectionFile(
    join(options.workspaceRoot, "AGENTS.md"),
    "agent-harness-codex",
    managedLines,
  );
  await writeTextFile(
    join(
      options.workspaceRoot,
      ".agents",
      "skills",
      CODEX_PLUGIN_NAME,
      "SKILL.md",
    ),
    buildSkillFile(
      CODEX_PLUGIN_NAME,
      "Use curated Agent Harness assets for this Codex project.",
      [
        ...managedLines,
        ...buildNativeAssetContentSections(options.nativeAssets, [
          "skill",
          "instruction",
          "reference-pack",
        ]),
      ],
    ),
  );

  const pluginRoot = join(options.workspaceRoot, "plugins", CODEX_PLUGIN_NAME);
  await writeJsonFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    buildCodexPluginManifest(options.nativeAssets),
  );
  await writeTextFile(
    join(pluginRoot, "skills", CODEX_PLUGIN_NAME, "SKILL.md"),
    buildSkillFile(
      CODEX_PLUGIN_NAME,
      "Use curated Agent Harness assets for this Codex project.",
      [
        ...managedLines,
        ...buildNativeAssetContentSections(options.nativeAssets, [
          "skill",
          "instruction",
          "reference-pack",
          "prompt-pack",
          "workflow",
        ]),
      ],
    ),
  );

  await writeCodexAgentProfiles(options.workspaceRoot, options.nativeAssets);
  const marketplaceStyle = await mergeCodexPluginMarketplace(
    join(options.workspaceRoot, ".agents", "plugins", "marketplace.json"),
  );

  if (marketplaceStyle === "legacy") {
    await writeLegacyCodexCompatibilityPlugin(options);
  }

  return applyStructuredNativeConfig(options.workspaceRoot, "codex", {
    nativeAssets: options.nativeAssets,
  });
}

/** Builds the current Codex plugin manifest. */
export function buildCodexPluginManifest(
  nativeAssets: NativeAsset[],
): Record<string, unknown> {
  void nativeAssets;
  return {
    name: CODEX_PLUGIN_NAME,
    version: CODEX_PLUGIN_VERSION,
    description: "Project-local Agent Harness assets for OpenAI Codex.",
    author: { name: "Agent Harness" },
    skills: "./skills/",
    interface: {
      displayName: "Agent Harness",
      shortDescription: "Curated project context and skills for Codex.",
      longDescription:
        "Project-local Agent Harness context, curated skills, and custom agents for OpenAI Codex.",
      developerName: "Agent Harness",
      category: "Productivity",
      capabilities: ["Project context", "Skills", "Custom agents"],
    },
  };
}

/**
 * Current Codex plugins do not synthesize hook manifests. The legacy multi-
 * argument shape is retained only for compatibility callers and tests.
 */
export function buildCodexHooksManifest(
  nativeAssets: NativeAsset[],
  legacyHookFilesOrManagedRoot?: readonly string[] | string,
  legacyContentPathByAssetIdOrHooksManifestPath?:
    Readonly<Record<string, string>> | string,
  hooksManifestPath?: string,
): Record<string, unknown> | null {
  if (!Array.isArray(legacyHookFilesOrManagedRoot)) {
    return null;
  }

  const contentPathByAssetId: Readonly<Record<string, string>> =
    legacyContentPathByAssetIdOrHooksManifestPath !== null &&
    typeof legacyContentPathByAssetIdOrHooksManifestPath === "object"
      ? legacyContentPathByAssetIdOrHooksManifestPath
      : {};
  const manifestDirectory = hooksManifestPath
    ? dirname(hooksManifestPath)
    : undefined;

  return {
    schemaVersion: 1,
    hooks: nativeAssets
      .filter((nativeAsset) => nativeAsset.assetKind === "hook")
      .map((nativeAsset) => {
        const matchedFile = contentPathByAssetId[nativeAsset.assetId];
        const source = matchedFile
          ? manifestDirectory
            ? relative(manifestDirectory, matchedFile).replaceAll("\\", "/")
            : matchedFile
          : nativeAsset.assetId;
        return {
          name: nativeAsset.assetId,
          description: nativeAsset.displayName,
          source,
        };
      }),
  };
}

async function writeCodexAgentProfiles(
  workspaceRoot: string,
  nativeAssets: NativeAsset[],
): Promise<void> {
  const agents = nativeAssets.filter((asset) => asset.assetKind === "agent");
  for (const asset of agents) {
    const slug = sanitizeAssetId(asset.assetId).replace(
      /[^a-zA-Z0-9_-]+/gu,
      "-",
    );
    const fileName = `${CODEX_AGENT_FILE_PREFIX}${slug}.toml`;
    await writeTextFile(
      join(workspaceRoot, ".codex", "agents", fileName),
      [
        `name = ${JSON.stringify(asset.displayName)}`,
        `description = ${JSON.stringify(`Agent Harness asset ${asset.assetId}`)}`,
        `developer_instructions = ${JSON.stringify(asset.content)}`,
        "",
      ].join("\n"),
    );
  }
}

/** Merges the managed plugin into the repo/team Codex marketplace. */
export async function mergeCodexPluginMarketplace(
  filePath: string,
): Promise<CodexMarketplaceStyle> {
  const existing = await readJsonFileOrNull<unknown>(filePath);
  const marketplace =
    existing === null ? {} : assertJsonObject(existing, filePath);
  const rawPlugins: unknown[] = Array.isArray(marketplace.plugins)
    ? marketplace.plugins
    : [];
  const legacy =
    typeof marketplace.schemaVersion === "number" ||
    rawPlugins.some(
      (entry) => isJsonObject(entry) && typeof entry.path === "string",
    );

  if (legacy) {
    await writeJsonFile(filePath, {
      ...marketplace,
      plugins: replaceManagedMarketplaceEntry(
        rawPlugins,
        CODEX_MANAGED_MARKETPLACE_ENTRY,
        { name: CODEX_PLUGIN_NAME, path: CODEX_LEGACY_PLUGIN_PATH },
      ),
    });
    return "legacy";
  }

  await writeJsonFile(filePath, {
    ...marketplace,
    name:
      typeof marketplace.name === "string"
        ? marketplace.name
        : CODEX_MARKETPLACE_NAME,
    interface: isJsonObject(marketplace.interface)
      ? {
          ...marketplace.interface,
          displayName:
            typeof marketplace.interface.displayName === "string"
              ? marketplace.interface.displayName
              : "Agent Harness Local",
        }
      : { displayName: "Agent Harness Local" },
    plugins: replaceManagedMarketplaceEntry(
      rawPlugins,
      CODEX_MANAGED_MARKETPLACE_ENTRY,
      {
        name: CODEX_PLUGIN_NAME,
        source: {
          source: "local",
          path: CODEX_PLUGIN_SOURCE_PATH,
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ),
  });
  return "current";
}

async function writeLegacyCodexCompatibilityPlugin(
  options: WireNativeFilesOptions,
): Promise<void> {
  const legacyPluginRoot = join(
    options.workspaceRoot,
    ".agents",
    "plugins",
    CODEX_PLUGIN_NAME,
  );
  const hookAssets = options.nativeAssets.filter(
    (asset) => asset.assetKind === "hook",
  );
  await writeJsonFile(join(legacyPluginRoot, ".codex-plugin", "plugin.json"), {
    name: CODEX_PLUGIN_NAME,
    version: "1.0.0",
    description: "Project-local Agent Harness assets for OpenAI Codex.",
    skills: "./skills",
    ...(hookAssets.length > 0 ? { hooks: "./hooks/hooks.json" } : {}),
  });
  if (hookAssets.length > 0) {
    const hooksManifestPath = join(legacyPluginRoot, "hooks", "hooks.json");
    await writeJsonFile(hooksManifestPath, {
      schemaVersion: 1,
      hooks: hookAssets.map((asset) => {
        const sourcePath = join(
          options.managedRoot,
          "assets",
          "hooks",
          sanitizeAssetId(asset.assetId),
          "hook.md",
        );
        return {
          name: asset.assetId,
          description: asset.displayName,
          source: relative(dirname(hooksManifestPath), sourcePath).replaceAll(
            "\\",
            "/",
          ),
        };
      }),
    });
  }
}

/** Removes all Codex-native files installed by agent-harness. */
export async function resetCodexNativeHost(
  workspaceRoot: string,
  textFileSnapshots: ManagedTextFileSnapshot[] | undefined,
): Promise<void> {
  await restoreManagedTextFileSnapshot(
    join(workspaceRoot, "AGENTS.md"),
    textFileSnapshots,
    () =>
      removeManagedSectionFile(
        join(workspaceRoot, "AGENTS.md"),
        "agent-harness-codex",
      ),
  );
  await removePath(join(workspaceRoot, ".agents", "skills", CODEX_PLUGIN_NAME));
  await removePath(join(workspaceRoot, "plugins", CODEX_PLUGIN_NAME));
  await removePath(
    join(workspaceRoot, ".agents", "plugins", CODEX_PLUGIN_NAME),
  );
  await removeCodexAgentProfiles(workspaceRoot);
  await removeCodexMarketplaceEntry(
    join(workspaceRoot, ".agents", "plugins", "marketplace.json"),
  );
  await removeEmptyParentDirectories(
    join(workspaceRoot, ".agents", "skills"),
    workspaceRoot,
  );
  await removeEmptyParentDirectories(
    join(workspaceRoot, ".agents", "plugins"),
    workspaceRoot,
  );
  await removeEmptyParentDirectories(
    join(workspaceRoot, ".agents"),
    workspaceRoot,
  );
  await removeEmptyParentDirectories(
    join(workspaceRoot, ".codex", "agents"),
    workspaceRoot,
  );
  await removeEmptyParentDirectories(
    join(workspaceRoot, "plugins"),
    workspaceRoot,
  );
}

async function removeCodexAgentProfiles(workspaceRoot: string): Promise<void> {
  const agentsDir = join(workspaceRoot, ".codex", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (error) {
    if (
      isJsonObject(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith(CODEX_AGENT_FILE_PREFIX) && entry.endsWith(".toml"),
      )
      .map((entry) => removePath(join(agentsDir, entry))),
  );
}

async function removeCodexMarketplaceEntry(filePath: string): Promise<void> {
  const existing = await readJsonFileOrNull<unknown>(filePath);
  if (existing === null) return;
  const marketplace = assertJsonObject(existing, filePath);
  const rawPlugins: unknown[] = Array.isArray(marketplace.plugins)
    ? marketplace.plugins
    : [];
  const plugins = removeManagedMarketplaceEntries(
    rawPlugins,
    CODEX_MANAGED_MARKETPLACE_ENTRY,
  );

  const isManagedFreshMarketplace =
    marketplace.name === CODEX_MARKETPLACE_NAME &&
    plugins.length === 0 &&
    Object.keys(marketplace).every((key) =>
      ["name", "interface", "plugins"].includes(key),
    );
  if (isManagedFreshMarketplace) {
    await removePath(filePath);
    return;
  }

  await writeJsonFile(filePath, { ...marketplace, plugins });
}
