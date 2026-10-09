/**
 * Installs Google's official Antigravity ACP runtime for the user, the way T3
 * Code does (AntigravityInstallation, MIT; re-implemented without Effect):
 *
 *   <dataDir>/runtimes/antigravity-acp/<platform>-<arch>/
 *     versions/<sha256>/agy_acp_server.par + localharness_external + .install-complete.json
 *     active.json   {"releaseId": "<sha256>"}  (written last; it commits the install)
 *
 * The archive comes from Google's CDN at the URL the ACP registry lists and is
 * refused unless its decoded size and SHA-256 match the pinned release
 * (release.ts). It must hold exactly the two expected files, no directories,
 * no links, no encryption, each at its pinned size. The extracted runtime is
 * then started once and must identify itself as Google's antigravity-acp
 * (initialize only) before it is activated. A failed or cancelled install
 * leaves the previous runtime untouched.
 *
 * A runtime the user installed by hand is used too: an executable named
 * agy_acp_server(.par) or antigravity-acp on PATH (or an explicit binaryPath)
 * with `localharness_external` next to its real path.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProviderInstallState } from "../../contracts/code-v2.js";
import { candidateDirs, isExecutable } from "../detect.js";
import { describeError, newId } from "../../util.js";
import { ANTIGRAVITY_EXECUTABLE, ANTIGRAVITY_HARNESS, antigravityReleaseFor, type AntigravityReleaseAsset } from "./release.js";
import { extractZipEntry, readZipEntries } from "./zip.js";

export interface AntigravityExecutable {
  executablePath: string;
  harnessPath: string;
  source: "override" | "managed" | "path";
  version?: string;
}

export interface InstallerOptions {
  dataDir: string;
  /** null: no release for this platform. Default: the pinned release for this Mac. */
  release?: AntigravityReleaseAsset | null;
  /** Starts the extracted runtime and checks it is the expected release (initialize only). */
  validate: (executable: AntigravityExecutable, expectedVersion: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Directories searched for a hand-installed runtime. */
  searchDirs?: () => string[];
  onChange?: (state: ProviderInstallState) => void;
  downloadTimeoutMs?: number;
}

const RECORD = ".install-complete.json";
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const PATH_NAMES = ["antigravity-acp", ANTIGRAVITY_EXECUTABLE, "agy_acp_server", "agy-acp-server"];

export class InstallError extends Error {}

export class AntigravityInstaller {
  readonly managedDirectory: string;
  readonly #versions: string;
  readonly #active: string;
  readonly #release: AntigravityReleaseAsset | null;
  #state: ProviderInstallState;
  #running: { operationId: string; abort: AbortController; done: Promise<void> } | undefined;
  /** Runtimes in use (sessions, sign-in): removal is refused while any is held. */
  #leases = 0;

  constructor(private readonly options: InstallerOptions) {
    this.#release = options.release === undefined ? antigravityReleaseFor() : options.release;
    this.managedDirectory = path.join(options.dataDir, "runtimes", "antigravity-acp", `${process.platform}-${process.arch}`);
    this.#versions = path.join(this.managedDirectory, "versions");
    this.#active = path.join(this.managedDirectory, "active.json");
    this.#state = { phase: "idle", ...(this.#release ? { version: this.#release.version, totalBytes: this.#release.archiveBytes } : {}) };
    try {
      const installed = this.#managed();
      if (installed?.version) this.#state.installedVersion = installed.version;
    } catch (error) {
      this.#state = { ...this.#state, phase: "failed", message: describeError(error) };
    }
  }

  get state(): ProviderInstallState {
    return { ...this.#state };
  }

  get release(): AntigravityReleaseAsset | null {
    return this.#release;
  }

  #set(patch: Partial<ProviderInstallState>): void {
    this.#state = { ...this.#state, ...patch };
    if (patch.message === undefined && "message" in patch) delete this.#state.message;
    this.options.onChange?.(this.state);
  }

  /** The runtime to launch, or an InstallError saying what is missing. */
  resolve(binaryPath?: string): AntigravityExecutable {
    const override = binaryPath?.trim();
    if (override) {
      const found = this.#external(override, "override");
      if (found) return found;
      throw new InstallError("The Antigravity runtime at the custom path, or the localharness_external next to it, is missing or not executable.");
    }
    const managed = this.#managed();
    if (managed) return managed;
    const dirs = this.options.searchDirs?.() ?? candidateDirs();
    for (const dir of dirs) {
      for (const name of PATH_NAMES) {
        const found = this.#external(path.join(dir, name), "path");
        if (found) return found;
      }
    }
    throw new InstallError(
      this.#release
        ? "Antigravity is not installed. Install it from Connections."
        : `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}.`,
    );
  }

