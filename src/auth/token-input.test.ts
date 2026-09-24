import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readApiToken,
  readApiTokenFrom,
  type TerminalSignal,
  type TerminalSignalOwner,
  type TerminalStdin,
} from "./token-input.ts";

class FakeStdin implements TerminalStdin {
  isTTY = true;
  isRaw = false;
  private raw = false;
  constructor(
    private readonly chunks: Array<string | Uint8Array>,
    private readonly pending?: Promise<void>,
  ) {}
  setRawMode(mode: boolean): void {
    this.raw = mode;
    this.isRaw = mode;
  }
  resume(): void {}
  pause(): void {}
  isRawEnabled(): boolean {
    return this.raw;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
    if (this.pending !== undefined) await this.pending;
    for (const chunk of this.chunks) yield chunk;
  }
}

class FakeSignals implements TerminalSignalOwner {
  private readonly listeners = new Map<TerminalSignal, Array<() => void>>();
  readonly raised: Array<{ signal: TerminalSignal; rawAtRaise: boolean }> = [];
  constructor(private readonly stdin: FakeStdin) {}
  addListener(signal: TerminalSignal, listener: () => void): void {
    const existing = this.listeners.get(signal) ?? [];
    existing.push(listener);
    this.listeners.set(signal, existing);
  }
  removeListener(signal: TerminalSignal, listener: () => void): void {
    const existing = this.listeners.get(signal);
    if (existing === undefined) return;
    this.listeners.set(
      signal,
      existing.filter((entry) => entry !== listener),
    );
  }
  raise(signal: TerminalSignal): void {
    this.raised.push({ signal, rawAtRaise: this.stdin.isRawEnabled() });
  }
  deliver(signal: TerminalSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }
  remaining(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.length, 0);
  }
}

class FakeStderr {
  readonly text: string[] = [];
  write(value: string): void {
    this.text.push(value);
  }
}

test("token input returns a terminal token with the prompt and raw mode restored", async () => {
  const stdin = new FakeStdin(["fake-token\n"]);
  const stderr = new FakeStderr();
  const signals = new FakeSignals(stdin);

  const token = await readApiTokenFrom(stdin, stderr, signals, "API token: ");

  expect(token).toBe("fake-token");
  expect(stderr.text).toEqual(["API token: ", "\n"]);
  expect(stdin.isRawEnabled()).toBe(false);
  expect(signals.remaining()).toBe(0);
});

test("token input refuses a non-terminal stdin before changing terminal mode", async () => {
  const stdin = new FakeStdin(["x\n"]);
  stdin.isTTY = false;
  const signals = new FakeSignals(stdin);

  await expect(readApiTokenFrom(stdin, new FakeStderr(), signals)).rejects.toThrow(
    "interactive controlling terminal",
  );
  expect(stdin.isRawEnabled()).toBe(false);
});

test("token input rejects an empty token and restores the terminal", async () => {
  const stdin = new FakeStdin(["\n"]);
  const signals = new FakeSignals(stdin);

  await expect(readApiTokenFrom(stdin, new FakeStderr(), signals)).rejects.toThrow(
    "API token must not be empty.",
  );
  expect(stdin.isRawEnabled()).toBe(false);
});

test("token input reports ended input without a token and restores the terminal", async () => {
  const stdin = new FakeStdin([]);
  const signals = new FakeSignals(stdin);

  await expect(readApiTokenFrom(stdin, new FakeStderr(), signals)).rejects.toThrow(
    "Token input ended before a token was provided.",
  );
  expect(stdin.isRawEnabled()).toBe(false);
});

test("token input enforces its size bound mid-stream and restores the terminal", async () => {
  const stdin = new FakeStdin([new Uint8Array(20 * 1024).fill(97), "\n"]);
  const signals = new FakeSignals(stdin);

  await expect(readApiTokenFrom(stdin, new FakeStderr(), signals)).rejects.toThrow(
    "API token exceeds 16384 bytes.",
  );
  expect(stdin.isRawEnabled()).toBe(false);
});

