// Text helpers the site and the screening room share. Plain functions with no
// imports, so the room (app/src/room/) can use them without pulling in
// libauth or any chain code. app/src/lib/view.js re-exports them.

/** A txid as the page writes it everywhere: "993c586a…c10a" (8 and 4 characters, an ellipsis). */
export const shortId = (txid) => (txid.length <= 15 ? txid : `${txid.slice(0, 8)}…${txid.slice(-4)}`);

/** How long until `minutes` from now: "in 40 min", "in 5 h 50 min", "in 3 days", "now". */
export const etaMinutes = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes)));
  if (total === 0) return 'now';
  if (total < 60) return `in ${total} min`;
  if (total < 48 * 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  return `in ${Math.round(total / (24 * 60))} days`;
};

/**
 * "Tue 24 Nov, 21:00 GMT+8": always English (the page is English), in the
 * reader's own time zone, with the zone named. Built from parts so no
 * browser locale can mix in its own words ("上午06:06").
 */
export const clockText = (date, { timeZone } = {}) => {
  const parts = {};
  try {
    const format = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
      ...(timeZone && { timeZone }),
    });
    for (const p of format.formatToParts(date)) parts[p.type] = p.value;
  } catch {
    // An engine without shortOffset: UTC, named as such.
    return `${date.toUTCString().slice(0, 11).replace(',', '')}, ${date.toISOString().slice(11, 16)} UTC`;
  }
  // A non-breaking hyphen in "GMT‑5", so a line never breaks inside the zone.
  const zone = (parts.timeZoneName ?? 'UTC').replace(/^GMT$|^GMT\+0$|^UTC$/, 'UTC').replace('-', '‑');
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${zone}`;
};
