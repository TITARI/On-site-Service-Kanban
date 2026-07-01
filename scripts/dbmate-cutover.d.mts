export interface LegacyVersionMapping {
  readonly legacy: string;
  readonly dbmate: string;
}

export interface LegacyVersionCutoverPlan {
  mappings: readonly LegacyVersionMapping[];
  unknownLegacyVersions: string[];
}

export const LEGACY_VERSION_MAP: readonly LegacyVersionMapping[];

export function planLegacyVersionCutover(
  appliedVersions: readonly string[]
): LegacyVersionCutoverPlan;

export function cutoverLegacyVersions(options?: {
  databaseUrl?: string;
}): Promise<LegacyVersionCutoverPlan>;
