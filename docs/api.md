# Public API

Use portable `@jocki/saddle` for a host-provided `VaultFileSystem`; use `@jocki/saddle/node` for explicit Node filesystem access. The emitted `.d.ts` files contain exact argument/result types. No portable entry point imports Electron, Node or a UI.

## Archive and unit APIs

| API                                            | Purpose                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RecordFiles(fs, filename)`                    | Named records inside one archive: `list`, `read`, `writeAtomic`, `remove`, `stat`, `readRange` |
| `saveDocument(name, doc)`                      | Incremental Automerge persistence with atomic heads/change statistics                          |
| `documentChanges(name)`, `documentHeads(name)` | Index statistics, with validated payload decoding when a statistic is absent                   |
| `Companions(fs)`                               | Unit sibling naming, descriptor/resource records and a separately granted root companion       |
| `FileVault.open(fs, computer, options)`        | Explicit opened-root engine, drafts, save, history and scope policies                          |
| `WorkspaceStore.open(...)`                     | Optional portable workspace settings; not required for standalone units                        |
| `ProtectedFileSync.open(...)`                  | Authenticated grants/manifests and coordinated retention using a `Repository`                  |

Low-level writes require the host’s writer lease. They do not replace high-level history or unit save transactions. `read` returns `undefined` for a missing record, a zero-length byte array for an empty record, and throws for corruption. Unknown named payloads survive updates/compaction. Archive indexing reads only slots and index ranges. TypeScript compaction currently buffers the live replacement archive before the host’s atomic write; allow memory for that live size. Python compaction streams payloads in bounded chunks.

## Node operations

`operate(request, {signal?, onReady?})` resolves only after durable completion and releases its lease on failure. Every request has an explicit `target` path. A selected file never imports an unopened ancestor or sibling. `profile` is private identity/cache state; profiles nested inside the target are excluded from scanning/watching. `renameExecutable` explicitly selects the libgit2 capability.

| Method                                   | Additional request fields                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `unit.inspect`                           | none                                                                            |
| `archive.list`, `archive.verify`         | none; target may be an archive or its ordinary unit                             |
| `archive.get`                            | `record`                                                                        |
| `archive.put`                            | `record`, canonical padded-base64 `bytes`; protected Automerge puts are refused |
| `metadata.get`                           | none                                                                            |
| `metadata.set`                           | `value`: validated Resource core object or null to remove it                    |
| `history.list`                           | none                                                                            |
| `history.configure`, `sharing.configure` | `state`: `unset`, `disabled`, `enabled`                                         |
| `history.reset`                          | none; keep current contents and one fresh creation version                      |
| `history.delete`                         | `hash`; remove that version’s edits and replay later changes                    |
| `sharing.contact`                        | none; public contact card without enabling sharing                              |
| `sharing.list`, `sharing.invite`         | none                                                                            |
| `sharing.join`                           | `invitation`; use the explicit destination folder                               |
| `sharing.grant`                          | `invitation`, approved `contact`, `role` (`read` or `edit`)                     |
| `sharing.broadcast`                      | `invitation`, boolean `broadcast`                                               |
| `sharing.serve`                          | explicit `signal` option; optional `endpoints`                                  |

`sharing.serve` watches only the selected capability, serializes event bursts, reconciles external edits and flushes before releasing the lease on cancellation. `onReady` runs once the watcher is active. An invitation advertises a scope; it is not a grant. The CLI provides the same operations and manages process cancellation. See the [specification](https://github.com/jocki-app/saddle-specification) for wire semantics.
