import assert from "node:assert/strict";
import test from "node:test";

import { getWireMode, runWire } from "../wire.js";

void test("wire mode parsing rejects positional mode tokens with flag guidance", () => {
  for (const mode of ["preview", "apply", "reset"] as const) {
    assert.throws(
      () => getWireMode([mode]),
      new RegExp(`Positional wire mode '${mode}'.*--${mode}`, "u"),
    );
  }
});

void test("wire mode parsing rejects arbitrary positional arguments with canonical choices", () => {
  assert.throws(
    () => getWireMode(["unexpected"]),
    /wire modes must be passed as '--preview', '--apply', or '--reset'/u,
  );
});

void test("wire mode parsing keeps canonical flag behavior", () => {
  assert.equal(getWireMode([]), "preview");
  assert.equal(getWireMode(["--preview"]), "preview");
  assert.equal(getWireMode(["--apply"]), "apply");
  assert.equal(getWireMode(["--reset"]), "reset");
});

void test("wire dispatch rejects positional apply before host preflight", async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]): void => {
    messages.push(values.map(String).join(" "));
  };

  try {
    const exitCode = await runWire(
      ["opencode", "apply"],
      process.cwd(),
      process.cwd(),
    );
    assert.equal(exitCode, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /use '--apply' instead/u);
  } finally {
    console.error = originalError;
  }
});
