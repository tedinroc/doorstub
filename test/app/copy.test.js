// Every public sentence the site shows comes from CLAIMS.md (section 9 lists
// each one word for word, with the rule that makes it true), uses none of the
// words CLAIMS.md section 3 rules out, and the prior-art lines are section 5's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LABELS, PRIOR_ART, SENTENCES, fill, say } from '../../app/src/lib/copy.js';
import { CARDS } from '../../studio/index.js';

const claims = readFileSync(new URL('../../CLAIMS.md', import.meta.url), 'utf8');
const section = (n) => {
  const start = claims.indexOf(`\n## ${n}.`);
  const next = claims.indexOf('\n## ', start + 4);
  assert.ok(start >= 0, `CLAIMS.md has a section ${n}`);
  return claims.slice(start, next < 0 ? undefined : next);
};

test('every site sentence is in CLAIMS.md section 9, word for word', () => {
  const site = section(9);
  const missing = Object.entries(SENTENCES).filter(([, text]) => !site.includes(`\`${text}\``));
  assert.deepEqual(missing, [], `add these to CLAIMS.md section 9 (or drop them):\n${missing.map(([k, t]) => `${k}: ${t}`).join('\n')}`);
});

test('no site sentence uses a word CLAIMS.md section 3 rules out', () => {
  const banned = [
    [/\bthe first\b|\bfirst (?:to|ever|of its kind)\b/i, 'first'],
    [/\bnew\b/i, 'new'],
    [/\bthe only\b/i, 'the only'],
    [/never been done/i, 'never been done'],
    [/full refund/i, 'full refund'],
    [/before the show/i, 'before the show'],
    [/back on sale/i, 'your seat goes back on sale'],
    [/automatic/i, 'automatic'],
    [/trustless/i, 'trustless entry'],
    [/\bguarantee/i, 'a promise of entry'],
  ];
  // Two sentences quote a ruled-out phrase to deny it, exactly as CLAIMS.md does.
  const quoting = { priorArtIntro: 'new', limitBefore: 'before the show' };
  const all = [...Object.entries(SENTENCES), ...Object.entries(LABELS)];
  for (const [key, text] of all) {
    for (const [re, word] of banned) {
      if (quoting[key] === word) continue;
      assert.doesNotMatch(text, re, `${key} uses "${word}": ${text}`);
    }
  }
  assert.ok(section(3).includes('"Before the show."'));
});

test('the prior-art credits are CLAIMS.md section 5, word for word', () => {
  const prior = section(5);
  for (const [name, text] of PRIOR_ART) assert.ok(prior.includes(`- **${name}** ${text}`), `${name} differs from CLAIMS.md section 5`);
  const listed = [...prior.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(PRIOR_ART.map(([n]) => n), listed, 'every project of section 5 is credited, in order');
});

test('the headline, the card texts and the claim lines match their CLAIMS.md sections', () => {
  assert.ok(section(1).includes(`> ${SENTENCES.headline} ${SENTENCES.subline}`));
  for (const card of Object.values(CARDS)) assert.ok(section(6).includes(card), 'card texts come from section 6');
  const table = section(2);
  for (const key of ['ticketMoney', 'howWalkIn', 'howSettle', 'ticketHandBack', 'ticketNft', 'howOnlyBuyer', 'checkTests', 'walletLine']) {
    assert.ok(table.includes(`| ${SENTENCES[key]} |`), `${key} is claim ${key} of section 2 word for word`);
  }
  assert.ok(table.includes(fill('| The organiser\'s key can refund your money. It can never send it anywhere else; at most N sats of your ticket can go to the network fee. |')));
  assert.equal(say('howRefund', { cap: 'N' }), "The organiser's key can refund your money. It can never send it anywhere else; at most N sats of your ticket can go to the network fee.");
  assert.ok(section(8).includes(SENTENCES.aiCredit));
});

test('fill leaves an unknown slot visible so a missing value is noticed', () => {
  assert.equal(fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
  assert.throws(() => say('no-such-key'), /no sentence/);
});
