import { join } from "node:path"

import { copyPath, ensureDirectory, listFilesRecursive, pathExists, readJsonFile, readJsonFileOrNull, readJsonLinesFile, removePath, toPosixPath, writeJsonFile } from "./files.js"
import type { AssetCatalogEntry, BundleLock, InstallGenerationManifest, InstallProgressState, InstalledBundleManifest, InstalledPackageManifest, MirrorIndexEntry } from "./types.js"

const INSTALL_PROGRESS_STATE_OUTPUT_PATH = ["state", "install", "progress.json"]
const INSTALL_GENERATIONS_ROOT = ["install", "generations"]

export async function runInstall(
  args: string[],
  _workingDirectory: string,
  projectRoot: string
): Promise<number> {
  const [command = "help", ...rest] = args

  switch (command) {
    case "bundle":
      await installBundles(projectRoot, rest)
      return 0
    case "reconcile":
      await reconcileInstallState(projectRoot)
      return 0
    case "reset":
      await resetInstallState(projectRoot)
      return 0
    case "help":
      printInstallHelp()
      return 0
    default:
      printInstallHelp()
      return 1
  }
}

async function installBundles(projectRoot: string, args: string[]): Promise<void> {
  const mirrorIndexEntries = await readJsonLinesFile<MirrorIndexEntry>(join(projectRoot, "mirror", "index.jsonl"))
  const mirrorIndexById = new Map(mirrorIndexEntries.map((entry) => [entry.mirrorId, entry]))
  const selectedEntries = await readJsonLinesFile<AssetCatalogEntry>(join(projectRoot, "discover", "output", "catalog.selected.jsonl"))
  const selectedEntryById = new Map(selectedEntries.map((entry) => [entry.id, entry]))
  const allBundlePaths = [
    join(projectRoot, "mirror", "bundles", "opencode-global.lock.json"),
    join(projectRoot, "mirror", "bundles", "copilot-core.lock.json"),
    join(projectRoot, "mirror", "bundles", "shared-mcp.lock.json"),
    join(projectRoot, "mirror", "bundles", "community-stable.lock.json")
  ]
  const targetBundleIds = getOptionValues(args, "--bundle")
  const batchSize = Number(getOptionValue(args, "--batch-size") ?? "250")
  const manualBatchOffset = getOptionValue(args, "--offset")
  const bundlePaths = targetBundleIds.length > 0
    ? allBundlePaths.filter((bundlePath) => targetBundleIds.includes(extractBundleId(bundlePath)))
    : allBundlePaths

  for (const bundlePath of bundlePaths) {
    if (!(await pathExists(bundlePath))) {
      continue
    }

    const bundleLock = await readJsonFile<BundleLock>(bundlePath)
    const packageManifests: InstalledBundleManifest["packages"] = []
    const currentBundleAssetIds = new Set(bundleLock.assets.map((asset) => asset.assetId))
    const existingBundleManifest = await readJsonFileOrNull<InstalledBundleManifest>(
      join(projectRoot, "install", bundleLock.host, "bundles", `${bundleLock.bundleId}.install.json`)
    )
    const existingRelevantPackages = (existingBundleManifest?.packages ?? []).filter((pkg) => currentBundleAssetIds.has(pkg.assetId))
    const alreadyInstalledAssetIds = new Set(existingRelevantPackages.map((pkg) => pkg.assetId))
    const installableAssets = getInstallableAssets(bundleLock.assets, mirrorIndexById)
    const pendingAssets = getPendingAssets(installableAssets, alreadyInstalledAssetIds)
    const batchOffset = Number(manualBatchOffset ?? "0")
    const assetsToInstall = pendingAssets.slice(batchOffset, batchOffset + batchSize)

    for (const asset of assetsToInstall) {
      const mirrorEntry = mirrorIndexById.get(asset.mirrorId)
      if (!mirrorEntry) {
        continue
      }

      if (mirrorEntry.status === "quarantined") {
        continue
      }

      const catalogEntry = selectedEntryById.get(asset.assetId)
      if (!catalogEntry) {
        continue
      }

      const sourceMaterialPath = join(projectRoot, "mirror", "raw", sanitizeMirrorId(mirrorEntry.mirrorId))
      if (!(await pathExists(sourceMaterialPath))) {
        continue
      }

      const packageRoot = join(projectRoot, "install", bundleLock.host, "packages", sanitizeAssetId(asset.assetId))
      const filesRoot = join(packageRoot, "files")
      await copyPath(sourceMaterialPath, filesRoot)

      const packageManifest: InstalledPackageManifest = {
        schemaVersion: 1,
        assetId: asset.assetId,
        mirrorId: asset.mirrorId,
        host: bundleLock.host,
        installedAt: new Date().toISOString(),
        projectionType: asset.projectionType,
        assetKind: catalogEntry.assetKind,
        sourceAuthorityTier: catalogEntry.source.authorityTier,
        contextCost: catalogEntry.contextCost,
        portfolioFit: catalogEntry.fit.portfolioFit,
        filesRoot: toPosixPath(filesRoot),
        bundleMembership: [bundleLock.bundleId],
        activationEligible: asset.activationEligible,
        activeByDefault: false
      }

      const manifestPath = join(packageRoot, "install-manifest.json")
      await writeJsonFile(manifestPath, packageManifest)
      packageManifests.push({
        assetId: asset.assetId,
        mirrorId: asset.mirrorId,
        manifestPath: toPosixPath(manifestPath)
      })
    }

    const bundleManifest: InstalledBundleManifest = {
      schemaVersion: 1,
      bundleId: bundleLock.bundleId,
      host: bundleLock.host,
      installedAt: new Date().toISOString(),
      packages: mergeInstalledPackages(existingRelevantPackages, packageManifests)
    }

    await writeJsonFile(
      join(projectRoot, "install", bundleLock.host, "bundles", `${bundleLock.bundleId}.install.json`),
      bundleManifest
    )

    await updateInstallProgressState(
      projectRoot,
      bundleLock.bundleId,
      bundleLock.host,
      batchSize,
      installableAssets,
      bundleManifest.packages,
      assetsToInstall.map((asset) => asset.assetId)
    )
  }

  const progressState = await readJsonFileOrNull<InstallProgressState>(join(projectRoot, ...INSTALL_PROGRESS_STATE_OUTPUT_PATH))
  if (progressState) {
    await writeInstallGenerations(projectRoot, progressState)
  }

  console.log(`Installed bundles written under ${toPosixPath(join(projectRoot, "install"))}`)
}

