import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";

/*
 * The computer host's default TLS (COMPUTERS_2026-10.md D18,
 * deploy/computer-host/private-tls.sh): a private CA that can sign for exactly
 * one name, whose key is destroyed once the host's certificate is signed. The
 * web VM trusts it through NODE_EXTRA_CA_CERTS, so trusting it must add trust in
 * that one name only: a certificate the same kind of CA signed for any other
 * name is rejected by Node's TLS.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "deploy/computer-host/private-tls.sh");
let dir = "";

function openssl(args: string[], input?: string): string {
  const res = spawnSync("openssl", args, { encoding: "utf8", input });
  assert.equal(res.status, 0, `openssl ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

/** Serves `cert`/`key` on loopback and connects with `servername`, trusting only `ca`. */
async function handshake(cert: string, key: string, ca: string, servername: string): Promise<{ ok: boolean; error?: string }> {
  const server = createServer({ cert, key }, (_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port, servername, ca, rejectUnauthorized: true }, () => {
        socket.end();
        resolve({ ok: true });
      });
      socket.on("error", (error) => resolve({ ok: false, error: `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}` }));
    });
  } finally {
    server.close();
  }
}

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "juno-host-tls-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("private-tls.sh signs a certificate for the host name only, and destroys the CA key", async () => {
  const out = path.join(dir, "tls");
  const res = spawnSync("bash", [SCRIPT, "localhost", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["ca.pem", "cert.pem", "key.pem"], "no CA key is left anywhere in the output");
  const caText = openssl(["x509", "-in", path.join(out, "ca.pem"), "-noout", "-text"]);
  assert.match(caText, /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:localhost/);
  assert.match(caText, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(caText, /ASN1 OID: prime256v1/);
  const hostText = openssl(["x509", "-in", path.join(out, "cert.pem"), "-noout", "-text"]);
  assert.match(hostText, /DNS:localhost/);
  assert.match(hostText, /TLS Web Server Authentication/);
  const days = (Date.parse(openssl(["x509", "-in", path.join(out, "cert.pem"), "-noout", "-enddate"]).split("=")[1]) - Date.now()) / 86_400_000;
  assert.ok(days > 395 && days <= 397, `valid ${days} days`);
  const ok = await handshake(readFileSync(path.join(out, "cert.pem"), "utf8"), readFileSync(path.join(out, "key.pem"), "utf8"), readFileSync(path.join(out, "ca.pem"), "utf8"), "localhost");
  assert.deepEqual(ok, { ok: true });
});

test("a certificate for another name, signed by a name-constrained CA, is rejected by Node's TLS", async () => {
  // A CA built the way private-tls.sh builds it (its key kept here, so it can sign a second name).
  const caKey = path.join(dir, "ca.key");
  const caCert = path.join(dir, "ca.pem");
  writeFileSync(
    path.join(dir, "ca.cnf"),
    "[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = ca\n[dn]\nCN = test constrained CA\n[ca]\n" +
      "basicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign, cRLSign\n" +
      "nameConstraints = critical, permitted;DNS:localhost\nsubjectKeyIdentifier = hash\n"
  );
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKey]);
  openssl(["req", "-new", "-x509", "-key", caKey, "-days", "2", "-config", path.join(dir, "ca.cnf"), "-out", caCert]);
  const sign = (name: string) => {
    const key = path.join(dir, `${name}.key`);
    const csr = path.join(dir, `${name}.csr`);
    const cert = path.join(dir, `${name}.pem`);
    writeFileSync(path.join(dir, `${name}.cnf`), `[host]\nbasicConstraints = critical, CA:FALSE\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${name}\n`);
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    openssl(["req", "-new", "-key", key, "-subj", `/CN=${name}`, "-out", csr]);
    openssl(["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", path.join(dir, `${name}.cnf`), "-extensions", "host", "-out", cert]);
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  };
  const ca = readFileSync(caCert, "utf8");
  const good = sign("localhost");
  assert.deepEqual(await handshake(good.cert, good.key, ca, "localhost"), { ok: true });
  for (const name of ["other.test", "localhost.evil.test"]) {
    const other = sign(name);
    const result = await handshake(other.cert, other.key, ca, name);
    assert.equal(result.ok, false, `${name} was trusted`);
    assert.match(result.error ?? "", /subtree|constraint|PERMITTED/i, result.error);
  }
});

test("an IP address is refused as the host name, by private-tls.sh and by setup.sh before it changes anything", () => {
  // The certificate names its host as DNS:<name>, and Node checks an https://<IP>
  // origin against IP entries only ("IP: 10.0.0.5 is not in the cert's list"), so
  // a certificate made for an address could never be trusted by the web VM. The
  // host needs a name: a private one (a private DNS zone, or /etc/hosts on the
  // web VM) or a public one.
  for (const address of ["10.0.0.5", "2001:db8::5"]) {
    const out = path.join(dir, `ip-${address.replace(/[^0-9a-f]/gi, "-")}`);
    const res = spawnSync("bash", [SCRIPT, address, out], { encoding: "utf8" });
    assert.equal(res.status, 2, `private-tls.sh signed for ${address}`);
    assert.match(res.stderr, /a DNS name, not an IP address/);
    assert.equal(existsSync(out), false, "nothing was written");
  }
  // setup.sh refuses it before the root check and before the first step (never
  // run here: as root it would install packages and load a firewall).
  const setup = readFileSync(path.join(ROOT, "deploy/computer-host/setup.sh"), "utf8");
  const check = setup.indexOf("--domain must be a DNS name");
  assert.ok(check > 0, "setup.sh checks --domain under private TLS");
  assert.match(setup.slice(setup.lastIndexOf("\n", setup.lastIndexOf("\n", check) - 1), check), /\[ "\$TLS" = private \] && valid_address "\$DOMAIN"/);
  assert.ok(check < setup.indexOf('[ "$(id -u)" -eq 0 ]'), "before the root check");
  assert.ok(check < setup.indexOf('echo "==> Packages"'), "before anything is installed");
});

test("--renew-tls renews the kind of certificate setup installed unless --tls says otherwise", () => {
  // `--tls own` and `--tls private` both serve $TLS_DIR/cert.pem. `--renew-tls`
  // alone used to mean private whatever setup had installed, so on a host with
  // the owner's own certificate it wrote a private CA's certificate over the
  // file nginx serves, and the web VM, which never trusted that CA, lost the
  // host. setup.sh records the kind in computer-host-setup.json; renewal reads
  // it back. (The action needs root, so it is pinned as source.)
  const setup = readFileSync(path.join(ROOT, "deploy/computer-host/setup.sh"), "utf8");
  assert.match(setup, /--tls\) TLS="\$2"; TLS_GIVEN=1; shift 2 ;;/);
  assert.match(setup, /json\.dump\(\{"domain": sys\.argv\[1\], "tls": sys\.argv\[2\], "namespace": sys\.argv\[3\]\}, file\)/);
  const renew = setup.slice(setup.indexOf("  renew-tls)\n"), setup.indexOf("  rebuild-image) rebuild_image"));
  assert.ok(renew.length > 0, "the renew-tls action is where it was");
  const recorded = renew.indexOf('[ "$TLS_GIVEN" = 1 ] || TLS="$(python3 -c');
  assert.ok(recorded >= 0, "renewal reads the recorded kind when --tls is not given");
  assert.match(renew.slice(recorded), /^[^\n]*computer-host-setup\.json"\)\)\["tls"\]/);
  assert.ok(recorded < renew.indexOf("install_tls"), "before the certificate is made");
});
