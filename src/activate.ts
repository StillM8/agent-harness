import { join } from "node:path"

import { copyPath, ensureDirectory, listFilesRecursive, pathExists, readJsonFile, readJsonFileOrNull, removePath, toPosixPath, writeJsonFile } from "./files.js"
import type { ActivationManifest, CopilotWorkspaceOverlayManifest, CopilotWorkspaceProfileManifest, InstallGenerationManifest, InstalledBundleManifest, InstalledPackageManifest, RecommendationReport } from "./types.js"

const HOST_TO_INTENT_TERMS: Record<"opencode" | "copilot-vscode" | "shared", string[]> = {
  opencode: ["backend", "architecture", "workflow", "infrastructure", "security", "docker", "container", "database", "webhook", "apify", "duckdb"],
  "copilot-vscode": ["instruction", "plugin", "hook", "agent", "workflow", "skill", "backend", "node", "nodejs", "express", "webhook", "integration", "docker", "container", "duckdb", "apify", "actor", "automation", "testing", "security", "developer-workflow", "docs"],
  shared: ["mcp", "integration", "governance", "tooling"]
}

export async function runActivate(
  args: string[],
  _workingDirectory: string,
  projectRoot: string
): Promise<number> {
  const [command = "help", ...rest] = args

  switch (command) {
    case "host":
      await activateHosts(projectRoot, rest)
      return 0
    case "rollback":
      await rollbackActivation(projectRoot, rest)
      return 0
    case "reset":
      await resetActivationState(projectRoot)
      return 0
    case "help":
      printActivateHelp()
      return 0
    default:
      printActivateHelp()
      return 1
  }
}

async function activateHosts(projectRoot: string, args: string[] = []): Promise<void> {
  const sessionIntent = getOptionValue(args, "--intent") ?? "general"
  await activateHost(projectRoot, "opencode", ["opencode-global", "community-stable"], sessionIntent)
  await activateHost(projectRoot, "copilot-vscode", ["copilot-core", "community-stable"], sessionIntent)
  await activateHost(projectRoot, "shared", ["shared-mcp"], sessionIntent)
  console.log(`Activation views written under ${toPosixPath(join(projectRoot, "activate"))}`)
}

async function activateHostsFromInstalledState(projectRoot: string): Promise<void> {
  await activateHost(projectRoot, "opencode", await discoverInstalledBundleIds(projectRoot, "opencode"), "general")
  await activateHost(projectRoot, "copilot-vscode", await discoverInstalledBundleIds(projectRoot, "copilot-vscode"), "general")
  await activateHost(projectRoot, "shared", await discoverInstalledBundleIds(projectRoot, "shared"), "general")
  console.log(`Activation views written under ${toPosixPath(join(projectRoot, "activate"))}`)
}

