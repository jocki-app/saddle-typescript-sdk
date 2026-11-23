import type { FeatureOverrides } from "./scope-policy.js";
import type { DataResource } from "./metadata.js";

/** Only this folder's declarations and direct membership; child contents stay in their own containers. */
export interface FolderDocument extends Record<string, unknown> {
  format: "saddle-folder/1";
  id: string;
  features: FeatureOverrides;
  retainHistory?: boolean;
  /** Present after the first agreed history checkpoint. */
  checkpoint?: { epoch: number; generation: string };
  namedKeys: string[];
  resource: DataResource | null;
  children: Record<
    string,
    { name: string; kind: "file" | "folder"; deleted: boolean }
  >;
}
export const folderName = "folder.automerge";

export const folderEpoch = (doc: FolderDocument) => doc.checkpoint?.epoch ?? 0;
export const folderGeneration = (doc: FolderDocument) =>
  doc.checkpoint?.generation ?? doc.id;
