import "server-only";
import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Production invokes only a root-owned, sandbox-validating sudo broker. */
export function dockerInvocation(argv: string[], production = process.env.NODE_ENV === "production"): { command: string; args: string[] } {
  return production
    ? { command: "sudo", args: ["-n", "/usr/local/sbin/juno-computer-docker-broker", ...argv] }
    : { command: "docker", args: argv };
}

export function runDockerBuffer(
  argv: string[],
  options?: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    maxBuffer?: number;
  }
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const invocation = dockerInvocation(argv);
    execFile(
      invocation.command,
      invocation.args,
      {
        encoding: "buffer",
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        timeout: options?.timeoutMs ?? 30_000,
        maxBuffer: options?.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout: stdout ?? Buffer.alloc(0),
            stderr: stderr ?? Buffer.alloc(0),
            exitCode: 0,
            timedOut: false,
          });
          return;
        }
        const errObj = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        const numericCode: number =
          typeof errObj.code === "number" ? errObj.code : errObj.killed ? 124 : 1;
        const timedOut =
          Boolean(errObj.killed) ||
          errObj.signal === "SIGTERM" ||
          numericCode === 124 ||
          numericCode === 137;
        resolve({
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr ?? Buffer.from(errObj.message ?? "docker error", "utf8"),
          exitCode: numericCode,
          timedOut,
        });
      }
    );
  });
}

export function spawnDockerWithStdin(
  argv: string[],
  input: Buffer,
  timeoutMs = 15_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const invocation = dockerInvocation(argv);
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`docker ${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`docker ${argv[0]} exited with ${code}: ${msg}`));
      }
    });
    child.stdin.end(input);
  });
}

/**
 * `docker` with its output handed over as it arrives (COMPUTERS_2026-10.md
 * S5.1): the same argv `runDockerBuffer` would run, through `spawn`, so the
 * broker sees nothing new. Each stream is decoded as UTF-8 across chunk
 * boundaries (a character split between two reads is never mangled) and
 * passed to `onChunk`; the result keeps the first `maxBuffer` bytes of each
 * stream and reads and drops the rest, as the computer host does, rather than
 * killing the command the way `execFile` does past its buffer. The timeout
 * sends SIGTERM, then SIGKILL 5 s later.
 */
export function spawnDockerStreaming(
  argv: string[],
  onChunk: (chunk: { stream: "stdout" | "stderr"; text: string }) => void,
  options?: { timeoutMs?: number; maxBuffer?: number }
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const invocation = dockerInvocation(argv);
    const maxBuffer = options?.maxBuffer ?? 16 * 1024 * 1024;
    const kept: Record<"stdout" | "stderr", { chunks: Buffer[]; size: number }> = {
      stdout: { chunks: [], size: 0 },
      stderr: { chunks: [], size: 0 },
    };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const deliver = (stream: "stdout" | "stderr", text: string) => {
      if (!text || settled) return;
      try {
        onChunk({ stream, text });
      } catch {
        // Watching a command never fails it.
      }
    };
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options?.timeoutMs ?? 30_000);
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const bucket = kept[stream];
      if (bucket.size < maxBuffer) {
        const room = maxBuffer - bucket.size;
        const piece = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        bucket.chunks.push(piece);
        bucket.size += piece.byteLength;
      }
      deliver(stream, decoders[stream].write(chunk));
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const finish = (exitCode: number, extraStderr?: string) => {
      if (settled) return;
      deliver("stdout", decoders.stdout.end());
      deliver("stderr", decoders.stderr.end());
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stderr = Buffer.concat(kept.stderr.chunks, kept.stderr.size);
      resolve({
        stdout: Buffer.concat(kept.stdout.chunks, kept.stdout.size),
        stderr: extraStderr && stderr.byteLength === 0 ? Buffer.from(extraStderr, "utf8") : stderr,
        exitCode,
        timedOut: timedOut || exitCode === 124 || exitCode === 137,
      });
    };
    child.on("error", (err) => finish(1, err.message || "docker error"));
    child.on("close", (code) => finish(typeof code === "number" ? code : timedOut ? 124 : 1));
  });
}
