# Juno backup and restore drill

The backup scripts cover the two stores that must recover together:

- PostgreSQL, written as a custom-format `pg_dump`.
- S3-compatible objects or the VM-local `.uploads` tree, copied with a
  per-object SHA-256 manifest.

They never print connection strings or object contents. They also require an
explicit confirmation token. Do not put a backup directory inside the checkout
or commit a generated backup.

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
an explicit scratch target. Use an empty database and an empty bucket/directory
in the same region as the real service:

```bash
JUNO_RESTORE_CONFIRM=RESTORE_TO_SCRATCH \
JUNO_BACKUP_DIR=/srv/juno-backups/<timestamp> \
RESTORE_DATABASE_URL='postgresql://…/juno_restore' \
RESTORE_UPLOADS_DIR=/srv/juno-restore-objects \
npm run backup:restore
```

For an S3 scratch bucket, provide `RESTORE_S3_BUCKET`,
`RESTORE_S3_ACCESS_KEY_ID`, `RESTORE_S3_SECRET_ACCESS_KEY` and the optional
`RESTORE_S3_*` endpoint/region settings instead of `RESTORE_UPLOADS_DIR`.

After restoration, run `npx prisma migrate status` against the scratch
database, compare row/object counts, and run the public plus authenticated
production smoke suite against a scratch deployment. Record measured RPO/RTO
and the backup identifier in the release evidence. These commands are tooling;
this repository does not claim a restore drill until an operator has exercised
them against disposable targets.
