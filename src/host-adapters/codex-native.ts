import { dirname, join, relative } from "node:path";

import {
  readJsonFileOrNull,
  readTextFileOrNull,
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
import {
  claimManagedPluginDirectory,
  hasManagedPluginMarker,
} from "./ownership-marker.js";

const CODEX_PLUGIN_NAME = "agent-harness";
const CODEX_PLUGIN_VERSION = "2.1.0";
const CODEX_MARKETPLACE_NAME = "agent-harness-local";
const CODEX_AGENT_FILE_PREFIX = "agent-harness-";
/**
 * The only filename shape `readCodexAgentProfileRecords` accepts for an owned
 * profile. Rejecting separators and requiring a non-empty `[a-zA-Z0-9_-]`
 * slug guarantees `removeCodexAgentProfiles` can never join a path that
 * escapes `.codex/agents` (review / CodeRabbit CWE-22: arbitrary filenames
 * from an ownership manifest must not become a path traversal).
 */
const CODEX_AGENT_PROFILE_NAME_PATTERN =
  /^agent-harness-[a-zA-Z0-9_-]+\.toml$/u;
const CODEX_PLUGIN_SOURCE_PATH = `./plugins/${CODEX_PLUGIN_NAME}`;
const CODEX_LEGACY_PLUGIN_PATH = `./${CODEX_PLUGIN_NAME}`;
const CODEX_MANAGED_MARKETPLACE_ENTRY = {
  name: CODEX_PLUGIN_NAME,
  localSourcePath: CODEX_PLUGIN_SOURCE_PATH,
  legacyPath: CODEX_LEGACY_PLUGIN_PATH,
} as const;

type CodexMarketplaceStyle = "current" | "legacy";

/**
 * Claims a Codex plugin directory for this apply via the shared ownership
 * helper: refuses a pre-existing unmarked dir (user-owned collision), allows
 * a dir we created this apply or already marked (re-apply safe).
 */
async function claimCodexPluginDirectory(pluginRoot: string): Promise<void> {
  await claimManagedPluginDirectory(pluginRoot, CODEX_PLUGIN_NAME);
}

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
  await claimCodexPluginDirectory(pluginRoot);
  await writeJsonFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    buildCodexPluginManifest(),
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
export function buildCodexPluginManifest(): Record<string, unknown> {
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

/** Current Codex plugins do not synthesize hook manifests. */
export function buildCodexHooksManifest(): null {
  return null;
}

/** Builds the legacy hook manifest used by legacy Codex plugin layouts. */
export function buildLegacyCodexHooksManifest(
  nativeAssets: readonly NativeAsset[],
  contentPathByAssetId: Readonly<Record<string, string>>,
  hooksManifestPath?: string,
): Record<string, unknown> {
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

/** A single Codex custom-agent profile file Agent Harness owns. */
interface CodexAgentProfileRecord {
  fileName: string;
  /** Original pre-apply content; null when the file did not exist before. */
  priorContent: string | null;
}

/**
 * Records which `agent-harness-*.toml` custom-agent profiles THIS apply owns,
 * plus their pre-apply content. Reset strips exactly these and restores any
 * displaced user-owned profile instead of prefix-deleting every match (review
 * / Greptile P1: deterministic filename collisions must not erase user files).
 */
const CODEX_AGENT_PROFILES_MANIFEST_PATH = ".agent-harness-profiles.json";
/**
 * Records whether THIS apply created the repo marketplace file from scratch
 * (plain name/interface/plugins) versus merged into a user-owned or repo-owned
 * marketplace that already existed. Reset deletes the whole marketplace file
 * ONLY when this manifest proves Agent Harness created it; a user's own
 * `agent-harness-local` marketplace that merely looks managed-shaped must
 * survive (review / Greptile P1: never infer whole-file ownership from a
 * shape heuristic).
 */
const CODEX_MARKETPLACE_OWNERSHIP_MANIFEST = ".agent-harness-marketplace.json";

async function writeCodexAgentProfiles(
  workspaceRoot: string,
  nativeAssets: NativeAsset[],
): Promise<void> {
  const agents = nativeAssets.filter((asset) => asset.assetKind === "agent");
  const agentsDir = join(workspaceRoot, ".codex", "agents");
  const manifestPath = join(agentsDir, CODEX_AGENT_PROFILES_MANIFEST_PATH);
  // Preserve the ORIGINAL priorContent for files a previous apply already
  // owned (indexed by fileName). Without this, a re-apply would re-snapshot
  // the harness's own written bytes as the new "prior", so a user file
  // displaced on the first apply would be "restored" to harness content on
  // remove (re-apply poisons fresh snapshots — same trap as the wire-reset
  // ownership doctored for opencode's gitignoreOwnedEntries).
  const previousByFileName = new Map(
    (await readCodexAgentProfileRecords(workspaceRoot))?.map((record) => [
      record.fileName,
      record.priorContent,
    ]) ?? [],
  );
  const records: CodexAgentProfileRecord[] = [];
  for (const asset of agents) {
    const slug = sanitizeAssetId(asset.assetId).replace(
      /[^a-zA-Z0-9_-]+/gu,
      "-",
    );
    const fileName = `${CODEX_AGENT_FILE_PREFIX}${slug}.toml`;
    const profilePath = join(agentsDir, fileName);
    const priorPriorContent = previousByFileName.get(fileName);
    records.push({
      fileName,
      priorContent:
        priorPriorContent !== undefined
          ? priorPriorContent
          : await readTextFileOrNull(profilePath),
    });
    await writeTextFile(
      profilePath,
      [
        `name = ${JSON.stringify(asset.displayName)}`,
        `description = ${JSON.stringify(`Agent Harness asset ${asset.assetId}`)}`,
        `developer_instructions = ${JSON.stringify(asset.content)}`,
        "",
      ].join("\n"),
    );
  }

  if (agents.length > 0) {
    await writeJsonFile(manifestPath, {
      schemaVersion: 1,
      profiles: records,
    });
  } else {
    // No agent assets in this apply. Consume the previous ownership manifest
    // BEFORE dropping it: restore any displaced user profile content and remove
    // profiles this harness created, so a generated profile never strands in
    // the user's tree and a later reset can still reclaim it (review: Greptile
    // P1 + CodeRabbit — a no-agent re-apply must not lose profile ownership).
    await removeCodexAgentProfiles(workspaceRoot);
    return;
  }
}

/** Reads the owned-profile manifest recorded by the last apply (null if none). */
async function readCodexAgentProfileRecords(
  workspaceRoot: string,
): Promise<CodexAgentProfileRecord[] | null> {
  const manifest = await readJsonFileOrNull<{
    profiles?: unknown;
  }>(
    join(workspaceRoot, ".codex", "agents", CODEX_AGENT_PROFILES_MANIFEST_PATH),
  );
  if (!manifest || !Array.isArray(manifest.profiles)) {
    return null;
  }
  return manifest.profiles.filter((entry): entry is CodexAgentProfileRecord => {
    if (!isJsonObject(entry)) return false;
    if (typeof entry.fileName !== "string") return false;
    // A plain `agent-harness-*.toml` filename only — reject separators and
    // the empty slug so a hostile manifest can never point cleanup at a path
    // outside `.codex/agents` (review / CodeRabbit CWE-22 path traversal).
    if (!CODEX_AGENT_PROFILE_NAME_PATTERN.test(entry.fileName)) return false;
    // priorContent is exactly the recorded shape (string | null).
    if (entry.priorContent !== null && typeof entry.priorContent !== "string") {
      return false;
    }
    return true;
  });
}

/** Merges the managed plugin into the repo/team Codex marketplace. */
export async function mergeCodexPluginMarketplace(
  filePath: string,
): Promise<CodexMarketplaceStyle> {
  const existing = await readJsonFileOrNull<unknown>(filePath);
  // Whole-file ownership: true only when the marketplace file did NOT exist
  // before this apply, so reset can later delete it (and only it) safely.
  const createdNow = existing === null;
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
    await recordCodexMarketplaceOwnership(filePath, createdNow);
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
  await recordCodexMarketplaceOwnership(filePath, createdNow);
  return "current";
}

/**
 * Records whether this apply created the marketplace file from scratch, so
 * `removeCodexMarketplaceEntry` can distinguish an Agent-Harness-created file
 * (safe to delete on reset) from a user/repo-owned one that merely looks
 * managed-shaped (must survive — Greptile P1).
 */
async function recordCodexMarketplaceOwnership(
  filePath: string,
  created: boolean,
): Promise<void> {
  await writeJsonFile(
    join(dirname(filePath), CODEX_MARKETPLACE_OWNERSHIP_MANIFEST),
    { schemaVersion: 1, created },
  );
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
  await claimCodexPluginDirectory(legacyPluginRoot);
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
  const pluginRoot = join(workspaceRoot, "plugins", CODEX_PLUGIN_NAME);
  if (await hasManagedPluginMarker(pluginRoot, CODEX_PLUGIN_NAME)) {
    await removePath(pluginRoot);
  }
  const legacyPluginRoot = join(
    workspaceRoot,
    ".agents",
    "plugins",
    CODEX_PLUGIN_NAME,
  );
  if (await hasManagedPluginMarker(legacyPluginRoot, CODEX_PLUGIN_NAME)) {
    await removePath(legacyPluginRoot);
  }
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
  const records = await readCodexAgentProfileRecords(workspaceRoot);
  if (records === null) {
    // No ownership record: do NOT prefix-delete. Over-preservation is safe —
    // never delete user files we cannot prove we own (review / Greptile P1).
    return;
  }
  for (const record of records) {
    const profilePath = join(agentsDir, record.fileName);
    if (record.priorContent === null) {
      // This apply created the profile (absent before apply) — remove it.
      await removePath(profilePath);
    } else {
      // A user-owned profile was displaced at apply — restore its original
      // content instead of deleting it.
      await writeTextFile(profilePath, record.priorContent);
    }
  }
  await removePath(join(agentsDir, CODEX_AGENT_PROFILES_MANIFEST_PATH));
}

async function removeCodexMarketplaceEntry(filePath: string): Promise<void> {
  const ownershipManifestPath = join(
    dirname(filePath),
    CODEX_MARKETPLACE_OWNERSHIP_MANIFEST,
  );
  const ownership = await readJsonFileOrNull<{
    created?: unknown;
  }>(ownershipManifestPath);
  const ownsWholeFile = ownership !== null && ownership.created === true;
  // Always consume the ownership manifest — this apply is done with it.
  await removePath(ownershipManifestPath);

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
  // Delete the ENTIRE file only when the ownership manifest proves this apply
  // created it AND it is still the un-touched managed shape. A user-owned
  // `agent-harness-local` marketplace that merely looks managed-shaped must
  // survive (review / Greptile P1); a managed file the user edited since
  // apply is stripped of the managed entry but never wholesale-deleted.
  if (ownsWholeFile && isManagedFreshMarketplace) {
    await removePath(filePath);
    return;
  }

  await writeJsonFile(filePath, { ...marketplace, plugins });
}
