/**
 * An env server in a process of its own, for tests that stop it the hard way
 * (SIGKILL): the same options the in-process tests boot with, its address on
 * stdout as one JSON line, then it stays up until it is killed.
 *
 *   node --import tsx test/fixtures/crash-host.ts <dataDir> <fakeBinDir>
 */
import { startEnvServer } from "../../src/server.js";
import { silentLogger } from "../../src/util.js";

const [dataDir, bin] = process.argv.slice(2);
if (!dataDir || !bin) {
  process.stderr.write("usage: crash-host <dataDir> <fakeBinDir>\n");
  process.exit(2);
}
const server = await startEnvServer({
  dataDir,
  searchDirs: [bin],
  logger: silentLogger,
  probeOnStart: false,
  coalesceMs: 5,
  forcePipeTerminals: true,
  computerUse: false,
});
process.stdout.write(`${JSON.stringify({ url: server.url, token: server.token })}\n`);
setInterval(() => undefined, 1 << 30);
