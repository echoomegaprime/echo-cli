# Upload and Artifact Center storage quotas

When `uploads` is enabled, every new upload, generated-file ingestion, artifact
registration and upload metadata update uses finite storage admission. Existing
files remain readable and deletable when the store is full, over quota or retains
an interrupted writer lock. Nothing is automatically evicted or deleted.

The optional `uploads.quota` object has four settings. Missing fields use these
defaults; values must be positive safe integers. Unknown fields, zero, fractions,
strings and non-finite values are refused at configuration parsing.

```json
{
  "quota": {
    "accountBytes": 1073741824,
    "storeBytes": 8589934592,
    "accountItems": 1000,
    "storeItems": 10000
  }
}
```

`accountBytes` is 1 GiB per account and `storeBytes` is 8 GiB for the complete
configured root. Item limits are 1,000 per account and 10,000 for the root.
Uploads and artifacts share these allowances. Each upload or artifact directory
counts as one item, including an abandoned staging directory. A linked artifact
counts as another item and its own metadata consumes bytes; the already-stored
upload payload is not charged a second time merely because an artifact links it.

The existing `maxBytes` setting remains a separate per-file limit: 200 MiB by
default and at most 2 GiB. An explicit larger per-file setting cannot override a
smaller account or store allowance. Existing session, approval, UID isolation,
Origin, CSRF, file-format and filename checks are unchanged. Raising a chat or
tool deadline does not change storage admission.

## What the byte allowance measures

Admission counts actual **logical regular-file bytes** under upload, artifact and
staging entries: payloads, metadata, generated thumbnails, inline artifact content,
and abandoned atomic metadata replacement files. It does not trust a metadata
record's claimed byte count. Each streaming chunk reserves its stored bytes before
the disk write. Thumbnail and metadata bytes are reserved before their writes too.
An atomic metadata update needs headroom for both its existing file and temporary
replacement; after rename, the old file's bytes are released from the current
writer's accounting. A rejected update retains the original metadata.

These are not filesystem allocated-byte or free-space guarantees. Directory
entries, filesystem blocks/journaling and the small root policy/lock control files
are outside this logical-byte total. Leave operating-system free-space headroom
and retain normal filesystem monitoring. Hard-linked file lengths are counted
conservatively for each entry; filesystem compression or sparse allocation does
not increase the logical allowance.

## Cross-process admission and availability

An atomic `.quota-lock` directory serializes **one writer for the whole root**,
including different accounts, UploadStore instances and OS processes. The writer
holds it through streaming, metadata and final rename. Contending writers receive
HTTP 409 immediately; they do not wait in an invisible queue or start later after
their caller has timed out. Quota exhaustion returns HTTP 507. Unsafe storage
structure or policy mismatch returns HTTP 503. The per-file limit retains 413.

The first writer records the finite limits in `.quota-policy.json`. Every later
writer must have the same four values. Starting another process with a larger
configuration cannot quietly widen an existing root's policy. There are no
trusted persisted usage counters: each admission scans actual on-disk state under
the exclusive lock. Ordinary directories and files in the known storage layout
are required. Symlink roots/ancestors, symlink entries, unsupported entries,
malformed policy, inaccessible data and interrupted scans block writes. Unknown
data is never silently skipped to make room.

This protocol requires a filesystem with reliable atomic directory creation.
Use one managed storage root and stop old application versions before enabling
writers; an old binary or unrelated filesystem writer does not participate in the
protocol. This is not a distributed lease or a defense against a privileged local
actor replacing filesystem paths while the process runs.

Read/list/download and delete operations do not acquire the writer lock. Deletion
can only reduce stored usage; a concurrent writer conservatively retains its prior
count until the next scan. A scan interrupted by deletion can refuse that admission
rather than undercount. A failed operation cleans only its own staging files. An
iterator that throws or has a rejected/nonsettling asynchronous `return()` cannot
retain the storage lock after the failure path finishes.

## Restart, recovery and changing limits

A normal restart recounts files rather than resetting an in-memory allowance.
Abandoned staging and metadata copies remain charged. A crash can leave the root
lock in place; the application deliberately does not steal it, expire it by time,
or recursively delete another writer's reservation. This sacrifices automatic
availability recovery to preserve a clear cross-process boundary.

Offline recovery belongs to the storage operator:

1. Identify and stop **all** services/processes writing the same root, and verify
   their shutdown. A PID or timestamp in a marker alone does not prove that a
   writer is gone, especially after a restart or on shared storage.
2. Preserve a recovery copy of stored entries, policy, lock markers and abandoned
   staging. Inspect the interrupted operation and any final IDs before retrying a
   user action; a crash after rename may already have committed it.
3. After establishing that no writer remains, move the abandoned lock evidence to
   a reviewed recovery location **outside** the storage root. Do not remove active
   or unknown locks. Do not automatically delete staging or prior user data.
4. If changing limits, update the reviewed startup configuration and stored policy
   together while all writers remain stopped. Preserve policy schema version 1 and
   all four explicit positive integer values. A store already above a new limit
   will allow reads/deletes but refuse additional writes.
5. Start the intended candidate with the matching policy, verify ordinary writes
   within the allowance and rejected writes at the boundary, and read back the
   retained original records. Any retained staging still consumes quota until its
   disposition has been reviewed separately.

No format migration or deletion is necessary for rollback: blobs and metadata keep
their existing formats. Restore the candidate/configuration/policy as a matched
set. A previous binary does not enforce these aggregate limits; keep writes
disabled if rolling back to it until a quota-aware candidate is restored. Do not
erase policy, lock or staging state as part of an automatic rollback.

## Verification

`tests/prime-upload-quota.test.ts` covers account/global byte and item exhaustion,
actual HTTP uploads/artifacts, ingest streaming, metadata/thumbnail bytes, failed
stream cleanup, metadata replacement at capacity, legacy over-quota read/delete,
different instances, real child-process contention/crash, conservative orphan
reconciliation, policy mismatch, symlink and malformed/unexpected storage refusal.
The existing upload and media ingestion tests retain format, ownership, per-file
limit and transport coverage. These controlled tests do not establish a live
deployment's filesystem capacity, native admission or production certification.
