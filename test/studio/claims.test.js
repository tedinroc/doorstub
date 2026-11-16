// The studio writes public text into shows.json and the BCMR registries: card
// texts, titles, subtitles, and the wallet's field names and descriptions.
// Each must be in CLAIMS.md word for word (cards, titles and subtitles in
// section 6, as the site's own sentences are in section 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARDS, buildRegistry, makePlan } from '../../studio/index.js';
import { HEADLINE, MARKER_DESCRIPTION, TICKET_DESCRIPTION } from '../../studio/lib/bcmr.js';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';
import { freshKey } from '../helpers.js';
import { addressOf, repoRoot } from '../simnet/support.js';

const claims = readFileSync(join(repoRoot, 'CLAIMS.md'), 'utf8');
const section = (n) => {
  const start = claims.indexOf(`\n## ${n}.`);
  const next = claims.indexOf('\n## ', start + 4);
  assert.ok(start >= 0, `CLAIMS.md has a section ${n}`);
  return claims.slice(start, next < 0 ? undefined : next);
};

const studio = {
  salesPk: `02${'11'.repeat(32)}`,
  dataPk: `03${'22'.repeat(32)}`,
  realDataPk: `02${'33'.repeat(32)}`,
};
const PAYEE = addressOf(p2pkhLockingBytecode(freshKey().pkh), false);
const screenings = JSON.parse(readFileSync(join(repoRoot, 'studio', 'screenings.example.json'), 'utf8'));

/** Every show the studio plans by default, plus the two planned screenings. */
const plannedShows = () =>
  makePlan({ network: 'mainnet', tip: 977_577, now: new Date('2026-11-16T06:28:00Z'), studio, payee: PAYEE, firstStart: '+36', count: 2, schedule: screenings }).shows;

test('every studio card text, title and subtitle is in CLAIMS.md section 6, word for word', () => {
  const six = section(6);
  const shows = plannedShows();
  assert.deepEqual(shows.map((s) => s.kind), ['sample-settle', 'sample-settle', 'sample-refund-seat', 'real', 'real']);
  for (const card of Object.values(CARDS)) assert.ok(six.includes(card), `CARDS: ${card}`);
  for (const show of shows) {
    for (const field of ['card', 'title', 'subtitle']) {
      if (show[field] === '') continue;
      assert.ok(six.includes(show[field]), `${show.id} ${field} is not in CLAIMS.md section 6: ${show[field]}`);
    }
  }
  assert.deepEqual([...new Set(shows.map((s) => s.subtitle))], ['', 'Online, 25 minutes'], 'samples have no subtitle; the screenings name no time');
});

test('every text a wallet shows from a BCMR registry is in CLAIMS.md', () => {
  for (const entry of plannedShows()) {
    const category = 'ab'.repeat(32);
    const snapshot = Object.values(buildRegistry({ origin: 'https://doorstub.pages.dev', category, entry, revision: '2026-11-16T06:28:00.000Z' }).identities[category])[0];
    assert.equal(snapshot.name, `Doorstub ticket: ${entry.title}`);
    assert.equal(snapshot.description, `${HEADLINE} ${entry.card}`);
    assert.ok(section(1).includes(`> ${HEADLINE}`));
    assert.ok(section(2).includes(`| ${TICKET_DESCRIPTION} |`), 'the ticket description is C1');
    assert.ok(section(6).includes(`"${MARKER_DESCRIPTION}"`));
    for (const field of Object.values(snapshot.token.nfts.fields)) {
      assert.ok(section(6).includes(`- "${field.name}": "${field.description}"`), `BCMR field ${field.name} is listed in section 6 word for word`);
    }
  }
});
