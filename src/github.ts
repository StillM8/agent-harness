import { join } from "node:path"

import { readJsonFileOrNull, writeJsonFile } from "./files.js"
import type { SourceDefinition } from "./types.js"

interface GitHubRepoResponse {
  name: string
  full_name: string
  description: string | null
  default_branch: string
  updated_at: string | null
  pushed_at: string | null
  stargazers_count: number
  language: string | null
  topics?: string[]
  archived: boolean
  html_url: string
}

interface GitHubTreeResponse {
  sha: string
  truncated: boolean
  tree?: Array<{
    path: string
    type: string
    size?: number
    sha: string
  }>
}

interface GitHubReadmeResponse {
  path: string
  sha: string
  size: number
  html_url: string | null
  download_url: string | null
}

export interface GitHubRepoSnapshot {
  owner: string
  repo: string
  sourceId: string
  fetchedAt: string
  repoSummary: {
    name: string
    fullName: string
    description: string | null
    defaultBranch: string
    updatedAt: string | null
    pushedAt: string | null
    stars: number
    language: string | null
    topics: string[]
    archived: boolean
    htmlUrl: string
  }
  readme: {
    path: string
    sha: string
    size: number
    htmlUrl: string | null
    downloadUrl: string | null
  } | null
  tree: {
    sha: string
    truncated: boolean
    entries: Array<{
      path: string
      type: string
      size: number | null
      sha: string
    }>
  }
}

const DEFAULT_GITHUB_API_VERSION = process.env.GITHUB_API_VERSION ?? "2022-11-28"
const GITHUB_API_BASE_URL = "https://api.github.com"
const GITHUB_REPO_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu
let githubRateLimitResetAt: number | null = null

export function isGitHubRepoSource(source: SourceDefinition): boolean {
  const repoUrl = source.endpoints.repo
  return source.kind === "repo" && typeof repoUrl === "string" && GITHUB_REPO_URL_PATTERN.test(repoUrl)
}

export function parseGitHubRepoCoordinates(repoUrl: string): {
  owner: string
  repo: string
} | null {
  const match = GITHUB_REPO_URL_PATTERN.exec(repoUrl)

  if (!match) {
    return null
  }

  return {
    owner: match[1],
    repo: match[2]
  }
}

export async function fetchGitHubRepoSnapshot(
  source: SourceDefinition,
  projectRoot: string
): Promise<GitHubRepoSnapshot | null> {
  const repoUrl = source.endpoints.repo
  if (!repoUrl) {
    return null
  }

  const coordinates = parseGitHubRepoCoordinates(repoUrl)
  if (!coordinates) {
    return null
  }

  const { owner, repo } = coordinates
  const cachePath = join(projectRoot, "state", "remote-cache", "github", `${owner}__${repo}.json`)

  if (isRateLimited()) {
    return readJsonFileOrNull<GitHubRepoSnapshot>(cachePath)
  }

  try {
    const repoResponse = await fetchGitHubJsonOptional<GitHubRepoResponse>(`/repos/${owner}/${repo}`)
    if (!repoResponse) {
      return null
    }
    const treeResponse = await fetchGitHubJson<GitHubTreeResponse>(
      `/repos/${owner}/${repo}/git/trees/${repoResponse.default_branch}?recursive=1`
    )
    const readmeResponse = await fetchGitHubJsonOptional<GitHubReadmeResponse>(`/repos/${owner}/${repo}/readme`)

    const snapshot: GitHubRepoSnapshot = {
      owner,
      repo,
      sourceId: source.id,
      fetchedAt: new Date().toISOString(),
      repoSummary: {
        name: repoResponse.name,
        fullName: repoResponse.full_name,
        description: repoResponse.description,
        defaultBranch: repoResponse.default_branch,
        updatedAt: repoResponse.updated_at,
        pushedAt: repoResponse.pushed_at,
        stars: repoResponse.stargazers_count,
        language: repoResponse.language,
        topics: repoResponse.topics ?? [],
        archived: repoResponse.archived,
        htmlUrl: repoResponse.html_url
      },
      readme: readmeResponse
        ? {
            path: readmeResponse.path,
            sha: readmeResponse.sha,
            size: readmeResponse.size,
            htmlUrl: readmeResponse.html_url,
            downloadUrl: readmeResponse.download_url
          }
        : null,
      tree: {
        sha: treeResponse.sha,
        truncated: treeResponse.truncated,
        entries: (treeResponse.tree ?? []).map((entry) => ({
          path: entry.path,
          type: entry.type,
          size: entry.size ?? null,
          sha: entry.sha
        }))
      }
    }

    await writeJsonFile(cachePath, snapshot)

    return snapshot
  } catch (error) {
    const cachedSnapshot = await readJsonFileOrNull<GitHubRepoSnapshot>(cachePath)
    if (cachedSnapshot) {
      return cachedSnapshot
    }

    throw error
  }
}

async function fetchGitHubJson<T>(path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers: buildGitHubHeaders()
  })

  if (!response.ok) {
    captureRateLimit(response)
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText}) for ${path}`)
  }

  return (await response.json()) as T
}

async function fetchGitHubJsonOptional<T>(path: string): Promise<T | null> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers: buildGitHubHeaders()
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    captureRateLimit(response)
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText}) for ${path}`)
  }

  return (await response.json()) as T
}

function buildGitHubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": DEFAULT_GITHUB_API_VERSION,
    "User-Agent": "agent-harness"
  }

  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`
  }

  return headers
}

function captureRateLimit(response: Response): void {
  const remainingHeader = response.headers.get("x-ratelimit-remaining")
  const resetHeader = response.headers.get("x-ratelimit-reset")

  if (remainingHeader === "0" && resetHeader) {
    const resetAtSeconds = Number(resetHeader)
    if (!Number.isNaN(resetAtSeconds)) {
      githubRateLimitResetAt = resetAtSeconds * 1000
    }
  }
}

function isRateLimited(): boolean {
  if (githubRateLimitResetAt === null) {
    return false
  }

  if (Date.now() >= githubRateLimitResetAt) {
    githubRateLimitResetAt = null
    return false
  }

  return true
}
