export type AuthorityTier =
  | "trusted-local"
  | "official-first-party"
  | "official-marketplace"
  | "official-compatible"
  | "trusted-community"
  | "unverified-community"

export type SourceKind =
  | "repo"
  | "docs"
  | "marketplace"
  | "registry"
  | "package-registry"
  | "local-manifest"
  | "local-directory"

export type AssetKind =
  | "skill"
  | "plugin"
  | "mcp-server"
  | "agent"
  | "instruction"
  | "workflow"
  | "hook"
  | "extension"
  | "prompt-pack"
  | "reference-pack"

export type HostTarget = "copilot-vscode" | "opencode" | "shared"

export type CompatibilityMode =
  | "native"
  | "adaptable"
  | "partial"
  | "reference-only"
  | "incompatible"

export interface SourcePublisher {
  name: string
  verified?: boolean
  owner?: string
}

export interface SourceRules {
  officialPreferred: boolean
  allowMirror: boolean
  allowInstall: boolean
}

export interface SourceDefinition {
  id: string
  name: string
  kind: SourceKind
  authorityTier: AuthorityTier
  publisher?: SourcePublisher
  hosts: HostTarget[]
  assetKinds: AssetKind[]
  discoveryMode: "catalog" | "seed"
  priority: number
  enabled: boolean
  endpoints: Record<string, string>
  rules: SourceRules
}

export interface SourceRegistry {
  $schema?: string
  schemaVersion: number
  sources: SourceDefinition[]
}

export interface SelectionPolicies {
  officialBeatsPopularity: boolean
  starsAreTieBreakerOnly: boolean
  preferNativeOverAdaptable: boolean
  preferLowerRiskWhenEquivalent: boolean
  preferLowerContextCostWhenEquivalent: boolean
  communityDefaultPolicy: "catalog-only-unless-promoted"
}

export interface DuplicateGroup {
  id: string
  capability: string
  preferredAuthorityTier: AuthorityTier | string
  selectionReason: string
}

export interface SelectionRegistry {
  $schema?: string
  schemaVersion: number
  selectionPolicies: SelectionPolicies
  rankingOrder: string[]
  duplicateGroups: DuplicateGroup[]
}

export interface DemandSignalSet {
  languages: string[]
  packageManagers: string[]
  frameworks: string[]
  concerns: string[]
  tooling: string[]
}

export interface DemandEvidence {
  path: string
  fileName: string
  matchedSignals: DemandSignalSet
}

export interface DemandProfile {
  schemaVersion: number
  generatedAt: string
  scanRoot: string
  summary: {
    scannedFiles: number
    matchedFiles: number
  }
  signals: DemandSignalSet
  evidence: DemandEvidence[]
}

export interface SourceIndex {
  schemaVersion: number
  generatedAt: string
  sourceCount: number
  byAuthorityTier: Record<string, number>
  byKind: Record<string, number>
  hostCoverage: Record<string, number>
  communityDefaultPolicy: string
  enabledSources: Array<{
    id: string
    kind: SourceKind
    authorityTier: AuthorityTier
    priority: number
    hosts: HostTarget[]
  }>
}

export interface AssetSourceMetadata {
  sourceId: string
  authorityTier: AuthorityTier
  sourceKind: SourceKind
  sourcePriority: number
  originUrl: string
  publisher: string
  publisherVerified: boolean
}

export interface AssetTrust {
  score: number
  signals: string[]
}

export interface AssetInstallMetadata {
  method: string
  nativeHosts?: HostTarget[]
  adaptableHosts?: HostTarget[]
  relativePath?: string
  manifestEntry?: string
  dependencies?: string[]
}

export interface AssetEvidence {
  manifestFound: boolean
  readmeFound: boolean
  examplesFound: boolean
  docsLinked: boolean
  frontmatterFound?: boolean
  lineCount?: number
  dependencies?: string[]
  filePath?: string
  rootPath?: string
}

export interface AssetMaintenance {
  lastUpdated: string
  stars: number
  releaseCadence: string
}

export interface AssetRisk {
  level: "low" | "medium" | "high"
  hasHooks: boolean
  hasExecScripts: boolean
  requiresNetwork: boolean
}

export interface AssetContextCost {
  sizeClass: "tiny" | "small" | "medium" | "large"
  estimatedPromptWeight: number
}

export interface AssetFit {
  portfolioFit: number
  hostFit: number
}

export interface AssetDedupe {
  duplicateGroup?: string
  candidateRankHint: string
}

export interface AssetStatus {
  cataloged: boolean
  mirrorEligible: boolean
  installEligible: boolean
  activationEligible: boolean
}

export interface AssetCatalogEntry {
  id: string
  displayName: string
  assetKind: AssetKind
  hosts: HostTarget[]
  compatibilityMode: CompatibilityMode
  source: AssetSourceMetadata
  trust: AssetTrust
  capabilities: string[]
  install: AssetInstallMetadata
  evidence: AssetEvidence
  maintenance: AssetMaintenance
  risk: AssetRisk
  contextCost: AssetContextCost
  fit: AssetFit
  dedupe: AssetDedupe
  status: AssetStatus
}

export interface BundleTemplate {
  id: string
  host: HostTarget
  description: string
  assetKinds: AssetKind[]
  defaultPromotion: string
}

export interface MirrorPolicy {
  schemaVersion: number
  selection: {
    officialBeatsPopularity: boolean
    requirePinnedProvenance: boolean
    communityDefaultPolicy: string
  }
  audit: {
    alwaysAudit: boolean
    quarantineOn: string[]
  }
  store: {
    root: string
    rawDirectories: string[]
    normalizedDirectories: string[]
    bundlesDirectory: string
    quarantineDirectory: string
    auditDirectory: string
  }
  bundleTemplates: BundleTemplate[]
}

