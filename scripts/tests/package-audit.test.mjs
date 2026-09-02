import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  REQUIRED_PACKED_FILES,
  buildNpmInvocation,
  resolveNpmCliPath,
  resolvePackageAuditAction,
  runPackageAudit,
  runPackedPackageSmoke,
  toPackageAuditErrorMessage,
  toPackRecordList,
} from "../package-audit.mjs";

const execFileAsync = promisify(execFile);

const posixJoin = (...parts) =>
  join(...parts)
    .split("\\")
    .join("/");

// The fixture represents a compliant package; derive it from the audit's
// pinned required set so the two can never drift apart again.
const REQUIRED_FILES = REQUIRED_PACKED_FILES;

test("package audit accepts expected runtime and documentation files", async () => {
  const cwd = await createFixturePackage(REQUIRED_FILES);

  const summary = await runPackageAudit({ cwd });

  assert.equal(summary.package, "@example/package-audit-fixture");
  assert.equal(summary.version, "1.2.3");
  assert.ok(summary.fileCount >= REQUIRED_FILES.length);
});

test("packed package smoke installs fixture tarball and cleans it up", async () => {
  const cwd = await createFixturePackage(REQUIRED_FILES, {
    name: "@ar27111994/agent-harness",
  });

  await writeFile(
    join(cwd, "dist", "cli.js"),
    [
      "#!/usr/bin/env node",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const stateRoot = process.argv[process.argv.indexOf('--state-root') + 1];",
      "mkdirSync(stateRoot, { recursive: true });",
      "writeFileSync(join(stateRoot, 'setup-hosts-smoke.json'), JSON.stringify({ ok: true }) + '\\n');",
    ].join("\n"),
    "utf8",
  );

  await runPackedPackageSmoke({ cwd });

  await assert.rejects(
    () =>
      rm(resolve(cwd, "ar27111994-agent-harness-1.2.3.tgz"), {
        force: false,
      }),
    { code: "ENOENT" },
  );
});

test("package audit builds deterministic npm invocations", () => {
  assert.deepEqual(
    buildNpmInvocation(["pack"], {
      npmExecPath: "/tmp/npm-cli.js",
      nodeExecPath: "/tmp/node",
      platform: "linux",
    }),
    {
      command: "/tmp/node",
      commandArgs: ["/tmp/npm-cli.js", "pack"],
      shell: false,
    },
  );
  // win32 also routes through node+npm-cli (NEVER a shell — DEP0190 doctrine).
  assert.deepEqual(
    buildNpmInvocation(["pack"], {
      npmExecPath: "C:/tools/npm-cli.js",
      nodeExecPath: "C:/node/node.exe",
      platform: "win32",
    }),
    {
      command: "C:/node/node.exe",
      commandArgs: ["C:/tools/npm-cli.js", "pack"],
      shell: false,
    },
  );
  // Without an explicit npm-cli, the bare `npm` launcher is shell-less; it is
  // valid on POSIX (shebang), and on win32 resolveNpmCliPath provides a JS CLI.
  const resolvedNpmInvocation = buildNpmInvocation(["pack"], {
    npmExecPath: "",
    npmConfigPrefix: "/prefix",
    nodeExecPath: "/node",
    platform: "win32",
  });
  assert.deepEqual(resolvedNpmInvocation, {
    command: "/node",
    commandArgs: ["/prefix/node_modules/npm/bin/npm-cli.js", "pack"],
    shell: false,
  });
  assert.equal(resolvePackageAuditAction("smoke"), runPackedPackageSmoke);
  assert.equal(resolvePackageAuditAction("audit"), runPackageAudit);
  assert.equal(toPackageAuditErrorMessage(new Error("boom")), "boom");
  assert.equal(toPackageAuditErrorMessage("plain"), "plain");
});

test("toPackRecordList normalizes npm array, object, null, and scalar pack payloads", () => {
  const arrayRecord = { files: [] };
  assert.equal(toPackRecordList([arrayRecord])[0], arrayRecord);
  assert.equal(toPackRecordList({ "@scope/pkg": arrayRecord })[0], arrayRecord);
  assert.deepEqual(toPackRecordList(null), []);
  assert.deepEqual(toPackRecordList(undefined), []);
  assert.deepEqual(toPackRecordList("scalar"), []);
  assert.equal(toPackRecordList([arrayRecord, { files: [] }]).length, 2);
});

