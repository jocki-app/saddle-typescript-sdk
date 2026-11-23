# SADDLE TypeScript SDK

The portable implementation of **SADDLE v1**: named binary records, resource metadata, independent file/folder identity, inherited feature policies, retained history, approved synchronization and coordinated retention.

## Build

Use Node.js 26.10 or newer, then run `npm ci` and `npm run check`. The package is `@jocki/saddle`; browser and native clients provide explicit filesystem capabilities. The main entry point and `units/*` are portable. Node adapters are isolated under `@jocki/saddle/node` and `node/*`.

```ts
import { RecordFiles, Companions, FileVault } from "@jocki/saddle";
import { NodeVaultFiles, operate } from "@jocki/saddle/node";

const files = await NodeVaultFiles.open("/path/to/work");
const release = await files.acquireWriter();
try {
  const records = new RecordFiles(files, ".notes.md.saddle");
  console.log(await records.list());
} finally {
  await release();
}

await operate({method: "history.configure", target: "/path/to/notes.md", state: "enabled"});
```

`operate` is the same explicit API exposed through the CLI's JSON protocol and Python runtime binding. It supports inspection, resource metadata, history policies/list/reset/deletion, share grants and per-scope broadcast. Serving exchange requires an explicit cancellation signal and configured transport endpoints. No replicated data can invoke these local APIs.

## Modules

- `filesystem`: portable relative paths, bounded reads, durable atomic/positioned writes, scans and rename capabilities.
- `units/record-container`: alternating checksummed commit slots, immutable chunks, incremental Automerge appends, unknown-record preservation and compaction.
- `units/companions`, `contracts`, `folder-document`: optional unit archives and stable IDs.
- `units/metadata`, `knowledge`: Frictionless Data Resources, inline metadata validation and document graph adapters.
- `units/history`, `history-rewrite`, `retention`: real change descriptions, version replay/reset and peer-agreed pruning.
- `units/vault`, `workspace`, `protected-sync`: opened-root boundaries, independent file drafts, scope manifests and signed Keyhive grants.
- `node/*`: real filesystem leases, Node repository storage, libgit2 rename capability and local operations.

CSDB projection is an optional format adapter included with the unit engine; the file's ordinary CSDB text remains usable independently. The external CSDB dependency is vendored reproducibly. User-interface code, plugin execution and operating-system services belong to clients, not portable document state.

## Packaging and conformance

`npm pack` builds the package. Applications may use its tarball as a reproducible file dependency without another checkout. The format is defined in [saddle-specification](https://github.com/jocki-app/saddle-specification), with [Python tools](https://github.com/jocki-app/saddle-python-sdk), a [CLI](https://github.com/jocki-app/saddle-cli) and [documentation](https://jocki-app.github.io/saddle-website/).

Run the SDK tests plus the consuming client's synchronization/security and platform integration suites when changing unit contracts. Archive writes must be durable before acknowledgement. Retention operations must preserve known peers' authority and dirty drafts. Never commit runtime identities or invitations.

GPL-3.0-only. See [LICENSE](LICENSE).
