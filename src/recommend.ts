import { join } from "node:path"

import { readJsonFileOrNull, readJsonLinesFile, writeJsonFile } from "./files.js"
import type { AssetCatalogEntry, AssetKind, DemandProfile, RecommendationEntry, RecommendationReport } from "./types.js"

const HOST_RECOMMENDATION_LIMITS: Record<"opencode" | "copilot-vscode" | "shared", number> = {
  opencode: 80,
  "copilot-vscode": 240,
  shared: 60
}

const COPILOT_RECOMMENDATION_KIND_TARGETS: Array<{ assetKind: AssetKind; count: number }> = [
  { assetKind: "instruction", count: 8 },
  { assetKind: "plugin", count: 8 },
  { assetKind: "agent", count: 6 },
  { assetKind: "workflow", count: 3 },
  { assetKind: "hook", count: 4 },
  { assetKind: "skill", count: 12 }
]

const DEMAND_BOOST_CAP = 32
const STRONG_MATCH_FIT_THRESHOLD = 0.67
const COPILOT_IRRELEVANCE_PENALTY = 18
const COPILOT_PRIORITY_ASSET_KINDS: AssetKind[] = ["instruction", "plugin", "agent", "workflow", "skill", "hook"]
const HIGH_SIGNAL_BACKEND_TERMS = ["apify", "duckdb", "docker", "express", "nodejs", "webhook"]
const SUPPORTING_BACKEND_TERMS = ["backend", "integration", "logging", "replay", "mocking", "database", "container", "security", "testing"]
const WEBHOOK_SIGNAL_TERMS = ["webhook", "replay", "mocking"]

export async function writeRecommendationReport(projectRoot: string): Promise<void> {
  const demandProfile = await readJsonFileOrNull<DemandProfile>(join(projectRoot, "discover", "output", "demand-profile.json"))
  const selectedEntries = await readJsonLinesFile<AssetCatalogEntry>(join(projectRoot, "discover", "output", "catalog.selected.jsonl"))

  const topByHost = {
    opencode: buildTopRecommendationsForHost("opencode", selectedEntries, demandProfile),
    "copilot-vscode": buildTopRecommendationsForHost("copilot-vscode", selectedEntries, demandProfile),
    shared: buildTopRecommendationsForHost("shared", selectedEntries, demandProfile)
  }

  const report: RecommendationReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    topByHost,
    suggestedBundles: [
      {
        host: "opencode",
        bundleId: "opencode-global",
        assetIds: topByHost.opencode.slice(0, 20).map((entry) => entry.assetId)
      },
      {
        host: "copilot-vscode",
        bundleId: "copilot-core",
        assetIds: topByHost["copilot-vscode"].slice(0, 20).map((entry) => entry.assetId)
      },
      {
        host: "shared",
        bundleId: "shared-mcp",
        assetIds: topByHost.shared.slice(0, 20).map((entry) => entry.assetId)
      }
    ]
  }

  await writeJsonFile(join(projectRoot, "state", "recommendations.json"), report)
}

function buildTopRecommendationsForHost(
  host: "opencode" | "copilot-vscode" | "shared",
  entries: AssetCatalogEntry[],
  demandProfile: DemandProfile | null
): RecommendationEntry[] {
  const recommendationLimit = HOST_RECOMMENDATION_LIMITS[host]

  const rankedEntries = entries
    .filter((entry) => entry.hosts.includes(host))
    .map((entry) => ({
      assetId: entry.id,
      host,
      score: computeRecommendationScore(entry, demandProfile, host),
      reasons: buildRecommendationReasons(entry, demandProfile, host),
      assetKind: entry.assetKind
    }))
    .sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId))

  if (host !== "copilot-vscode") {
    return rankedEntries.slice(0, recommendationLimit)
  }

  return selectCopilotRecommendations(rankedEntries, recommendationLimit)
}