test("raw-mode Ctrl-C aborts token input and restores the terminal", async () => {
  const stdin = new FakeStdin(["fake\x03"]);
  const signals = new FakeSignals(stdin);

  await expect(readApiTokenFrom(stdin, new FakeStderr(), signals)).rejects.toThrow(
    "Token input aborted.",
  );
  expect(stdin.isRawEnabled()).toBe(false);
  expect(signals.remaining()).toBe(0);
});

test("an external termination signal restores raw mode before the re-raise", async () => {
  let releaseInput: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  const stdin = new FakeStdin([], pending);
  const signals = new FakeSignals(stdin);
  const reading = readApiTokenFrom(stdin, new FakeStderr(), signals);

  // Input is pending in raw mode when the signal arrives.
  await Bun.sleep(20);
  expect(stdin.isRawEnabled()).toBe(true);
  signals.deliver("SIGTERM");

  expect(signals.raised).toEqual([{ signal: "SIGTERM", rawAtRaise: false }]);
  releaseInput();
  // Production terminates at the re-raise; the fake continues to the end of
  // input, which still must clean up listeners and restore the terminal.
  await expect(reading).rejects.toThrow("Token input ended before a token was provided.");
  expect(signals.remaining()).toBe(0);
  expect(stdin.isRawEnabled()).toBe(false);
});

test("readApiToken refuses a non-terminal process stdin", async () => {
  if (process.stdin.isTTY) return;
  await expect(readApiToken()).rejects.toThrow("interactive controlling terminal");
});

const ptyAvailable = Bun.which("script") !== null && process.platform === "linux";

test.if(ptyAvailable)(
  "a real terminal returns the token with raw mode restored and no echo of contents",
  async () => {
    const result = await runUnderPty("success", "fake-pty-token\n");
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ ok: true, length: 14, rawAfter: false });
    expect(result.output).not.toContain("fake-pty-token");
  },
  30_000,
);

test.if(ptyAvailable)(
  "a real terminal aborts on raw-mode Ctrl-C with the terminal restored",
  async () => {
    const result = await runUnderPty("abort", "ab\x03");
    expect(result.exitCode).toBe(1);
    expect(result.json?.ok).toBe(false);
    expect(result.json?.error).toBe("Token input aborted.");
    expect(result.json?.rawAfter).toBe(false);
  },
  30_000,
);

test.if(ptyAvailable)(
  "a real terminal dies by the delivered SIGTERM while input is pending",
  async () => {
    const result = await runUnderPty("external", "");
    // The re-raise terminates the helper before it can record a result; the
    // restore-before-raise ordering is proven by the fake-signal unit test.
    expect(result.json).toBe(null);
    expect(result.exitCode).not.toBe(0);
  },
  30_000,
);

async function runUnderPty(
  mode: string,
  input: string,
): Promise<{ exitCode: number; json: any; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-token-pty-"));
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const resultPath = join(root, "result.json");
    const helper = resolve(import.meta.dir, "token-input.pty.helper.ts");
    proc = Bun.spawn(["script", "-qec", `"${process.execPath}" "${helper}"`, "/dev/null"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, PI_POD_TOKEN_MODE: mode, PI_POD_TOKEN_RESULT: resultPath },
    });
    if (input.length > 0) {
      // The helper signals readiness immediately before raw mode starts; raw
      // mode also disables pty echo so the token is never written back.
      await waitFor(`${resultPath}.ready`, 10_000);
      await Bun.sleep(100);
      const stdin = proc.stdin as Bun.FileSink;
      stdin.write(input);
      stdin.flush();
    }
    const exit = await Promise.race([
      proc.exited.then((code) => code as number | null),
      Bun.sleep(15_000).then(() => null as number | null),
    ]);
    if (exit === null) throw new Error(`pty helper for mode "${mode}" timed out`);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    let json: any = null;
    try {
      json = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      json = null;
    }
    return { exitCode: exit, json, output: `${stdout}\n${stderr}` };
  } finally {
    proc?.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}
