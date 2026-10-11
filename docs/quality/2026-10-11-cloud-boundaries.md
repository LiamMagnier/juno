# Cloud Work boundary verification

The baseline audit reference is `58cd3739d283088491fc67be710fb8f1c92e267f`.
Current source distinguishes the trusted Work executor from agent-authored programs.

## Verified implementation and tests

- `scripts/work-runner.ts` is a trusted server-side executor with database/connector
  access. Its model adapter currently receives deployment provider keys directly.
  It does not yet use Code's short-lived provider-proxy handshake. This requirement
  remains unresolved; do not describe the worker as holding only scoped credentials.
- Agent-written `run_code` programs execute through `src/lib/exec/work.ts` on the
  separate execution host, never as a child program in that trusted worker. No
  configured sandbox means no tool; unhealthy/non-isolated execution refuses.
- The execution broker validates the image identity and exact process boundary:
  no network, read-only root, non-root user, bounded resources, capabilities dropped,
  and only session input/work/program mounts. Broad image/network/mount/user options
  are rejected. Cancellation kills the actual run and refuses output collection.
- Computer-use containers have a separate firewall and egress proxy, rather than
  relying solely on model/tool URL filtering. The proxy rejects private/metadata
  address families and mixed public/private DNS answers, then pins validated sockets.
  Production firewall/kernel enforcement has not been exercised here.

Local Docker Desktop 29.8.2 was started and the repository's pinned execution image
was built for the actual Linux container boundary. The complete service/broker suite
passed all 41 tests, including four real-container tests. The real tests verify:

1. No public socket/DNS access, read-only system root, non-root uid.
2. Private and metadata destinations fail with Linux ENETUNREACH, rather than a
   closed-port refusal; no provider/API/database/signing-key environment names reach
   the program.
3. After a started marker, cancellation prevents a delayed workspace mutation.
4. Fork and memory attempts hit the configured process/memory bounds.

The first added network assertion compared Linux errno numbers with macOS constants;
that assertion was corrected to compare the guest's ENETUNREACH symbol. It was not
weakened to accept a closed port. The final real-container run passed all four tests.
The first hosted cancellation run exposed a fixture ownership mismatch: its hardcoded
container uid 1000 could not write the Linux runner's uid-1001 workspace. The real
fixture and local developer launcher now bind the non-root workspace owner's uid/gid,
as the production setup already does. Neither grants world-write nor runs as root.
Raw logs: `/tmp/alevr-quality-evidence/exec-kernel-final.log`,
`exec-complete-final.log`, `exec-real-boundaries.log`, `exec-image-build.log`,
`computer-boundaries.log`.
The last log contains 11 passing broker/pinned-egress tests. These tests are fixture
evidence, not a production penetration test or physical computer-use acceptance.

The real image/container suite is wired to a dedicated ephemeral CI job for changes
to execution-host code/tests. Development candidates also build the image and enable
the real suite; they refuse a remote Docker context. Image build failure blocks the
run, so missing images cannot silently produce skipped kernel coverage.

## Remaining risk and next boundary

Separate the trusted Work model adapter from long-lived provider material using
the established backend proxy and per-run scoped authorization. That requires an
explicit queue/lease authentication handshake and deployment credential separation;
merely minting a token inside the existing key-holding worker would not establish
the requested boundary. Do not claim that cosmetic token substitution fixes it.
Implement and test run/owner/model/budget/expiry/revocation binding and remove provider
keys from the worker configuration before accepting that requirement. Production
credential/configuration changes still require the owner's explicit authorization.

The dedicated computer-use firewall must also be tested on a disposable Linux host,
including direct-socket bypass, metadata, IPv6, proxy redirects, cancellation and
cleanup. Public DNS is an explicit firewall exception; these results do not prove
every exfiltration channel closed. Prompt injection remains untrusted data and must
be constrained by grants/brokers. Neither the trusted worker's full compromise nor
all browser/application/session boundaries are proven safe by these tests.
