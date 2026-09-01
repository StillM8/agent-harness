import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function validateVersionSync(packageDocument, lockDocument, tags) {
  const packageVersion = packageDocument?.version;
  const lockfileVersion = lockDocument?.version;
  const rootPackageVersion = lockDocument?.packages?.[""]?.version;
  const errors = [];

  if (!packageVersion) {
    errors.push("package.json is missing a version field.");
  }

  if (!lockfileVersion) {
    errors.push("package-lock.json is missing a top-level version field.");
  }

  if (!rootPackageVersion) {
    errors.push("package-lock.json is missing packages[''].version.");
  }

  if (packageVersion && lockfileVersion && packageVersion !== lockfileVersion) {
    errors.push(
      `package.json version (${packageVersion}) does not match package-lock.json version (${lockfileVersion}).`,
    );
  }

  if (
    packageVersion &&
    rootPackageVersion &&
    packageVersion !== rootPackageVersion
  ) {
    errors.push(
      `package.json version (${packageVersion}) does not match package-lock.json packages[''].version (${rootPackageVersion}).`,
    );
  }

  // Tag-vs-manifest guard (#467): the manifest version must correspond to a
  // released git tag (v<version>) that the human creates on main. When no
  // tags can be enumerated (shallow CI checkout, non-git cwd) the check is
  // skipped so PR and temporary-directory runs stay green; it is enforced
  // wherever the tag list is actually available (full clone, release check).
  if (Array.isArray(tags) && tags.length > 0) {
    if (packageVersion) {
      const hasMatchingTag = tags.some(
        (tag) => tag === `v${packageVersion}` || tag === packageVersion,
      );
      if (!hasMatchingTag) {
        errors.push(
          `package.json version (${packageVersion}) has no matching git tag (expected v${packageVersion}) on main.`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: packageVersion ?? lockfileVersion ?? rootPackageVersion ?? null,
    errors,
  };
}

export function readJsonFile(jsonPath) {
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}

/**
 * Enumerates the git tags reachable in the repository rooted at `cwd`.
 *
 * Returns an array of tag names when git is available and `cwd` is a git
 * repository, or `null` when the tag list cannot be determined (git missing,
 * non-repository directory, or a shallow checkout with no tags fetched).
 * Callers treat `null` as "cannot verify" and skip the tag-vs-manifest check.
 */
export function listGitTags(cwd) {
  try {
    const output = execFileSync("git", ["tag", "--list"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function main(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const packagePath = resolve(cwd, "package.json");
  const lockfilePath = resolve(cwd, "package-lock.json");
  const packageDocument = readJsonFile(packagePath);
  const lockDocument = readJsonFile(lockfilePath);
  const tags = options.tags ?? listGitTags(cwd);
  const result = validateVersionSync(packageDocument, lockDocument, tags);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return result;
  }

  console.log(
    `package.json and package-lock.json versions are synchronized at ${result.version}`,
  );
  return result;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main();
}