function mergeInstalledPackages(
  existingPackages: InstalledBundleManifest["packages"],
  newPackages: InstalledBundleManifest["packages"]
): InstalledBundleManifest["packages"] {
  const packagesByAssetId = new Map(existingPackages.map((pkg) => [pkg.assetId, pkg]))

  for (const pkg of newPackages) {
    packagesByAssetId.set(pkg.assetId, pkg)
  }

  return [...packagesByAssetId.values()].sort((left, right) => left.assetId.localeCompare(right.assetId))
}

function printInstallHelp(): void {
  console.log(`install commands:
  bundle      Stage installed assets from mirror bundle locks
  reconcile   Recompute install progress from bundle install manifests
  reset       Remove install state, packages, bundles, and generations`)
}

function sanitizeMirrorId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-")
}

function sanitizeAssetId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-")
}

function getOptionValue(args: string[], optionName: string): string | undefined {
  const optionIndex = args.indexOf(optionName)

  if (optionIndex === -1) {
    return undefined
  }

  return args[optionIndex + 1]
}

function getOptionValues(args: string[], optionName: string): string[] {
  const values: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === optionName) {
      const nextValue = args[index + 1]
      if (nextValue) {
        values.push(nextValue)
      }
    }
  }

  return values
}

function getPendingAssets(
  bundleAssets: BundleLock["assets"],
  installedAssetIds: Set<string>
): BundleLock["assets"] {
  return bundleAssets.filter((asset) => !installedAssetIds.has(asset.assetId))
}

function getInstallableAssets(
  bundleAssets: BundleLock["assets"],
  mirrorIndexById: Map<string, MirrorIndexEntry>
): BundleLock["assets"] {
  return bundleAssets.filter((asset) => {
    const mirrorEntry = mirrorIndexById.get(asset.mirrorId)
    return Boolean(mirrorEntry && mirrorEntry.status !== "quarantined")
  })
}

function extractBundleId(bundlePath: string): string {
  return bundlePath.split(/[/\\]/u).at(-1)?.replace(/\.lock\.json$/u, "") ?? bundlePath
}

async function updateInstallProgressState(
  projectRoot: string,
  bundleId: string,
  host: BundleLock["host"],
  batchSize: number,
  allAssets: BundleLock["assets"],
  installedAssets: InstalledBundleManifest["packages"],
  lastBatchAssetIds: string[]
): Promise<void> {
  const currentState =
    (await readJsonFileOrNull<InstallProgressState>(join(projectRoot, ...INSTALL_PROGRESS_STATE_OUTPUT_PATH))) ?? {
      schemaVersion: 1,
      updatedAt: new Date(0).toISOString(),
      bundles: {}
    }

  currentState.updatedAt = new Date().toISOString()
  currentState.bundles[bundleId] = {
    host,
    batchSize,
    totalAssets: allAssets.length,
    installedAssets: [...new Set(installedAssets.map((asset) => asset.assetId))].length,
    remainingAssets: Math.max(0, allAssets.length - [...new Set(installedAssets.map((asset) => asset.assetId))].length),
    lastBatchAssetIds: [...new Set(lastBatchAssetIds)]
  }

  await writeJsonFile(join(projectRoot, ...INSTALL_PROGRESS_STATE_OUTPUT_PATH), currentState)
}