  /** Holds the runtime for a running process; call the returned function when it exits. */
  acquire(binaryPath?: string): { executable: AntigravityExecutable; release: () => void } {
    const executable = this.resolve(binaryPath);
    this.#leases++;
    let released = false;
    return {
      executable,
      release: () => {
        if (released) return;
        released = true;
        this.#leases--;
      },
    };
  }

  #external(candidate: string, source: "override" | "path"): AntigravityExecutable | undefined {
    if (!isExecutable(candidate)) return undefined;
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return undefined;
    }
    const harnessPath = path.join(path.dirname(real), ANTIGRAVITY_HARNESS);
    if (!isExecutable(harnessPath)) return undefined;
    return { executablePath: real, harnessPath, source };
  }

  #managed(): AntigravityExecutable | undefined {
    let raw: string;
    try {
      const st = fs.statSync(this.#active);
      if (!st.isFile() || st.size > 8192) throw new InstallError("The Antigravity install record is invalid. Remove it and install again.");
      raw = fs.readFileSync(this.#active, "utf8");
    } catch (error) {
      if (error instanceof InstallError) throw error;
      return undefined;
    }
    const active = safeJson(raw) as { releaseId?: unknown } | undefined;
    if (typeof active?.releaseId !== "string" || !/^[a-f0-9]{64}$/.test(active.releaseId)) {
      throw new InstallError("The Antigravity install record is invalid. Remove it and install again.");
    }
    return this.#completed(active.releaseId);
  }

  #completed(releaseId: string): AntigravityExecutable {
    const dir = path.join(this.#versions, releaseId);
    const record = safeJson(readSmall(path.join(dir, RECORD))) as
      | { releaseId?: string; version?: string; executable?: { name?: string; bytes?: number }; harness?: { name?: string; bytes?: number } }
      | undefined;
    const exe = path.join(dir, ANTIGRAVITY_EXECUTABLE);
    const harness = path.join(dir, ANTIGRAVITY_HARNESS);
    if (
      !record ||
      record.releaseId !== releaseId ||
      record.executable?.name !== ANTIGRAVITY_EXECUTABLE ||
      record.harness?.name !== ANTIGRAVITY_HARNESS ||
      typeof record.version !== "string" ||
      !sizeIs(exe, record.executable?.bytes) ||
      !sizeIs(harness, record.harness?.bytes) ||
      !isExecutable(exe) ||
      !isExecutable(harness)
    ) {
      throw new InstallError("The installed Antigravity runtime is incomplete. Remove it and install again.");
    }
    return { executablePath: exe, harnessPath: harness, source: "managed", version: record.version };
  }

  /** Starts a download; returns at once with the new state. A second start while one runs returns that one. */
  start(): ProviderInstallState {
    if (this.#running) return this.state;
    const release = this.#release;
    if (!release) throw new InstallError(`Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}.`);
    const operationId = newId("op");
    const abort = new AbortController();
    this.#set({ phase: "downloading", operationId, downloadedBytes: 0, totalBytes: release.archiveBytes, version: release.version, message: "Downloading Google's official Antigravity runtime." });
    const done = this.#install(release, abort.signal).then(
      () => {
        this.#set({ phase: "succeeded", installedVersion: release.version, message: undefined });
      },
      (error: unknown) => {
        if (this.#state.operationId !== operationId) return;
        this.#set(
          abort.signal.aborted
            ? { phase: "cancelled", message: "Installation cancelled. Nothing changed." }
            : { phase: "failed", message: error instanceof InstallError ? error.message : `Could not install Antigravity: ${describeError(error)}` },
        );
      },
    ).finally(() => {
      if (this.#running?.operationId === operationId) this.#running = undefined;
    });
    this.#running = { operationId, abort, done };
    return this.state;
  }

  cancel(operationId?: string): ProviderInstallState {
    const running = this.#running;
    if (!running) return this.state;
    if (operationId && operationId !== running.operationId) throw new InstallError("That installation is no longer current.");
    running.abort.abort();
    return this.state;
  }

  /** Waits for the running install (tests). */
  async settled(): Promise<ProviderInstallState> {
    await this.#running?.done;
    return this.state;
  }

  /** Removes the managed runtime. Refused while an install runs or a session holds it. */
  remove(): ProviderInstallState {
    if (this.#running) throw new InstallError("Cancel the installation first.");
    if (this.#leases > 0) throw new InstallError("Stop Antigravity sessions and sign-in before removing its runtime.");
    fs.rmSync(this.managedDirectory, { recursive: true, force: true });
    this.#state = { phase: "idle", ...(this.#release ? { version: this.#release.version, totalBytes: this.#release.archiveBytes } : {}) };
    this.options.onChange?.(this.state);
    return this.state;
  }

  async #install(release: AntigravityReleaseAsset, signal: AbortSignal): Promise<void> {
    fs.mkdirSync(this.#versions, { recursive: true, mode: 0o700 });
    const destination = path.join(this.#versions, release.sha256);
    if (fs.existsSync(destination)) {
      const existing = this.#completed(release.sha256);
      this.#set({ phase: "verifying", message: "Checking the installed runtime." });
      await this.options.validate(existing, release.version);
      this.#activate(release.sha256);
      return;
    }
    const required = release.archiveBytes + release.executable.bytes + release.harness.bytes + FREE_SPACE_MARGIN;
    try {
      const fsStat = fs.statfsSync(this.#versions);
      if (fsStat.bavail * fsStat.bsize < required) {
        throw new InstallError(`Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MB of free space to install.`);
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
    }
    const staging = fs.mkdtempSync(path.join(this.#versions, ".install-"));
    try {
      const archive = path.join(staging, "download.zip");
      await this.#download(release, archive, signal);
      this.#set({ phase: "extracting", message: "Extracting the verified runtime." });
      const pair = path.join(staging, "runtime");
      fs.mkdirSync(pair, { mode: 0o700 });
      await this.#extract(release, archive, pair, signal);
      fs.rmSync(archive, { force: true });
      fs.chmodSync(path.join(pair, release.executable.name), 0o755);
      fs.chmodSync(path.join(pair, release.harness.name), 0o755);
      this.#set({ phase: "verifying", message: "Checking the downloaded runtime." });
      await this.options.validate(
        { executablePath: path.join(pair, release.executable.name), harnessPath: path.join(pair, release.harness.name), source: "managed", version: release.version },
        release.version,
      );
      if (signal.aborted) throw new InstallError("cancelled");
      fs.writeFileSync(
        path.join(pair, RECORD),
        JSON.stringify({ releaseId: release.sha256, version: release.version, executable: release.executable, harness: release.harness }),
        { flag: "wx", mode: 0o600 },
      );
      fs.renameSync(pair, destination);
      this.#activate(release.sha256);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async #download(release: AntigravityReleaseAsset, file: string, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.downloadTimeoutMs ?? 45 * 60_000);
    const both = AbortSignal.any([signal, timeout]);
    const response = await (this.options.fetchImpl ?? fetch)(release.url, { signal: both, redirect: "follow" });
    if (!response.ok || !response.body) throw new InstallError(`The Antigravity download failed (HTTP ${response.status}).`);
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    const length = response.headers.get("content-length");
    if ((!encoding || encoding === "identity") && length !== null && Number(length) !== release.archiveBytes) {
      throw new InstallError("The Antigravity download size did not match the pinned release.");
    }
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) => {
        bytes += chunk.length;
        if (bytes > release.archiveBytes) {
          done(new InstallError("The Antigravity download was larger than the pinned release."));
          return;
        }
        hash.update(chunk);
        const now = Date.now();
        if (now - lastReport >= 250 || bytes === release.archiveBytes) {
          lastReport = now;
          this.#set({ downloadedBytes: bytes });
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), meter, fs.createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal: both });
    if (bytes !== release.archiveBytes || hash.digest("hex") !== release.sha256) {
      throw new InstallError("The Antigravity download failed its size or SHA-256 check. Nothing was installed.");
    }
  }

  async #extract(release: AntigravityReleaseAsset, archive: string, into: string, signal: AbortSignal): Promise<void> {
    const entries = readZipEntries(archive);
    if (entries.length !== 2) throw new InstallError("The archive must hold exactly the Antigravity runtime and its harness.");
    const seen = new Set<string>();
    for (const entry of entries) {
      const expected = [release.executable, release.harness].find((f) => f.name === entry.name);
      const unixType = (entry.externalAttributes >>> 16) & 0o170000;
      if (
        !expected ||
        seen.has(entry.name) ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        (unixType !== 0 && unixType !== 0o100000) ||
        (entry.externalAttributes & 0x10) !== 0 ||
        entry.uncompressedSize !== expected.bytes
      ) {
        throw new InstallError("The archive holds an unexpected, unsafe or wrongly sized file.");
      }
      seen.add(entry.name);
      await extractZipEntry(archive, entry, path.join(into, entry.name), 0o700, signal);
    }
  }

  #activate(releaseId: string): void {
    const tmp = path.join(this.managedDirectory, `active.json.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify({ releaseId }), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, this.#active);
  }
}

function safeJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readSmall(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 8192) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function sizeIs(file: string, bytes: number | undefined): boolean {
  if (!Number.isSafeInteger(bytes) || (bytes ?? 0) <= 0) return false;
  try {
    return fs.statSync(file).size === bytes;
  } catch {
    return false;
  }
}