function computeRecommendationScore(
  entry: AssetCatalogEntry,
  demandProfile: DemandProfile | null,
  host: "opencode" | "copilot-vscode" | "shared"
): number {
  const authorityScore = getAuthorityScore(entry.source.authorityTier)
  const compatibilityScore = entry.compatibilityMode === "native" ? 30 : entry.compatibilityMode === "adaptable" ? 24 : 10
  const fitScore = Math.round(entry.fit.portfolioFit * 30)
  const costPenalty = getCostPenalty(entry.contextCost.sizeClass)
  const demandBoost = demandProfile ? Math.round(computeDemandBoost(entry, demandProfile)) : 0
  const trustBoost = Math.round(entry.trust.score / 10)
  const hostAssetKindBoost = getHostAssetKindBoost(entry, host)
  const backendPlatformBoost = demandProfile ? computeBackendPlatformBoost(entry, demandProfile, host) : 0
  const instructionPluginBoost = host === "copilot-vscode" ? computeCopilotAssetBalanceBoost(entry, demandProfile) : 0
  const copilotIrrelevancePenalty = host === "copilot-vscode" ? computeCopilotIrrelevancePenalty(entry, demandProfile) : 0
  const officialSkillBoost =
    entry.assetKind === "skill" &&
    entry.source.authorityTier === "official-first-party" &&
    entry.hosts.includes("copilot-vscode")
      ? 28
      : 0

  const apifyBoost =
    entry.id.toLowerCase().includes("apify") ||
    entry.capabilities.some((capability) => capability.toLowerCase().includes("apify")) ||
    entry.capabilities.some((capability) => capability.toLowerCase().includes("actor"))
      ? 18
      : 0

  return authorityScore + compatibilityScore + fitScore + demandBoost + trustBoost + hostAssetKindBoost + backendPlatformBoost + instructionPluginBoost + officialSkillBoost + apifyBoost - costPenalty - copilotIrrelevancePenalty
}

function buildRecommendationReasons(
  entry: AssetCatalogEntry,
  demandProfile: DemandProfile | null,
  host: "opencode" | "copilot-vscode" | "shared"
): string[] {
  const reasons = [`authority:${entry.source.authorityTier}`, `compatibility:${entry.compatibilityMode}`]
  reasons.push(`asset-kind:${entry.assetKind}`)
  reasons.push(`trust:${entry.trust.score}`)
  reasons.push(`source-kind:${entry.source.sourceKind}`)
  reasons.push(`source-priority:${entry.source.sourcePriority}`)
  if (entry.fit.portfolioFit > 0) {
    reasons.push(`portfolio-fit:${entry.fit.portfolioFit}`)
  }
  if (demandProfile && computeDemandBoost(entry, demandProfile) > 0) {
    reasons.push("workspace-signal-match")
  }
  if (getHostAssetKindBoost(entry, host) > 0) {
    reasons.push(`host-kind-preference:${host}`)
  }
  if (demandProfile && computeBackendPlatformBoost(entry, demandProfile, host) > 0) {
    reasons.push("backend-platform-fit")
  }
  if (host === "copilot-vscode" && computeCopilotAssetBalanceBoost(entry, demandProfile) > 0) {
    reasons.push("copilot-balance-fit")
  }
  return reasons
}

function computeDemandBoost(entry: AssetCatalogEntry, demandProfile: DemandProfile): number {
  const demandTerms = new Set(buildDemandTerms(demandProfile))
  const capabilityTerms = new Set(entry.capabilities.flatMap((capability) => tokenizeTerm(capability)))
  let matches = 0

  for (const demandTerm of demandTerms) {
    if (capabilityTerms.has(demandTerm)) {
      matches += 1
    }
  }

  return Math.min(DEMAND_BOOST_CAP, matches * 4)
}

