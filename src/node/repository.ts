import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { Repository, type RepositoryOptions } from "../repository.js";

export async function openNodeRepository(
  directory: string,
  options: Omit<RepositoryOptions, "documents" | "identity"> = {},
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "identity"), {
    recursive: true,
    mode: 0o700,
  });
  return Repository.open({
    ...options,
    documents: new NodeFSStorageAdapter(path.join(directory, "documents")),
    identity: new NodeFSStorageAdapter(path.join(directory, "identity")),
  });
}
