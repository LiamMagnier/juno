# Juno backup and restore drill

The backup scripts cover the two stores that must recover together:

- PostgreSQL, written as a custom-format `pg_dump`.
- S3-compatible objects or the VM-local `.uploads` tree, copied with a
  per-object SHA-256 manifest.

They never print connection strings or object contents. They also require an
explicit confirmation token. Do not put a backup directory inside the checkout
or commit a generated backup.

## Run the disposable local restore drill

The repository includes a fully local end-to-end drill. It starts a temporary
PostgreSQL cluster bound to `127.0.0.1`, creates deterministic database rows and
three object fixtures, invokes the production backup/verify/restore scripts,
compares the exact restored row set and every object SHA-256 digest, then stops
the cluster and removes its temporary workspace:

```bash
node scripts/restore-drill.mjs --check
node scripts/restore-drill.mjs
```

The local drill requires Node.js 24 LTS and these PostgreSQL 16-compatible
binaries on `PATH`: `initdb`, `pg_ctl`, `postgres`, `createdb`, `pg_isready`,
`psql`, `pg_dump`, and `pg_restore`. If they are installed in another
directory, set `JUNO_PG_BIN_DIR` to that directory. No Docker, cloud account,
application `.env`, production database, or production object credentials are
read; the child processes explicitly clear those environment variables and the
storage mode is forced to local files. Set `JUNO_RESTORE_DRILL_KEEP=1` only
when debugging a failed local run; otherwise generated data is deleted.

This proves the backup format, manifest verification, `pg_restore` behavior,
database row recovery, local object recovery, and exact object integrity. It
does not prove a remote provider's IAM permissions, network path, S3 behavior,
RPO/RTO, or an application deployment against the restored database. A remote
drill still requires all of the following disposable, non-production targets:

- an empty scratch PostgreSQL database reachable by the release host;
- an empty scratch S3-compatible bucket and scoped restore credentials, or a
  scratch VM-local uploads directory;
- a scratch application deployment configured to use those targets; and
- an operator-approved maintenance window plus measured RPO/RTO capture.

Those prerequisites are intentionally not supplied by this local harness.

## Create and verify a backup

Run from the release checkout with a destination outside the repository:

```bash
JUNO_BACKUP_CONFIRM=CREATE_BACKUP \
JUNO_BACKUP_DIR=/srv/juno-backups/$(date +%Y%m%d-%H%M%S) \
npm run backup:production

JUNO_BACKUP_DIR=/srv/juno-backups/<timestamp> npm run backup:verify
```

Use `DIRECT_URL` for the dump connection when it is present. If storage is
S3-compatible, the script uses the `S3_*` variables. Otherwise set
`JUNO_UPLOADS_DIR` to the directory containing the local object tree.

## Restore into scratch targets

The restore command refuses production-looking database hostnames and requires
an explicit scratch target. The local object target must already exist, be a
real directory (not a symlink), and be empty; the restore command never creates
or cleans it for you. The S3 target bucket must also be empty: the command
performs a `ListObjectsV2` preflight and refuses any visible objects. Prepare
the local target explicitly and check it before starting:

```bash
mkdir -p /srv/juno-restore-objects
test -z "$(find /srv/juno-restore-objects -mindepth 1 -maxdepth 1 -print -quit)"

JUNO_RESTORE_CONFIRM=RESTORE_TO_SCRATCH \
JUNO_BACKUP_DIR=/srv/juno-backups/<timestamp> \
RESTORE_DATABASE_URL='postgresql://…/juno_restore' \
RESTORE_UPLOADS_DIR=/srv/juno-restore-objects \
npm run backup:restore
```

For an S3 scratch bucket, create an empty non-production bucket and provide
`RESTORE_S3_BUCKET`, `RESTORE_S3_ACCESS_KEY_ID`,
`RESTORE_S3_SECRET_ACCESS_KEY` and the optional `RESTORE_S3_*` endpoint/region
settings instead of `RESTORE_UPLOADS_DIR`. The command rejects absolute paths,
`.`/`..` traversal, empty path segments, path separators that are not `/`, and
any manifest object key or backup-relative path that resolves outside its
allowed root. It validates every manifest entry and object digest before
writing any object bytes.

After restoration, run `npx prisma migrate status` against the scratch
database, compare row/object counts, and run the public plus authenticated
production smoke suite against a scratch deployment. Record measured RPO/RTO
and the backup identifier in the release evidence. These commands are tooling;
this repository does not claim a restore drill until an operator has exercised
them against disposable targets.
