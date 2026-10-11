import { DEFAULT_PRESSURE } from '@field-survey/core';

/**
 * Pencil pressure 0–1 from gesture-handler's `stylusData` (set for Apple Pencil touches only); a
 * finger has none and draws at the default. React Native's own touch `force` stays 0 on an iPad
 * because it is only filled in on 3D Touch hardware (D116).
 */
export function pressureOf(stylus: { pressure?: number } | null | undefined): number {
  const f = stylus?.pressure;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? Math.min(1, f) : DEFAULT_PRESSURE;
}