async function activateHost(
  projectRoot: string,
  host: "opencode" | "copilot-vscode" | "shared",
  bundleIds: string[],
  sessionIntent: string
): Promise<void> {
  const activeAssets = new Set<string>()
  const runtimeRoot = join(projectRoot, "activate", host)
  await ensureDirectory(runtimeRoot)
  const activationBudget = getActivationBudget(host)
  const recommendationReport = await readJsonFileOrNull<RecommendationReport>(join(projectRoot, "state", "recommendations.json"))
  const currentGeneration = await readJsonFileOrNull<InstallGenerationManifest>(
    join(projectRoot, "install", "generations", host, "current.json")
  )
  const preferredAssetOrder = new Map(
    (recommendationReport?.topByHost[host] ?? []).map((entry, index) => [entry.assetId, index])
  )
  const activeBundleIds = filterBundleIdsForHost(bundleIds, host, recommendationReport)
  const candidates: Array<{ packageManifest: InstalledPackageManifest; destinationRoot: string }> = []

  for (const bundleId of activeBundleIds) {
    const bundleManifestPath = join(projectRoot, "install", host, "bundles", `${bundleId}.install.json`)
    if (!(await pathExists(bundleManifestPath))) {
      continue
    }

    const bundleManifest = await readJsonFile<InstalledBundleManifest>(bundleManifestPath)

    for (const pkg of bundleManifest.packages) {
      const packageManifest = await readJsonFile<InstalledPackageManifest>(pkg.manifestPath)
      if (currentGeneration && !currentGeneration.packageManifestPaths.includes(pkg.manifestPath)) {
        continue
      }
      const destinationRoot = join(runtimeRoot, sanitizeAssetId(packageManifest.assetId))
      candidates.push({ packageManifest, destinationRoot })
    }
  }

  const selectedCandidates = candidates
    .sort((left, right) => compareActivationCandidates(left.packageManifest, right.packageManifest, preferredAssetOrder, host, sessionIntent))
    .slice(0, activationBudget)

  await writeJsonFile(join(runtimeRoot, `${host}-overlay-plan.json`), {
    schemaVersion: 1,
    host,
    generatedAt: new Date().toISOString(),
    selectedBundleIds: activeBundleIds,
    selectedAssetIds: selectedCandidates.map((candidate) => candidate.packageManifest.assetId),
    activationBudget,
    mode: host === "copilot-vscode" ? "profile-workspace-overlay" : host === "opencode" ? "global-harness-overlay" : "shared-runtime-overlay",
    sessionIntent,
    concernBuckets: buildConcernBuckets(selectedCandidates.map((candidate) => candidate.packageManifest.assetId)),
    taskModeBuckets: buildTaskModeBuckets(selectedCandidates.map((candidate) => candidate.packageManifest.assetId))
  } satisfies CopilotWorkspaceOverlayManifest | Record<string, unknown>)

  if (host === "copilot-vscode") {
    const selectedSkillIds = selectedCandidates
      .filter((candidate) => candidate.packageManifest.assetKind === "skill")
      .map((candidate) => candidate.packageManifest.assetId)

    const fallbackSkillIds = candidates
      .map((candidate) => candidate.packageManifest)
      .filter((packageManifest) => packageManifest.assetKind === "skill")
      .sort((left, right) => compareActivationCandidates(left, right, preferredAssetOrder, host, sessionIntent))
      .slice(0, 12)
      .map((packageManifest) => packageManifest.assetId)

    const mergedSkillIds = [...new Set([...selectedSkillIds, ...fallbackSkillIds])]

    const copilotProfileManifest: CopilotWorkspaceProfileManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      profileId: buildCopilotProfileId(selectedCandidates.map((candidate) => candidate.packageManifest.assetId)),
      workspaceRoot: toPosixPath(projectRoot),
      bundleIds: activeBundleIds,
      selectedAssetIds: selectedCandidates.map((candidate) => candidate.packageManifest.assetId),
      selectedInstructionIds: selectedCandidates
        .filter((candidate) => candidate.packageManifest.assetKind === "instruction")
        .map((candidate) => candidate.packageManifest.assetId),
      selectedAgentIds: selectedCandidates
        .filter((candidate) => candidate.packageManifest.assetKind === "agent")
        .map((candidate) => candidate.packageManifest.assetId),
      selectedWorkflowIds: selectedCandidates
        .filter((candidate) => candidate.packageManifest.assetKind === "workflow")
        .map((candidate) => candidate.packageManifest.assetId),
      selectedPluginIds: selectedCandidates
        .filter((candidate) => candidate.packageManifest.assetKind === "plugin")
        .map((candidate) => candidate.packageManifest.assetId),
      selectedHookIds: selectedCandidates
        .filter((candidate) => candidate.packageManifest.assetKind === "hook")
        .map((candidate) => candidate.packageManifest.assetId),
      selectedSkillIds: mergedSkillIds,
      activationBudget,
      sessionIntent
    }

    for (const fallbackSkillId of mergedSkillIds) {
      if (!copilotProfileManifest.selectedAssetIds.includes(fallbackSkillId)) {
        copilotProfileManifest.selectedAssetIds.push(fallbackSkillId)
      }
    }

    await writeJsonFile(join(runtimeRoot, "workspace-profile-manifest.json"), copilotProfileManifest)
  }

  for (const candidate of selectedCandidates) {
    await copyPath(candidate.packageManifest.filesRoot, candidate.destinationRoot)
    activeAssets.add(candidate.packageManifest.assetId)
  }

  const activationManifest: ActivationManifest = {
    schemaVersion: 1,
    host,
    generatedAt: new Date().toISOString(),
    generationId: currentGeneration?.generationId,
    activeBundles: activeBundleIds,
    activeAssets: [...activeAssets].sort(),
    runtimeRoot: toPosixPath(runtimeRoot),
    notes: [
      "Activation currently materializes staged install outputs into host-specific runtime views.",
      `Token-budget-aware pruning applied with current host budget of ${activationBudget} assets.`
    ]
  }

  await writeJsonFile(join(runtimeRoot, "activation-manifest.json"), activationManifest)
}