async function reconcileInstallState(projectRoot: string): Promise<void> {
  const mirrorIndexEntries = await readJsonLinesFile<MirrorIndexEntry>(join(projectRoot, "mirror", "index.jsonl"))
  const mirrorIndexById = new Map(mirrorIndexEntries.map((entry) => [entry.mirrorId, entry]))
  const hosts: Array<BundleLock["host"]> = ["opencode", "copilot-vscode", "shared"]
  const reconciledState: InstallProgressState = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    bundles: {}
  }

  for (const host of hosts) {
    const bundlesRoot = join(projectRoot, "install", host, "bundles")
    if (!(await pathExists(bundlesRoot))) {
      continue
    }

    const bundleManifestPaths = (await listFilesRecursive(bundlesRoot)).filter((filePath) => filePath.endsWith(".install.json"))

    for (const bundleManifestPath of bundleManifestPaths) {
        const bundleManifest = await readJsonFile<InstalledBundleManifest>(bundleManifestPath)
        const bundleLockPath = join(projectRoot, "mirror", "bundles", `${bundleManifest.bundleId}.lock.json`)
        const bundleLock = (await readJsonFileOrNull<BundleLock>(bundleLockPath)) ?? {
        schemaVersion: 1,
        bundleId: bundleManifest.bundleId,
        generatedAt: new Date(0).toISOString(),
          host,
          assets: []
        }
      const installableAssets = getInstallableAssets(bundleLock.assets, mirrorIndexById)
      const currentBundleAssetIds = new Set(installableAssets.map((asset) => asset.assetId))
      const uniqueInstalledAssetIds = [
        ...new Set(
          bundleManifest.packages
            .map((pkg) => pkg.assetId)
            .filter((assetId) => currentBundleAssetIds.has(assetId))
        )
      ]

      reconciledState.bundles[bundleManifest.bundleId] = {
        host,
        batchSize: Math.min(250, uniqueInstalledAssetIds.length),
        totalAssets: installableAssets.length,
        installedAssets: uniqueInstalledAssetIds.length,
        remainingAssets: Math.max(0, installableAssets.length - uniqueInstalledAssetIds.length),
        lastBatchAssetIds: uniqueInstalledAssetIds.slice(-Math.min(50, uniqueInstalledAssetIds.length))
      }
    }
  }

  await ensureDirectory(join(projectRoot, "state", "install"))
  await writeJsonFile(join(projectRoot, ...INSTALL_PROGRESS_STATE_OUTPUT_PATH), reconciledState)
  await writeInstallGenerations(projectRoot, reconciledState)
  console.log(`Install progress reconciled at ${toPosixPath(join(projectRoot, ...INSTALL_PROGRESS_STATE_OUTPUT_PATH))}`)
}

async function resetInstallState(projectRoot: string): Promise<void> {
  await removePath(join(projectRoot, "install"))
  await removePath(join(projectRoot, "state", "install"))
  console.log(`Install state reset under ${toPosixPath(join(projectRoot, "install"))}`)
}

async function writeInstallGenerations(projectRoot: string, progressState: InstallProgressState): Promise<void> {
  const generationId = new Date().toISOString().replace(/[:.]/gu, "-")
  const hosts: Array<BundleLock["host"]> = ["opencode", "copilot-vscode", "shared"]

  for (const host of hosts) {
    const bundleIds = Object.entries(progressState.bundles)
      .filter(([, bundleState]) => bundleState.host === host)
      .map(([bundleId]) => bundleId)
      .sort((left, right) => left.localeCompare(right))

    const packageManifestPaths: string[] = []

    for (const bundleId of bundleIds) {
      const bundleManifestPath = join(projectRoot, "install", host, "bundles", `${bundleId}.install.json`)
      const bundleManifest = await readJsonFileOrNull<InstalledBundleManifest>(bundleManifestPath)
      if (!bundleManifest) {
        continue
      }

      const bundleLockPath = join(projectRoot, "mirror", "bundles", `${bundleId}.lock.json`)
      const bundleLock = await readJsonFileOrNull<BundleLock>(bundleLockPath)
      const currentBundleAssetIds = new Set((bundleLock?.assets ?? []).map((asset) => asset.assetId))

      for (const pkg of bundleManifest.packages) {
        if (currentBundleAssetIds.has(pkg.assetId)) {
          packageManifestPaths.push(pkg.manifestPath)
        }
      }
    }

    const generationManifest: InstallGenerationManifest = {
      schemaVersion: 1,
      generationId,
      host,
      generatedAt: new Date().toISOString(),
      bundleIds,
      packageManifestPaths: [...new Set(packageManifestPaths)].sort((left, right) => left.localeCompare(right))
    }

    await ensureDirectory(join(projectRoot, ...INSTALL_GENERATIONS_ROOT, host))
    await writeJsonFile(
      join(projectRoot, ...INSTALL_GENERATIONS_ROOT, host, `${generationId}.json`),
      generationManifest
    )
    await writeJsonFile(
      join(projectRoot, ...INSTALL_GENERATIONS_ROOT, host, "current.json"),
      generationManifest
    )
  }
}
