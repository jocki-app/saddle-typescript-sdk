export interface Features {
  history: boolean;
  sync: boolean;
}
export interface FeatureOverrides {
  history?: boolean;
  sync?: boolean;
}
export interface ScopePolicies {
  vault: FeatureOverrides;
  folders: Record<string, FeatureOverrides>;
  files: Record<string, FeatureOverrides>;
}
export const noFeatures: Features = { history: false, sync: false };
export const emptyScopePolicies = (): ScopePolicies => ({
  vault: {},
  folders: {},
  files: {},
});
/** Each feature inherits independently. The nearest explicit setting wins. */
export function effectiveFeatures(
  policies: ScopePolicies,
  workspace: Features,
  path: string,
  id?: string,
): Features {
  const result = { ...workspace, ...policies.vault };
  const parts = path.split("/");
  for (let count = 1; count < parts.length; count++)
    Object.assign(
      result,
      policies.folders[parts.slice(0, count).join("/")] ?? {},
    );
  if (id) Object.assign(result, policies.files[id] ?? {});
  return result;
}
export const needsDocument = (features: Features) =>
  features.history || features.sync;
