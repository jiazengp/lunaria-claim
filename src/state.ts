import { STATE_CLOSE, STATE_OPEN, type TrackerState } from './model.js';
import { escapeRegExp } from './utils.js';

const STATE_BLOCK_RE = new RegExp(
  `${escapeRegExp(STATE_OPEN)}\\n([\\s\\S]*?)\\n${escapeRegExp(STATE_CLOSE)}`,
);

export function serializeState(state: TrackerState): string {
  return `${STATE_OPEN}\n${JSON.stringify(state)}\n${STATE_CLOSE}`;
}

/** 状态块损坏时返回 null，由调用方决定走模板重建或报错 */
export function parseState(body: string): TrackerState | null {
  const match = STATE_BLOCK_RE.exec(body);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return isTrackerState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTrackerState(value: unknown): value is TrackerState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TrackerState>;
  return (
    candidate.version === 1 && Array.isArray(candidate.files) && Array.isArray(candidate.claims)
  );
}