export interface MirrorPlan {
  schemaVersion: number
  generatedAt: string
  inputs: {
    demandProfile: boolean
    sourceIndex: boolean
    catalogEntries: number
    mirrorEligibleEntries: number
    selectedCatalogEntries: number
  }
  candidateBreakdown: {
    byHost: Record<string, number>
    byAssetKind: Record<string, number>
  }
  policies: {
    officialBeatsPopularity: boolean
    communityDefaultPolicy: string
    alwaysAudit: boolean
  }
  bundleTemplates: BundleTemplate[]
  nextActions: string[]
}

export interface SelectionDuplicateDecision {
  duplicateGroup: string
  selectedAssetId: string
  rejectedAssetIds: string[]
  selectionReason: string
}

export interface SelectionReport {
  schemaVersion: number
  generatedAt: string
  inputCount: number
  selectedCount: number
  rejectedCount: number
  duplicateDecisions: SelectionDuplicateDecision[]
}

export interface BundleLockAsset {
  assetId: string
  mirrorId: string
  projectionType: string
  activationEligible: boolean
  notes?: string
}

export interface BundleLock {
  schemaVersion: number
  bundleId: string
  generatedAt: string
  host: HostTarget
  assets: BundleLockAsset[]
}

export interface MirrorIndexEntry {
  mirrorId: string
  assetId: string
  upstream: {
    type: "repo" | "package" | "marketplace" | "docs" | "local"
    url: string
    ref?: string
    commit?: string
    version?: string
  }
  source: {
    authorityTier: AuthorityTier
    publisher: string
    publisherVerified: boolean
  }
  mirroredAt: string
  contentHash: string
  projectionCandidates: Array<{
    host: HostTarget
    projectionType: string
  }>
  status: "approved" | "approved-with-warning" | "quarantined" | "metadata-only" | "reference-only"
}

export interface MirrorAcquireState {
  schemaVersion: number
  updatedAt: string
  batchSize: number
  totalEligibleCount: number
  mirroredCount: number
  remainingCount: number
  lastBatchAssetIds: string[]
}

export interface InstalledPackageManifest {
  schemaVersion: number
  assetId: string
  mirrorId: string
  host: HostTarget
  installedAt: string
  projectionType: string
  assetKind: AssetKind
  sourceAuthorityTier: AuthorityTier
  contextCost: AssetContextCost
  portfolioFit: number
  filesRoot: string
  bundleMembership: string[]
  activationEligible: boolean
  activeByDefault: boolean
}

export interface InstalledBundleManifest {
  schemaVersion: number
  bundleId: string
  host: HostTarget
  installedAt: string
  packages: Array<{
    assetId: string
    mirrorId: string
    manifestPath: string
  }>
}

export interface InstallGenerationManifest {
  schemaVersion: number
  generationId: string
  host: HostTarget
  generatedAt: string
  bundleIds: string[]
  packageManifestPaths: string[]
}

export interface InstallProgressState {
  schemaVersion: number
  updatedAt: string
  bundles: Record<string, {
    host: HostTarget
    batchSize: number
    totalAssets: number
    installedAssets: number
    remainingAssets: number
    lastBatchAssetIds: string[]
  }>
}

export interface ActivationManifest {
  schemaVersion: number
  host: HostTarget
  generatedAt: string
  generationId?: string
  activeBundles: string[]
  activeAssets: string[]
  runtimeRoot: string
  notes: string[]
}

export interface CopilotWorkspaceOverlayManifest {
  schemaVersion: 1
  host: "copilot-vscode"
  generatedAt: string
  workspaceRoot: string
  selectedBundleIds: string[]
  selectedAssetIds: string[]
  activationBudget: number
  mode: string
  sessionIntent?: string
  concernBuckets?: Record<string, string[]>
  taskModeBuckets?: Record<string, string[]>
}

export interface RecommendationEntry {
  assetId: string
  host: HostTarget
  score: number
  reasons: string[]
}

export interface RecommendationReport {
  schemaVersion: number
  generatedAt: string
  topByHost: Record<string, RecommendationEntry[]>
  suggestedBundles: Array<{
    host: HostTarget
    bundleId: string
    assetIds: string[]
  }>
}

export interface CopilotWorkspaceProfileManifest {
  schemaVersion: number
  generatedAt: string
  profileId: string
  workspaceRoot: string
  bundleIds: string[]
  selectedAssetIds: string[]
  selectedInstructionIds: string[]
  selectedAgentIds: string[]
  selectedWorkflowIds: string[]
  selectedPluginIds?: string[]
  selectedHookIds?: string[]
  selectedSkillIds?: string[]
  activationBudget: number
  sessionIntent?: string
}

export interface WirePlanManifest {
  schemaVersion: number
  host: HostTarget | "vscode-user" | "opencode-project"
  generatedAt: string
  workspaceRoot: string
  runtimeRoot: string
  instructionsFiles?: string[]
  agentFiles?: string[]
  skillDirs?: string[]
  pluginDirs?: string[]
  hookFiles?: string[]
  notes: string[]
}

export interface WirePreviewManifest {
  schemaVersion: number
  host: "vscode" | "opencode"
  mode: "preview" | "apply" | "reset"
  generatedAt: string
  workspaceRoot: string
  targetPaths: string[]
  notes: string[]
}
