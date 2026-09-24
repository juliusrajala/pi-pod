// Pseudo-terminal fixture for token-input regressions. Tests run this under
// `script` so the child owns a real controlling terminal. It records only the
// token length and terminal state; token contents never leave this process.
import { writeFileSync } from "node:fs";
import { readApiToken } from "./token-input.ts";

const mode = Bun.env.PI_POD_TOKEN_MODE ?? "success";
const resultPath = Bun.env.PI_POD_TOKEN_RESULT;
if (resultPath === undefined) throw new Error("PI_POD_TOKEN_RESULT is required");

if (mode === "external") {
  // Signal delivery while input is pending: ready first, then terminate.
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 150);
}
writeFileSync(`${resultPath}.ready`, "");

try {
  const token = await readApiToken();
  writeFileSync(
    resultPath,
    JSON.stringify({ ok: true, length: token.length, rawAfter: process.stdin.isRaw === true }),
  );
} catch (error) {
  writeFileSync(
    resultPath,
    JSON.stringify({
      ok: false,
      rawAfter: process.stdin.isRaw === true,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
