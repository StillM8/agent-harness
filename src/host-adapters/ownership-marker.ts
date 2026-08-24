import { join } from "node:path";

import { readJsonFileOrNull, writeJsonFile } from "../files.js";

const OWNERSHIP_MARKER_FILE = ".agent-harness-managed.json";
const OWNERSHIP_MARKER_VERSION = 1;

/** Writes an ownership marker inside a generated host plugin directory. */
export async function writeManagedPluginMarker(
  pluginRoot: string,
  pluginName: string,
): Promise<void> {
  await writeJsonFile(join(pluginRoot, OWNERSHIP_MARKER_FILE), {
    managedBy: "agent-harness",
    markerVersion: OWNERSHIP_MARKER_VERSION,
    pluginName,
  });
}

/** Returns true only for a plugin directory explicitly marked by this adapter. */
export async function hasManagedPluginMarker(
  pluginRoot: string,
  pluginName: string,
): Promise<boolean> {
  const marker = await readJsonFileOrNull<unknown>(
    join(pluginRoot, OWNERSHIP_MARKER_FILE),
  );
  return (
    isRecord(marker) &&
    marker.managedBy === "agent-harness" &&
    marker.markerVersion === OWNERSHIP_MARKER_VERSION &&
    marker.pluginName === pluginName
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
