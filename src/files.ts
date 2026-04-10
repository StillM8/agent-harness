import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, relative, sep } from "node:path"
import { createHash } from "node:crypto"

export const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".tmp",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor"
])

export function resolveProjectRoot(scriptFilePath: string): string {
  const scriptDirectory = dirname(scriptFilePath)
  const directoryName = basename(scriptDirectory)

  if (directoryName === "dist" || directoryName === "src") {
    return dirname(scriptDirectory)
  }

  return scriptDirectory
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true })
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8")
  return JSON.parse(content) as T
}

export async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  if (!(await pathExists(filePath))) {
    return null
  }

  return readJsonFile<T>(filePath)
}

export async function readTextFileOrNull(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) {
    return null
  }

  return readFile(filePath, "utf8")
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(filePath))
  const json = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(filePath, json, "utf8")
}

export async function writeTextFile(filePath: string, value: string): Promise<void> {
  await ensureDirectory(dirname(filePath))
  await writeFile(filePath, value, "utf8")
}

export async function readJsonLinesFile<T>(filePath: string): Promise<T[]> {
  const content = await readTextFileOrNull(filePath)

  if (!content) {
    return []
  }

  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

export async function writeJsonLinesFile(filePath: string, values: unknown[]): Promise<void> {
  const serializedContent = values.map((value) => JSON.stringify(value)).join("\n")
  await writeTextFile(filePath, serializedContent.length > 0 ? `${serializedContent}\n` : "")
}

export async function copyPath(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDirectory(dirname(destinationPath))
  await cp(sourcePath, destinationPath, { recursive: true, force: true })
}

export async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true })
}

export async function ensureCleanDirectory(directoryPath: string): Promise<void> {
  await removePath(directoryPath)
  await ensureDirectory(directoryPath)
}

export function createContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function upsertManagedSection(options: {
  originalContent: string
  markerId: string
  bodyLines: string[]
}): string {
  const { originalContent, markerId, bodyLines } = options
  const beginMarker = `<!-- ${markerId}:begin -->`
  const endMarker = `<!-- ${markerId}:end -->`
  const sectionContent = [beginMarker, ...bodyLines, endMarker].join("\n")
  const sectionPattern = new RegExp(`${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, "u")

  if (sectionPattern.test(originalContent)) {
    return originalContent.replace(sectionPattern, sectionContent)
  }

  const trimmedOriginalContent = originalContent.trimEnd()
  return trimmedOriginalContent.length > 0
    ? `${trimmedOriginalContent}\n\n${sectionContent}\n`
    : `${sectionContent}\n`
}

export function removeManagedSection(options: {
  originalContent: string
  markerId: string
}): string {
  const { originalContent, markerId } = options
  const beginMarker = `<!-- ${markerId}:begin -->`
  const endMarker = `<!-- ${markerId}:end -->`
  const sectionPattern = new RegExp(`\n?${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\n?`, "u")
  return originalContent.replace(sectionPattern, "\n").trimEnd() + "\n"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

export function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/")
}

export function toRelativePosixPath(rootPath: string, filePath: string): string {
  return toPosixPath(relative(rootPath, filePath))
}

export function countNonEmptyLines(content: string): number {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length
}

export async function listFilesRecursive(
  rootPath: string,
  ignoredDirectoryNames: ReadonlySet<string> = DEFAULT_IGNORED_DIRECTORY_NAMES
): Promise<string[]> {
  return collectFilesFromDirectory(rootPath, ignoredDirectoryNames)
}

async function collectFilesFromDirectory(
  directoryPath: string,
  ignoredDirectoryNames: ReadonlySet<string>
): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true })
  const collectedFiles: string[] = []

  for (const entry of entries) {
    const entryPath = `${directoryPath}${sep}${entry.name}`

    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) {
        continue
      }

      const nestedFiles = await collectFilesFromDirectory(entryPath, ignoredDirectoryNames)
      collectedFiles.push(...nestedFiles)
      continue
    }

    if (entry.isFile()) {
      collectedFiles.push(entryPath)
    }
  }

  return collectedFiles
}
