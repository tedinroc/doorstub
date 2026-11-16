// The call fields of a show in shows.json, shared by the app's loader
// (src/shows/schema.js), the worker (worker/lib/shows.js) and the studio.
// No imports, so the worker can use it in workerd.
//
//   kind "real":  "eventAt"     ISO 8601 UTC time ending in Z, when the call starts (required)
//                 "durationMin" whole minutes, 1 to 600 (required)
//                 "seatPrefix"  one capital letter, not A or B, unique across the file (required)
//   samples:      none of the three; seat letters A (sample-settle) and B (sample-refund-seat)
//   kind "proof": the three are optional (a past real show); seat letter P without one
//
// Seat labels are "<seatPrefix>-<shard>-<seat>" everywhere (site, worker, BCMR).

export const EVENT_FIELDS = Object.freeze(['eventAt', 'durationMin', 'seatPrefix']);
export const SAMPLE_SEAT_PREFIXES = Object.freeze({ 'sample-settle': 'A', 'sample-refund-seat': 'B' });
export const PROOF_SEAT_PREFIX = 'P';
export const MAX_DURATION_MIN = 600;

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;

/**
 * "2026-11-24T13:00:00Z" -> its time in ms; null when it is not an ISO 8601
 * UTC time ending in Z, or not a real calendar time (Date.parse would turn
 * 30 Feb into 2 March and 24:00 into the next day).
 */
export const eventAtMs = (value) => {
  if (typeof value !== 'string') return null;
  const m = ISO_UTC.exec(value);
  if (m === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const same = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  const given = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  return same.every((x, i) => x === given[i]) ? ms : null;
};

const present = (value) => value !== undefined && value !== null;

/**
 * Check and read the call fields of one shows.json entry (or studio plan entry).
 * Returns { eventAt, eventAtMs, durationMin, seatPrefix }; the first three are
 * null for samples (and for a proof show without them). Throws an Error whose
 * message names the field.
 */
export const readEventFields = (raw, kind) => {
  const given = EVENT_FIELDS.filter((field) => present(raw?.[field]));
  const sample = SAMPLE_SEAT_PREFIXES[kind];
  if (sample !== undefined) {
    if (given.length > 0) throw new Error(`${given.join(', ')}: only real shows have a call time and their own seat letter`);
    return { eventAt: null, eventAtMs: null, durationMin: null, seatPrefix: sample };
  }
  const required = kind === 'real';
  const out = { eventAt: null, eventAtMs: null, durationMin: null, seatPrefix: PROOF_SEAT_PREFIX };
  if (required || present(raw?.eventAt)) {
    const ms = eventAtMs(raw?.eventAt);
    if (ms === null) throw new Error('eventAt must be an ISO 8601 UTC time ending in Z, e.g. "2026-11-24T13:00:00Z"');
    out.eventAt = raw.eventAt;
    out.eventAtMs = ms;
  }
  if (required || present(raw?.durationMin)) {
    const d = raw?.durationMin;
    if (!Number.isSafeInteger(d) || d < 1 || d > MAX_DURATION_MIN) throw new Error(`durationMin must be a whole number of minutes from 1 to ${MAX_DURATION_MIN}`);
    out.durationMin = d;
  }
  if (required || present(raw?.seatPrefix)) {
    const p = raw?.seatPrefix;
    if (typeof p !== 'string' || !/^[A-Z]$/.test(p)) throw new Error('seatPrefix must be one capital letter');
    if (Object.values(SAMPLE_SEAT_PREFIXES).includes(p)) throw new Error(`seatPrefix ${p} belongs to a sample show`);
    out.seatPrefix = p;
  }
  return out;
};

/** The shows.json fields for a show object: the call fields of a real (or proof) show, nothing for samples. */
export const eventFieldsToJson = (show) => {
  if (SAMPLE_SEAT_PREFIXES[show.kind] !== undefined) return {};
  const out = {};
  if (present(show.eventAt)) out.eventAt = show.eventAt;
  if (present(show.durationMin)) out.durationMin = show.durationMin;
  if (present(show.seatPrefix) && (show.kind === 'real' || show.seatPrefix !== PROOF_SEAT_PREFIX)) out.seatPrefix = show.seatPrefix;
  return out;
};

/** Seat letters a file may use only once: those of real shows (and proof shows that name one). */
export const ownsSeatPrefix = (kind, raw) => kind === 'real' || (kind === 'proof' && present(raw?.seatPrefix));
