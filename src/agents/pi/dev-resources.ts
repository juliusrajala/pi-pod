import { lstat, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
  readBoundedText,
  writePrivateFile,
} from "../../utils/fs.ts";

const maxSettingsBytes = 256 * 1024;
const containerResourceRoot = "/run/pi-pod-dev-resources";

export type DevResourceStage = {
  settingsFile: string;
  mounts: Array<{ source: string; destination: string }>;
  cleanup: () => Promise<void>;
};

/** Trusted global extension code is exposed to interactive Pi dev sessions only. */
export async function hostPiExtensionsDirectory(): Promise<string | undefined> {
  const path = join(hostPiAgentDirectory(), "extensions");
  const metadata = await lstat(path).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Host Pi extensions path must be a directory, not a symlink: ${path}`);
  }
  return realpath(path);
}

/**
 * Stage a filtered Pi settings file containing only local extension packages.
 * The packages themselves remain read-only host mounts; general settings,
 * sessions, skills, themes, and credentials never enter the container.
 */
export async function stageHostPiExtensionPackages(): Promise<DevResourceStage | undefined> {
  const settingsPath = join(hostPiAgentDirectory(), "settings.json");
  const settingsText = await readBoundedText(settingsPath, maxSettingsBytes).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (settingsText === undefined) return undefined;
  const settings = parseDevSettings(settingsText, hostPiAgentDirectory());
  if (settings.packages.length === 0 && Object.keys(settings.modelDefaults).length === 0)
    return undefined;

  const directory = join(
    await privateStateDirectory(),
    "dev-resource-staging",
    crypto.randomUUID(),
  );
  await ensurePrivateStateDirectory(directory);
  const settingsFile = join(directory, "settings.json");
  await writePrivateFile(
    settingsFile,
    `${JSON.stringify(
      {
        ...settings.modelDefaults,
        ...(settings.packages.length === 0
          ? {}
          : {
              packages: settings.packages.map((entry) => ({
                source: entry.destination,
                extensions: entry.extensions,
                skills: [],
                prompts: [],
                themes: [],
              })),
            }),
      },
      null,
      2,
    )}\n`,
  );
  let cleaned = false;
  return {
    settingsFile,
    mounts: settings.packages.map(({ source, destination }) => ({ source, destination })),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type LocalExtensionPackage = {
  source: string;
  destination: string;
  extensions: string[];
};

function parseDevSettings(
  text: string,
  baseDirectory: string,
): {
  packages: LocalExtensionPackage[];
  modelDefaults: Record<string, string>;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid host Pi settings.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new Error("Invalid host Pi settings.json: expected an object.");
  const modelDefaults = Object.fromEntries(
    ["defaultProvider", "defaultModel", "defaultThinkingLevel"].flatMap((key) =>
      typeof value[key] === "string" ? [[key, value[key]]] : [],
    ),
  );
  if (value.packages === undefined) return { packages: [], modelDefaults };
  if (!Array.isArray(value.packages))
    throw new Error("Invalid host Pi settings.json packages: expected an array.");
  const packages = value.packages.map((entry, index) => {
    const source =
      typeof entry === "string"
        ? entry
        : isRecord(entry) && typeof entry.source === "string"
          ? entry.source
          : undefined;
    if (source === undefined) throw new Error(`Invalid host Pi package at index ${index}.`);
    if (source.startsWith("npm:") || source.startsWith("git:") || /^[a-z]+:\/\//i.test(source)) {
      throw new Error(
        `Host Pi package ${source} is not a local path and cannot be staged for dev.`,
      );
    }
    const extensions =
      isRecord(entry) && entry.extensions !== undefined
        ? stringArray(entry.extensions, `extensions for host Pi package ${source}`)
        : ["**/*"];
    return {
      source: resolve(baseDirectory, source),
      destination: `${containerResourceRoot}/package-${index}`,
      extensions,
    };
  });
  return { packages, modelDefaults };
}

export async function assertDevResourceSource(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new Error(`Host Pi extension package is neither a file nor directory: ${path}`);
  }
}

function hostPiAgentDirectory(): string {
  return join(Bun.env.HOME?.trim() || homedir(), ".pi", "agent");
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${label}: expected an array of strings.`);
  }
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
