import "server-only";
import { execFile, spawn } from "node:child_process";

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
