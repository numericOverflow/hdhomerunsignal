// Text for a tuner reading that the backend marks stale (the last device read failed).
// staleForMs is the time since the last good read, or null if there was none yet.
export function staleText(staleForMs) {
  if (staleForMs === null || staleForMs === undefined) return 'Waiting for tuner data';
  return `No update from tuner for ${Math.max(1, Math.round(staleForMs / 1000))} s`;
}
