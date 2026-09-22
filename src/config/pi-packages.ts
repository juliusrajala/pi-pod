import { isAbsolute } from "node:path";
import { hasOnlyKeys, isBoundedNonemptyString, isRecord } from "./types.ts";

/** Explicit host-side selection. Only these files enter an interactive Pi session. */
export type PiDevPackage = {
  source: string;
  files: string[];
  extensions: string[];
};

export function parsePiPackages(value: unknown): PiDevPackage[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Pi dev packages must be an array of at most 32 local packages.");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["source", "files", "extensions"]) ||
      !isBoundedNonemptyString(entry.source, 4096) ||
      !isAbsolute(entry.source)
    ) {
      throw new Error("Each Pi dev package requires an absolute local source path.");
    }
    if (
      !Array.isArray(entry.files) ||
      entry.files.length > 128 ||
      !entry.files.includes("package.json") ||
      entry.files.some((path) => !isPackageFilePath(path))
    ) {
      throw new Error(
        "Pi package files must include package.json and use literal relative paths without traversal.",
      );
    }
    const extensions = entry.extensions ?? ["**/*"];
    if (
      !Array.isArray(extensions) ||
      extensions.length > 128 ||
      extensions.some((item) => !isBoundedNonemptyString(item, 4096))
    ) {
      throw new Error("Pi package extensions must be an array of filter strings.");
    }
    return { source: entry.source, files: [...entry.files], extensions: [...extensions] };
  });
}

function isPackageFilePath(value: unknown): value is string {
  return (
    isBoundedNonemptyString(value, 4096) &&
    !isAbsolute(value) &&
    !/[\\*?\[\]\x00]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