test("resolveNpmCliPath prefers explicit, then env prefix, then node-bundled npm", () => {
  const before = {
    npmExecPath: process.env.npm_execpath,
    npmConfigPrefix: process.env.npm_config_prefix,
  };
  try {
    process.env.npm_config_prefix = "/custom/prefix";
    assert.equal(
      resolveNpmCliPath({ npmExecPath: "/explicit/cli.js" }),
      "/explicit/cli.js",
    );
    delete process.env.npm_execpath;
    assert.equal(
      resolveNpmCliPath({
        npmConfigPrefix: "/custom/prefix",
      }),
      "/custom/prefix/node_modules/npm/bin/npm-cli.js",
    );
    // Falls back to the node install's bundled npm when nothing is configured.
    process.env.npm_config_prefix = "";
    assert.equal(
      resolveNpmCliPath({}),
      posixJoin(
        dirname(process.execPath).replaceAll("\\", "/"),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    );
    // An empty npmExecPath means "no explicit path" — it falls through to the
    // prefix resolution, exactly as buildNpmInvocation relies on.
    assert.equal(
      resolveNpmCliPath({ npmExecPath: "", npmConfigPrefix: "/fallback" }),
      "/fallback/node_modules/npm/bin/npm-cli.js",
    );
  } finally {
    if (before.npmExecPath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = before.npmExecPath;
    }
    if (before.npmConfigPrefix === undefined) {
      delete process.env.npm_config_prefix;
    } else {
      process.env.npm_config_prefix = before.npmConfigPrefix;
    }
  }
});

test("package audit rejects malformed npm pack payloads", async () => {
  const cwd = await createFixturePackage(REQUIRED_FILES);
  const fakeNpm = join(cwd, "fake-npm.mjs");
  const previousNpmExecPath = process.env.npm_execpath;
  await writeFile(fakeNpm, "console.log('[]');\n", "utf8");
  process.env.npm_execpath = fakeNpm;

  try {
    await assert.rejects(
      () => runPackageAudit({ cwd }),
      /npm pack --dry-run did not return a package file list/u,
    );
    await assert.rejects(
      () => runPackedPackageSmoke({ cwd }),
      /npm pack did not report a tarball filename/u,
    );
  } finally {
    if (previousNpmExecPath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = previousNpmExecPath;
    }
  }
});

test("package audit direct execution reports failures", async () => {
  const cwd = await createFixturePackage(
    REQUIRED_FILES.filter((file) => file !== "docs/guides/TRUST-CENTER.md"),
  );

  const result = await execFileAsync(
    process.execPath,
    [join(import.meta.dirname, "..", "package-audit.mjs")],
    { cwd, encoding: "utf8" },
  ).catch((error) => error);

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Missing required files: docs\/guides\/TRUST-CENTER\.md/u,
  );
});

test("package audit rejects missing v2 trust docs", async () => {
  const cwd = await createFixturePackage(
    REQUIRED_FILES.filter((file) => file !== "docs/guides/TRUST-CENTER.md"),
  );

  await assert.rejects(
    () => runPackageAudit({ cwd }),
    /Missing required files: docs\/guides\/TRUST-CENTER\.md/u,
  );
});

test("package audit rejects forbidden generated state and assistant metadata", async () => {
  const cwd = await createFixturePackage([
    ...REQUIRED_FILES,
    ".agent-harness/state.json",
    ".openclaw/workspace-state.json",
    "SOUL.md",
  ]);

  await assert.rejects(
    () => runPackageAudit({ cwd }),
    /Forbidden files: \.agent-harness\/state\.json, \.openclaw\/workspace-state\.json, SOUL\.md/u,
  );
});

async function createFixturePackage(files, packageOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-harness-package-audit-"));
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: packageOptions.name ?? "@example/package-audit-fixture",
        version: "1.2.3",
        type: "module",
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const file of files) {
    const filePath = join(cwd, ...file.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      file.endsWith(".json") ? "{}\n" : `${file}\n`,
      "utf8",
    );
  }

  return cwd;
}
