import { expect, test } from "bun:test";
import { delegatedScopeArgs } from "./delegation.ts";

test("creates an interactive delegated scope that re-enters the trusted launcher", () => {
  const args = delegatedScopeArgs("/opt/pi-pod/scripts/dev-launcher", ["login", "--agent", "pi"]);

  expect(args).toContain("--user");
  expect(args).toContain("--scope");
  expect(args).not.toContain("--pipe");
  expect(args).toContain("--same-dir");
  expect(args).toContain("--property=Delegate=yes");
  expect(args).toContain("--setenv=PI_POD_DELEGATED_SCOPE=1");
  expect(args.slice(-4)).toEqual(["/opt/pi-pod/scripts/dev-launcher", "login", "--agent", "pi"]);
});
