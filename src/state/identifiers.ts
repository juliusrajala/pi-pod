import { relative } from "node:path";

/** Validate an identifier used as a wrapper-owned state path component. */
export function validIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must contain 1-64 letters, numbers, dots, underscores, or dashes.`);
  }
  return value;
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

export function assertSafeMountPath(path: string): void {
  if (path.includes(",")) {
    throw new Error("Paths containing commas are not supported by Podman's --mount syntax.");
  }
}
