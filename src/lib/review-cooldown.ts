// Customise cooldown: reading when the review host will next accept a customise pass,
// and saying how long that is.

import { t } from '@/i18n';

// review/check answers with customise_next — when the asset may be customised again —
// for anything already carrying has_customised. The upstream hasn't pinned a format
// down, so accept the three plausible ones: an ISO date string, a seconds epoch, or a
// milliseconds epoch. Returns that moment in ms, or null when it can't be read.
export const parseCustomiseNext = (value: unknown): number | null => {
  const fromNumber = (n: number) => (n < 1e11 ? n * 1000 : n); // seconds vs ms epoch
  if (typeof value === 'number' && Number.isFinite(value)) return fromNumber(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return fromNumber(n);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// Inside the cooldown when that moment is still ahead of us and no further away than
// API_COOLDOWN hours — the lockout the upstream started when the asset was customised.
// Returns the milliseconds left, or null when the asset is free to customise.
export const cooldownRemaining = (nextMs: number | null, cooldownHours: number): number | null => {
  if (nextMs === null) return null;
  const ms = nextMs - Date.now();
  if (ms <= 0) return null;
  return ms <= cooldownHours * 3_600_000 ? ms : null;
};

// What /api/review/check/<uuid> answers with — the fields this file reads, plus the
// cooldown_hours the proxy derives from API_COOLDOWN.
export type ReviewCheck = {
  message?: string;
  id?: number;
  can_edit?: number;
  has_customised?: number;
  customise_next?: string | number;
  cooldown_hours?: number;
  error?: { message?: string };
};

export const formatRemaining = (ms: number): string => {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return t('cooldown.inMinutes', { count: mins });
  const hours = Math.round(mins / 60);
  return t('cooldown.inHours', { count: hours });
};
