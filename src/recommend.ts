import { join } from "node:path"

import { readJsonFileOrNull, readJsonLinesFile, writeJsonFile } from "./files.js"
import type { AssetCatalogEntry, DemandProfile, RecommendationEntry, RecommendationReport } from "./types.js"

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
  const recommendationLimit = host === "copilot-vscode" ? 200 : 50

  return entries
    .filter((entry) => entry.hosts.includes(host))
    .map((entry) => ({
      assetId: entry.id,
      host,
      score: computeRecommendationScore(entry, demandProfile),
      reasons: buildRecommendationReasons(entry, demandProfile)
    }))
    .sort((left, right) => right.score - left.score || left.assetId.localeCompare(right.assetId))
    .slice(0, recommendationLimit)
}

function computeRecommendationScore(entry: AssetCatalogEntry, demandProfile: DemandProfile | null): number {
  const authorityScore = getAuthorityScore(entry.source.authorityTier)
  const compatibilityScore = entry.compatibilityMode === "native" ? 30 : entry.compatibilityMode === "adaptable" ? 24 : 10
  const fitScore = Math.round(entry.fit.portfolioFit * 30)
  const costPenalty = getCostPenalty(entry.contextCost.sizeClass)
  const demandBoost = demandProfile ? Math.round(computeDemandBoost(entry, demandProfile)) : 0
  const trustBoost = Math.round(entry.trust.score / 10)
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

  return authorityScore + compatibilityScore + fitScore + demandBoost + trustBoost + officialSkillBoost + apifyBoost - costPenalty
}

function buildRecommendationReasons(entry: AssetCatalogEntry, demandProfile: DemandProfile | null): string[] {
  const reasons = [`authority:${entry.source.authorityTier}`, `compatibility:${entry.compatibilityMode}`]
  reasons.push(`trust:${entry.trust.score}`)
  reasons.push(`source-kind:${entry.source.sourceKind}`)
  reasons.push(`source-priority:${entry.source.sourcePriority}`)
  if (entry.fit.portfolioFit > 0) {
    reasons.push(`portfolio-fit:${entry.fit.portfolioFit}`)
  }
  if (demandProfile && computeDemandBoost(entry, demandProfile) > 0) {
    reasons.push("workspace-signal-match")
  }
  return reasons
}

function computeDemandBoost(entry: AssetCatalogEntry, demandProfile: DemandProfile): number {
  const demandTerms = new Set([
    ...demandProfile.signals.languages,
    ...demandProfile.signals.frameworks,
    ...demandProfile.signals.concerns,
    ...demandProfile.signals.tooling
  ].map((term) => term.toLowerCase()))

  let matches = 0
  for (const capability of entry.capabilities) {
    if (demandTerms.has(capability.toLowerCase())) {
      matches += 1
    }
  }

  return Math.min(20, matches * 5)
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