function computeBackendPlatformBoost(
  entry: AssetCatalogEntry,
  demandProfile: DemandProfile,
  host: "opencode" | "copilot-vscode" | "shared"
): number {
  if (host === "shared") {
    return 0
  }

  const demandTerms = new Set(buildDemandTerms(demandProfile))
  const capabilityTerms = new Set(entry.capabilities.flatMap((capability) => tokenizeTerm(capability)))
  const matchedHighSignalTerms = HIGH_SIGNAL_BACKEND_TERMS.filter((term) => demandTerms.has(term) && capabilityTerms.has(term))
  const matchedSupportingTerms = SUPPORTING_BACKEND_TERMS.filter((term) => demandTerms.has(term) && capabilityTerms.has(term))
  const matchedWebhookSignals = WEBHOOK_SIGNAL_TERMS.filter((term) => demandTerms.has(term) && capabilityTerms.has(term))

  let boost = 0

  if (matchedHighSignalTerms.length > 0) {
    boost += matchedHighSignalTerms.length * 5
  }

  if (matchedSupportingTerms.length > 0) {
    boost += matchedSupportingTerms.length * 2
  }

  if (matchedHighSignalTerms.length >= 2) {
    boost += 6
  }

  if (matchedWebhookSignals.length >= 2) {
    boost += 4
  }

  if (entry.fit.portfolioFit >= STRONG_MATCH_FIT_THRESHOLD && isBackendWorkspaceAssetKind(entry.assetKind)) {
    boost += 5
  }

  return boost
}

function computeCopilotAssetBalanceBoost(entry: AssetCatalogEntry, demandProfile: DemandProfile | null): number {
  if (!demandProfile) {
    return 0
  }

  const demandTerms = new Set(buildDemandTerms(demandProfile))
  const capabilityTerms = new Set(entry.capabilities.flatMap((capability) => tokenizeTerm(capability)))
  const hasBackendDemand = [...HIGH_SIGNAL_BACKEND_TERMS, ...SUPPORTING_BACKEND_TERMS].some((term) => demandTerms.has(term))

  if (!hasBackendDemand) {
    return 0
  }

  if ((entry.assetKind === "instruction" || entry.assetKind === "plugin") && hasStrongBackendAlignedCapabilities(capabilityTerms)) {
    return 18
  }

  if (entry.assetKind === "agent" && hasStrongBackendAlignedCapabilities(capabilityTerms)) {
    return 14
  }

  if (entry.assetKind === "workflow" && hasWebhookAlignedCapabilities(capabilityTerms)) {
    return 12
  }

  if (entry.assetKind === "hook" && hasSupportiveBackendCapabilities(capabilityTerms)) {
    return 8
  }

  return 0
}

function computeCopilotIrrelevancePenalty(entry: AssetCatalogEntry, demandProfile: DemandProfile | null): number {
  if (!demandProfile) {
    return 0
  }

  const demandTerms = new Set(buildDemandTerms(demandProfile))
  const hasBackendDemand = [...HIGH_SIGNAL_BACKEND_TERMS, ...SUPPORTING_BACKEND_TERMS].some((term) => demandTerms.has(term))

  if (!hasBackendDemand) {
    return 0
  }

  const capabilityTerms = new Set(entry.capabilities.flatMap((capability) => tokenizeTerm(capability)))

  if (
    (entry.assetKind === "instruction" || entry.assetKind === "plugin" || entry.assetKind === "agent" || entry.assetKind === "workflow") &&
    !hasSupportiveBackendCapabilities(capabilityTerms)
  ) {
    return COPILOT_IRRELEVANCE_PENALTY
  }

  if (entry.assetKind === "hook" && !hasSupportiveBackendCapabilities(capabilityTerms)) {
    return Math.round(COPILOT_IRRELEVANCE_PENALTY / 2)
  }

  return 0
}

function getHostAssetKindBoost(
  entry: AssetCatalogEntry,
  host: "opencode" | "copilot-vscode" | "shared"
): number {
  if (host !== "copilot-vscode") {
    return 0
  }

  const assetKindIndex = COPILOT_PRIORITY_ASSET_KINDS.indexOf(entry.assetKind)
  if (assetKindIndex === -1) {
    return 0
  }

  return COPILOT_PRIORITY_ASSET_KINDS.length - assetKindIndex
}