function filterBundleIdsForHost(
  bundleIds: string[],
  host: "opencode" | "copilot-vscode" | "shared",
  recommendationReport: RecommendationReport | null
): string[] {
  const suggestedBundleIds = new Set(
    (recommendationReport?.suggestedBundles ?? [])
      .filter((bundle) => bundle.host === host)
      .map((bundle) => bundle.bundleId)
  )

  if (suggestedBundleIds.size === 0) {
    return bundleIds
  }

  const filteredBundleIds = bundleIds.filter((bundleId) => suggestedBundleIds.has(bundleId))
  return filteredBundleIds.length > 0 ? filteredBundleIds : bundleIds
}

function printActivateHelp(): void {
  console.log(`activate commands:
  host      Materialize active host views from installed bundles
  rollback  Point a host to a previous install generation
  reset     Remove activation outputs`)
}

function sanitizeAssetId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-")
}

function buildCopilotProfileId(assetIds: string[]): string {
  return assetIds
    .slice(0, 12)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .slice(0, 96)
}

function getActivationBudget(host: "opencode" | "copilot-vscode" | "shared"): number {
  if (host === "copilot-vscode") {
    return 60
  }

  if (host === "opencode") {
    return 120
  }

  return 40
}

async function discoverInstalledBundleIds(
  projectRoot: string,
  host: "opencode" | "copilot-vscode" | "shared"
): Promise<string[]> {
  const bundlesRoot = join(projectRoot, "install", host, "bundles")
  if (!(await pathExists(bundlesRoot))) {
    return []
  }

  const files = await listFilesRecursive(bundlesRoot)
  return files
    .filter((filePath) => filePath.endsWith(".install.json"))
    .map((filePath) => filePath.split(/[/\\]/u).at(-1)?.replace(/\.install\.json$/u, "") ?? filePath)
    .sort((left, right) => left.localeCompare(right))
}

function compareActivationCandidates(
  left: InstalledPackageManifest,
  right: InstalledPackageManifest,
  preferredAssetOrder: Map<string, number>,
  host: "opencode" | "copilot-vscode" | "shared",
  sessionIntent: string
): number {
  const recommendedOrderDifference = getRecommendationOrder(left.assetId, preferredAssetOrder) - getRecommendationOrder(right.assetId, preferredAssetOrder)
  if (recommendedOrderDifference !== 0) {
    return recommendedOrderDifference
  }

  const intentDifference = computeIntentBoost(right.assetId, host) - computeIntentBoost(left.assetId, host)
  if (intentDifference !== 0) {
    return intentDifference
  }

  const sessionIntentDifference = computeSessionIntentBoost(right.assetId, sessionIntent) - computeSessionIntentBoost(left.assetId, sessionIntent)
  if (sessionIntentDifference !== 0) {
    return sessionIntentDifference
  }

  const authorityDifference = getAuthorityRank(right.sourceAuthorityTier) - getAuthorityRank(left.sourceAuthorityTier)
  if (authorityDifference !== 0) {
    return authorityDifference
  }

  const portfolioFitDifference = right.portfolioFit - left.portfolioFit
  if (portfolioFitDifference !== 0) {
    return portfolioFitDifference
  }

  const contextCostDifference = getContextCostRank(left.contextCost.sizeClass) - getContextCostRank(right.contextCost.sizeClass)
  if (contextCostDifference !== 0) {
    return contextCostDifference
  }

  return left.assetId.localeCompare(right.assetId)
}

function computeIntentBoost(assetId: string, host: "opencode" | "copilot-vscode" | "shared"): number {
  const terms = HOST_TO_INTENT_TERMS[host]
  const normalizedAssetId = assetId.toLowerCase()
  const matchedIntentTerms = terms.reduce((total, term) => total + (normalizedAssetId.includes(term) ? 1 : 0), 0)
  const apifySpecificBoost =
    host === "copilot-vscode" && (
      normalizedAssetId.includes("apify") ||
      normalizedAssetId.includes("actor") ||
      normalizedAssetId.includes("scraper") ||
      normalizedAssetId.includes("automation")
    )
      ? 6
      : 0

  return matchedIntentTerms + apifySpecificBoost
}

function computeSessionIntentBoost(assetId: string, sessionIntent: string): number {
  if (!sessionIntent || sessionIntent === "general") {
    return 0
  }

  const normalizedAssetId = assetId.toLowerCase()
  return normalizedAssetId.includes(sessionIntent.toLowerCase()) ? 3 : 0
}

