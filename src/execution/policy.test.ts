import { expect, test } from "bun:test";
import { resolveRunPolicy } from "./policy.ts";

test("headless library policy requires an explicit profile", () => {
  expect(() =>
    resolveRunPolicy({
      mode: "headless",
      workspace: "/workspace",
      auth: { type: "host" },
    } as never),
  ).toThrow("require an explicit API-token profile");
  expect(
    resolveRunPolicy({
      mode: "headless",
      workspace: "/workspace",
      auth: { type: "profile", name: "worker" },
    }).credentialSource,
  ).toEqual({ source: "profile", profileName: "worker" });
});

test("interactive library policy accepts an explicit host source", () => {
  expect(
    resolveRunPolicy({ mode: "interactive", workspace: "/workspace", auth: { type: "host" } })
      .credentialSource,
  ).toEqual({ source: "host" });
});
