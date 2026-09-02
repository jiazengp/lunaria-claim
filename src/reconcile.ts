import {
  fileKey,
  groupByLocale,
  type LocaleSection,
  type ReleaseReason,
  type TrackedFile,
  type TrackerState,
} from './model.js';

export interface ReconcileResult {
  state: TrackerState;
  sections: LocaleSection[];
  changed: boolean;
}

/** sync 对账：以 lunaria status.json 派生的清单为准收敛 files 与 claims */
export function reconcile(
  current: TrackerState,
  desiredFiles: TrackedFile[],
  now: Date,
): ReconcileResult {
  const desiredKeys = new Set(desiredFiles.map((file) => fileKey(file.locale, file.sharedPath)));
  const claims = current.claims.map((claim): TrackerState['claims'][number] => {
    if (claim.releasedAt || desiredKeys.has(fileKey(claim.locale, claim.path))) {
      return claim;
    }
    return {
      ...claim,
      releasedAt: now.toISOString(),
      releaseReason: 'completed' as ReleaseReason,
    };
  });
  const state: TrackerState = { version: 1, files: desiredFiles, claims };
  const changed =
    JSON.stringify({ files: current.files, claims: current.claims }) !==
    JSON.stringify({ files: desiredFiles, claims });
  return { state, sections: groupByLocale(desiredFiles), changed };
}