function buildConcernBuckets(assetIds: string[]): Record<string, string[]> {
  const buckets: Record<string, string[]> = {
    frontend: [],
    backend: [],
    integration: [],
    data: [],
    security: [],
    docs: [],
    testing: [],
    infra: []
  }

  for (const assetId of assetIds) {
    const normalizedAssetId = assetId.toLowerCase()
    if (normalizedAssetId.includes("front") || normalizedAssetId.includes("react") || normalizedAssetId.includes("ui")) {
      buckets.frontend.push(assetId)
    }
    if (
      normalizedAssetId.includes("backend") ||
      normalizedAssetId.includes("api") ||
      normalizedAssetId.includes("service") ||
      normalizedAssetId.includes("webhook") ||
      normalizedAssetId.includes("express") ||
      normalizedAssetId.includes("node") ||
      normalizedAssetId.includes("apify")
    ) {
      buckets.backend.push(assetId)
    }
    if (normalizedAssetId.includes("webhook") || normalizedAssetId.includes("integration") || normalizedAssetId.includes("apify")) {
      buckets.integration.push(assetId)
    }
    if (normalizedAssetId.includes("duckdb") || normalizedAssetId.includes("database") || normalizedAssetId.includes("sql")) {
      buckets.data.push(assetId)
    }
    if (normalizedAssetId.includes("security") || normalizedAssetId.includes("auth") || normalizedAssetId.includes("threat")) {
      buckets.security.push(assetId)
    }
    if (normalizedAssetId.includes("doc") || normalizedAssetId.includes("readme") || normalizedAssetId.includes("instruction")) {
      buckets.docs.push(assetId)
    }
    if (normalizedAssetId.includes("test") || normalizedAssetId.includes("playwright") || normalizedAssetId.includes("qa")) {
      buckets.testing.push(assetId)
    }
    if (
      normalizedAssetId.includes("infra") ||
      normalizedAssetId.includes("devops") ||
      normalizedAssetId.includes("terraform") ||
      normalizedAssetId.includes("azure") ||
      normalizedAssetId.includes("docker") ||
      normalizedAssetId.includes("container")
    ) {
      buckets.infra.push(assetId)
    }
  }

  return buckets
}

function buildTaskModeBuckets(assetIds: string[]): Record<string, string[]> {
  return {
    focused: assetIds.slice(0, 20),
    broad: assetIds.slice(0, 60)
  }
}

function getRecommendationOrder(assetId: string, preferredAssetOrder: Map<string, number>): number {
  return preferredAssetOrder.get(assetId) ?? Number.MAX_SAFE_INTEGER
}

function getAuthorityRank(authorityTier: InstalledPackageManifest["sourceAuthorityTier"]): number {
  const ranks: Record<InstalledPackageManifest["sourceAuthorityTier"], number> = {
    "official-first-party": 6,
    "official-marketplace": 5,
    "official-compatible": 4,
    "trusted-local": 3,
    "trusted-community": 2,
    "unverified-community": 1
  }

  return ranks[authorityTier]
}

function getContextCostRank(sizeClass: InstalledPackageManifest["contextCost"]["sizeClass"]): number {
  const ranks: Record<InstalledPackageManifest["contextCost"]["sizeClass"], number> = {
    tiny: 1,
    small: 2,
    medium: 3,
    large: 4
  }

  return ranks[sizeClass]
}

async function rollbackActivation(projectRoot: string, args: string[]): Promise<void> {
  const host = getOptionValue(args, "--host") as "opencode" | "copilot-vscode" | "shared" | undefined
  const generationId = getOptionValue(args, "--generation")

  if (!host || !generationId) {
    throw new Error("rollback requires --host and --generation")
  }

  const generationPath = join(projectRoot, "install", "generations", host, `${generationId}.json`)
  if (!(await pathExists(generationPath))) {
    throw new Error(`generation not found: ${toPosixPath(generationPath)}`)
  }

  const generation = await readJsonFile<InstallGenerationManifest>(generationPath)
  await writeJsonFile(join(projectRoot, "install", "generations", host, "current.json"), generation)
  await activateHosts(projectRoot)
}

async function resetActivationState(projectRoot: string): Promise<void> {
  await removePath(join(projectRoot, "activate"))
  console.log(`Activation state reset under ${toPosixPath(join(projectRoot, "activate"))}`)
}

function getOptionValue(args: string[], optionName: string): string | undefined {
  const optionIndex = args.indexOf(optionName)

  if (optionIndex === -1) {
    return undefined
  }

  return args[optionIndex + 1]
}