function selectCopilotRecommendations(
  rankedEntries: RecommendationEntry[],
  recommendationLimit: number
): RecommendationEntry[] {
  const remainingByKind = new Map(COPILOT_RECOMMENDATION_KIND_TARGETS.map((target) => [target.assetKind, target.count]))
  const selectedEntries: RecommendationEntry[] = []
  const selectedAssetIds = new Set<string>()

  while (selectedEntries.length < recommendationLimit) {
    let addedEntryInRound = false

    for (const { assetKind } of COPILOT_RECOMMENDATION_KIND_TARGETS) {
      const remainingCount = remainingByKind.get(assetKind) ?? 0
      if (remainingCount <= 0) {
        continue
      }

      const nextEntry = rankedEntries.find((entry) => entry.assetKind === assetKind && !selectedAssetIds.has(entry.assetId))
      if (!nextEntry) {
        remainingByKind.set(assetKind, 0)
        continue
      }

      selectedEntries.push(nextEntry)
      selectedAssetIds.add(nextEntry.assetId)
      remainingByKind.set(assetKind, remainingCount - 1)
      addedEntryInRound = true

      if (selectedEntries.length >= recommendationLimit) {
        return selectedEntries
      }
    }

    if (!addedEntryInRound) {
      break
    }
  }

  for (const entry of rankedEntries) {
    if (selectedAssetIds.has(entry.assetId)) {
      continue
    }

    selectedEntries.push(entry)
    selectedAssetIds.add(entry.assetId)

    if (selectedEntries.length >= recommendationLimit) {
      break
    }
  }

  return selectedEntries
}

function buildDemandTerms(demandProfile: DemandProfile): string[] {
  return [
    ...demandProfile.signals.languages,
    ...demandProfile.signals.packageManagers,
    ...demandProfile.signals.frameworks,
    ...demandProfile.signals.concerns,
    ...demandProfile.signals.tooling
  ].flatMap((term) => tokenizeTerm(term))
}

function tokenizeTerm(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1)
}

function isBackendWorkspaceAssetKind(assetKind: AssetCatalogEntry["assetKind"]): boolean {
  return assetKind === "instruction" || assetKind === "plugin" || assetKind === "agent" || assetKind === "workflow" || assetKind === "skill"
}

function hasStrongBackendAlignedCapabilities(capabilityTerms: Set<string>): boolean {
  return HIGH_SIGNAL_BACKEND_TERMS.some((term) => capabilityTerms.has(term))
}

function hasSupportiveBackendCapabilities(capabilityTerms: Set<string>): boolean {
  return hasStrongBackendAlignedCapabilities(capabilityTerms) || SUPPORTING_BACKEND_TERMS.some((term) => capabilityTerms.has(term))
}

function hasWebhookAlignedCapabilities(capabilityTerms: Set<string>): boolean {
  return WEBHOOK_SIGNAL_TERMS.some((term) => capabilityTerms.has(term))
}

function getAuthorityScore(authorityTier: AssetCatalogEntry["source"]["authorityTier"]): number {
  const scores: Record<AssetCatalogEntry["source"]["authorityTier"], number> = {
    "official-first-party": 50,
    "official-marketplace": 40,
    "official-compatible": 35,
    "trusted-local": 30,
    "trusted-community": 20,
    "unverified-community": 10
  }

  return scores[authorityTier]
}

function getCostPenalty(sizeClass: AssetCatalogEntry["contextCost"]["sizeClass"]): number {
  const penalties: Record<AssetCatalogEntry["contextCost"]["sizeClass"], number> = {
    tiny: 0,
    small: 3,
    medium: 8,
    large: 15
  }

  return penalties[sizeClass]
}
