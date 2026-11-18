// The screening room's answer picker (worker/lib/room-match.js) over the
// written FAQ (worker/lib/room-faq.js): every regression case in
// faq-cases.js through decide() (and again with the answers still hidden
// shown), the hard filter, the narrow topics, chips,
// the money rule, the gate that keeps answers hidden while a CLAIMS item
// they cite is marked not deployed or not built, and CLAIMS.md section 11,
// which must hold every heading and answer word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CASES } from './faq-cases.js';
import { ROOM_FAQ } from '../worker/lib/room-faq.js';
import { SENTENCES } from '../app/src/lib/copy.js';
import { chipAnswer, decide, hardSecret, movesMoney, normalise, topicRefusal, MAX_QUESTION_CHARS } from '../worker/lib/room-match.js';

const byId = new Map(ROOM_FAQ.entries.map((e) => [e.id, e]));
const ids = (r) => r.answers.map((a) => a.id).join(',');

/** Every answer is a stored entry, word for word, and at most two. */
const wellFormed = (r, q) => {
  assert.ok(['match', 'refusal', 'fallback'].includes(r.via), q);
  assert.ok(r.answers.length >= 1 && r.answers.length <= 2, `${q}: ${r.answers.length} answers`);
  if (r.via !== 'match') assert.equal(r.answers.length, 1, q);
  for (const a of r.answers) {
    const e = byId.get(a.id);
    assert.ok(e !== undefined && e.botOk === true, `${q}: ${a.id} is a botOk entry`);
    assert.deepEqual(a, { id: e.id, q: e.q, a: e.answer }, `${q}: ${a.id} is shown word for word`);
  }
};

test('room FAQ: every match, refuse and fallback case in faq-cases.js gets its answer through decide()', () => {
  const misses = [];
  for (const c of CASES.match) {
    const r = decide(c.q, ROOM_FAQ);
    wellFormed(r, c.q);
    if (r.via !== 'match' || r.answers[0].id !== c.id) misses.push(`match "${c.q}" -> ${r.via} ${ids(r)} (want ${c.id})`);
  }
  for (const c of CASES.refuse) {
    const r = decide(c.q, ROOM_FAQ);
    wellFormed(r, c.q);
    if (r.via !== 'refusal' || r.answers[0].id !== `refusal-${c.kind}`) misses.push(`refuse "${c.q}" -> ${r.via} ${ids(r)} (want refusal-${c.kind})`);
  }
  for (const q of CASES.fallback) {
    const r = decide(q, ROOM_FAQ);
    wellFormed(r, q);
    if (r.via !== 'fallback' || r.answers[0].id !== 'fallback') misses.push(`fallback "${q}" -> ${r.via} ${ids(r)}`);
  }
  assert.deepEqual(misses, [], `${misses.length} of ${CASES.match.length + CASES.refuse.length + CASES.fallback.length} cases missed`);
  assert.ok(CASES.match.length >= 175 && CASES.refuse.length >= 27 && CASES.fallback.length >= 12, 'the case list was not cut');
});

test('room FAQ with the hidden answers shown: the launch answers are shown, and showing the rest takes no match case', () => {
  // Shown since launch (18 Nov 2026), with the questions that waited for them now in CASES.match.
  for (const id of ['who-sends-refund', 'try-on-mainnet', 'sample-b-speed']) assert.equal(byId.get(id)?.botOk, true, `${id} is shown`);
  assert.equal(CASES.launch, undefined, 'no launch list is left');
  // What is still hidden (narration-voice waits for the locked film, LAUNCH-RUNBOOK E6) must not take a match case once shown.
  const hidden = new Set(ROOM_FAQ.entries.filter((e) => e.botOk === false).map((e) => e.id));
  const shown = { ...ROOM_FAQ, entries: ROOM_FAQ.entries.map((e) => (hidden.has(e.id) ? { ...e, botOk: true } : e)) };
  const misses = [];
  for (const c of CASES.match) {
    const r = decide(c.q, shown);
    if (r.via !== 'match' || r.answers[0].id !== c.id) misses.push(`with ${[...hidden].join(', ')} shown, match "${c.q}" -> ${r.via} ${ids(r)} (want ${c.id})`);
  }
  assert.deepEqual(misses, []);
});

test('room FAQ: an answer that moves money is shown only alone; a second answer never moves money', () => {
  const extra = ['How do refunds work?', 'What about a refund if the screening is cancelled?', 'show me the code', 'video is lagging', 'Can I cancel my ticket?'];
  for (const q of [...CASES.match.map((c) => c.q), ...extra]) {
    const r = decide(q, ROOM_FAQ);
    if (r.answers.length === 2) for (const a of r.answers) assert.ok(!movesMoney(byId.get(a.id)), `${q}: ${a.id} moves money but shares the reply`);
  }
  // Two money entries that tie: no clear win, so the fallback. Two plain entries that tie: both.
  const entry = (id, kind, answer, topic, extra = {}) => ({ id, kind, q: `${id}?`, questions: [topic, `${topic} again`, `more ${topic}`], keywords: [topic], answer, sources: ['test'], botOk: true, ...extra });
  const faq = {
    entries: [
      entry('alpha-one', 'faq', 'A ticket nobody uses refunds after the show.', 'zebra crossing'),
      entry('alpha-two', 'faq', 'Settle sends it back.', 'zebra crossing'),
      entry('beta-one', 'faq', 'Plain words.', 'yak shaving'),
      entry('beta-two', 'faq', 'Other plain words.', 'yak shaving'),
      entry('gamma', 'faq', 'It refunds.', 'quokka island'),
      entry('hidden', 'faq', 'Not shown.', 'quokka island', { botOk: false }),
      entry('delta', 'room', 'Plain.', 'otter pond'),
      entry('refusal-secret', 'refusal', 'x', 'x'),
      entry('refusal-demand', 'refusal', 'x', 'x'),
      entry('refusal-price', 'refusal', 'x', 'x'),
      entry('refusal-seed', 'refusal', 'x', 'x'),
      entry('refusal-complaint', 'refusal', 'x', 'x'),
      entry('fallback', 'fallback', 'x', 'x'),
    ],
  };
  assert.equal(decide('zebra crossing', faq).via, 'fallback', 'a money entry needs a clear win');
  assert.deepEqual(ids(decide('yak shaving', faq)), 'beta-one,beta-two');
  assert.deepEqual(ids(decide('quokka island', faq)), 'gamma', 'a botOk false entry is never matched, so gamma wins clearly');
});

test('room FAQ: hard filter (secrets and demands) runs first, after NFKC and with invisible characters removed', () => {
  const zw = String.fromCharCode(0x200b);
  const rlo = String.fromCharCode(0x202e);
  const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
  assert.equal(hardSecret(words.join(' ')), 'refusal-secret');
  assert.equal(hardSecret(words.join(` ${zw}`)), 'refusal-secret', 'zero-width characters between the words');
  assert.equal(hardSecret(words.map((w, i) => `${i + 1}. ${w}`).join('\n')), 'refusal-secret', 'a numbered list');
  assert.equal(hardSecret(words.slice(0, 11).join(' ')), null, '11 words are not a seed phrase');
  assert.equal(hardSecret(`${'about '.repeat(11)}the ${'about '.repeat(11)}`), null, 'any other word breaks the run');
  const wif = 'L6jW5W9yJS3C4YjPk31w1EFnjeydUxtkNQkRU9Tn7rR1mDACE1XR';
  assert.equal(hardSecret(`key: ${wif.slice(0, 20)}${zw}${wif.slice(20)}`), 'refusal-secret', 'a WIF split by a zero-width space');
  assert.equal(hardSecret(`${rlo}${wif}`), 'refusal-secret');
  assert.equal(hardSecret('bitcoincash:pvqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'), null, 'an address is not a WIF');
  const fullwidthHex = Array.from('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  assert.equal(hardSecret(fullwidthHex), 'refusal-secret', 'full-width hex (NFKC)');
  assert.equal(hardSecret('xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'), 'refusal-secret');
  for (const q of ['send me 1 BCH', 'DM me', 'refund me', 'give me my money', 'confirm my refund', 'approve the refund', 'promise a refund']) {
    assert.equal(hardSecret(q), 'refusal-demand', q);
  }
  for (const q of ['Can I send my ticket to a friend?', 'Give me a quick overview of this project', 'Who sends the refund?', 'Can I get a refund?']) assert.equal(hardSecret(q), null, q);
});

test('room FAQ: market price and seed topics refuse before matching; "price", "refund" and "private key" alone do not', () => {
  for (const q of ['price', 'refund', 'private key', "What's the ticket price?", 'Which private key does the worker hold?', 'Is there a Doorstub token?']) {
    assert.equal(topicRefusal(normalise(q)), null, q);
    // "refund" alone is never refused, but since launch three written answers are about refunds (refund-screening,
    // sample-b-speed, who-sends-refund), and one that moves money is shown only on a clear win: it may get the fallback.
    if (q === 'refund') assert.ok(['match', 'fallback'].includes(decide(q, ROOM_FAQ).via), q);
    else assert.equal(decide(q, ROOM_FAQ).via, 'match', q);
  }
  // The refusal entries' keywords are their trigger phrases: each one, asked alone, still gets its refusal.
  for (const id of ['refusal-price', 'refusal-seed', 'refusal-demand', 'refusal-complaint']) {
    const e = byId.get(id);
    for (const k of [...e.keywords, ...e.questions]) assert.deepEqual(ids(decide(k, ROOM_FAQ)), id, `"${k}" -> ${id}`);
  }
  // A complaint about something a help entry covers gets the help entry.
  assert.equal(ids(decide('no sound, this is terrible', ROOM_FAQ)), 'room-sound');
  assert.equal(ids(decide('Terrible experience, I am really angry', ROOM_FAQ)), 'refusal-complaint');
});

test('room FAQ: normalise (NFKC, invisible characters, 300 characters) and chips', () => {
  const zw = String.fromCharCode(0x200b, 0x200d, 0x2066, 0xfeff);
  assert.equal(normalise(`  ${zw}What${zw} is Doorstub?  `), 'What is Doorstub?');
  assert.equal(normalise(String.fromCharCode(0xff37, 0xff48, 0xff41, 0xff54)), 'What', 'full-width letters');
  assert.equal(Array.from(normalise('x'.repeat(1_000))).length, MAX_QUESTION_CHARS);
  assert.equal(normalise(42), '');
  assert.equal(decide('', ROOM_FAQ).via, 'fallback');
  assert.equal(decide(undefined, ROOM_FAQ).via, 'fallback');
  assert.equal(ids(decide(`What${zw} is Doorstub?`, ROOM_FAQ)), 'what-is-doorstub');

  const chips = ROOM_FAQ.entries.filter((e) => e.chip);
  assert.ok(chips.length >= 4 && chips.length <= 6);
  for (const e of chips) assert.deepEqual(chipAnswer(e.id, ROOM_FAQ), { via: 'chip', answers: [{ id: e.id, q: e.q, a: e.answer }] });
  assert.equal(chipAnswer('what-is-doorstub', ROOM_FAQ), null, 'not a chip');
  assert.equal(chipAnswer('refusal-secret', ROOM_FAQ), null);
  assert.equal(chipAnswer('no-such-entry', ROOM_FAQ), null);
});

test('room-match.js imports nothing, uses no Node or browser API, and never logs', () => {
  const source = readFileSync(new URL('../worker/lib/room-match.js', import.meta.url), 'utf8');
  const code = source
    .replace(/const BIP39_ENGLISH = `[^`]*`;/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '');
  assert.ok(code.length < source.length / 2, 'the word list was cut out before the scan');
  assert.doesNotMatch(code, /\bimport\b|\brequire\s*\(/, 'no imports');
  assert.doesNotMatch(code, /\b(?:console|process|globalThis|window|document|localStorage|fetch|Buffer|setTimeout)\b/, 'no runtime APIs');
  assert.doesNotMatch(code, /\(\?<[=!]/, 'no lookbehind (older iOS Safari cannot parse it)');
  assert.match(source, /^[\x09\x0a\x0d\x20-\x7e]*$/, 'ASCII only (invisible characters are written as escapes)');
  const faqSource = readFileSync(new URL('../worker/lib/room-faq.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(faqSource, /\bimport\b/, 'room-faq.js is plain data');
});

// ---- the gate (SPEC-ROOM v2.1 A2): resolve each CLAIMS source item by item.
const claims = readFileSync(new URL('../CLAIMS.md', import.meta.url), 'utf8');
const MARK = /\([^()]*\bnot (?:deployed|built) yet\b[^()]*\)|\(draft\)/i;
const section = (n) => {
  const start = claims.indexOf(`\n## ${n}.`);
  if (start < 0) return null;
  const next = claims.indexOf('\n## ', start + 4);
  return claims.slice(start, next < 0 ? undefined : next);
};
const lines = (n) => section(n)?.split('\n') ?? [];
const SIX = { 'sample A': '- Sample show A', 'sample B': '- Sample show B', 'real shows': '- Real shows', 'Walk in on samples': '**Walk in on samples:**', BCMR: '**Wallet metadata (BCMR).**' };

/** The text of one CLAIMS item, or undefined when the reference does not resolve. */
const item = (ref) => {
  let m;
  if ((m = /^C(\d+)$/.exec(ref))) return lines(2).find((l) => l.startsWith(`| C${m[1]} |`));
  if ((m = /^limit (\d+)$/.exec(ref))) return lines(4).find((l) => l.startsWith(`${m[1]}. **`));
  if (ref === '§1 headline') return lines(1).find((l) => l.startsWith('> '));
  if ((m = /^§1 rule (\d+)$/.exec(ref))) return lines(1).find((l) => l.startsWith(`${m[1]}. `));
  if ((m = /^§1 small print (\d+)$/.exec(ref))) return lines(1).filter((l) => l.startsWith('- '))[Number(m[1]) - 1];
  if ((m = /^§3 (.+)$/.exec(ref))) return lines(3).find((l) => l.toLowerCase().includes(m[1].toLowerCase()));
  if (ref === '§5' || ref === '§8') return section(ref.slice(1)) ?? undefined;
  if ((m = /^§6 (.+)$/.exec(ref))) return SIX[m[1]] === undefined ? undefined : lines(6).find((l) => l.startsWith(SIX[m[1]]));
  if ((m = /^§7 (.+)$/.exec(ref))) return lines(7).find((l) => l.startsWith(`| ${m[1]} |`));
  if (ref === '§9.5a') return lines(9).find((l) => l.includes('Doorstub takes no fee today'));
  if (ref === '§9.7') {
    const s9 = section(9) ?? '';
    return s9.includes('### 9.7') ? s9.slice(s9.indexOf('### 9.7')) : undefined;
  }
  if ((m = /^§9\.\d+a? (\w+)$/.exec(ref))) {
    const text = SENTENCES[m[1]];
    if (text === undefined) return undefined;
    return lines(9).find((l) => l.includes(`\`${text}\``)) ?? `(copy key ${m[1]} not in section 9 yet)`;
  }
  if (/^§10 /.test(ref)) return section(10) ?? undefined;
  if ((m = /^§11 (.+)$/.exec(ref))) {
    if (section(11) === null) return '(section 11 not in CLAIMS yet)';
    return lines(11).find((l) => l.includes(m[1])) ?? lines(11)[1];
  }
  return undefined;
};

test('room FAQ gate: an entry citing a CLAIMS item marked "(not deployed yet)", "(not built yet)" or "(draft)" is botOk false', () => {
  assert.ok(MARK.test('Sample B (not deployed yet): signer') && MARK.test('(draft)') && !MARK.test('Plan, not built yet: a fee'), 'only a parenthetical marker counts');
  const unresolved = [];
  const open = [];
  for (const e of ROOM_FAQ.entries) {
    for (const source of e.sources.filter((s) => s.startsWith('CLAIMS '))) {
      const text = item(source.slice('CLAIMS '.length));
      if (text === undefined) unresolved.push(`${e.id}: ${source}`);
      else if (MARK.test(text) && e.botOk) open.push(`${e.id}: ${source}`);
    }
  }
  assert.deepEqual(unresolved, [], 'every CLAIMS source names an item');
  assert.deepEqual(open, [], 'answers that cite a marked item stay hidden');

  // The other way round: an answer hidden while none of its CLAIMS sources is marked any more must name what
  // it still waits for here. So when a marker goes (as the launch markers did on 18 Nov 2026), this fails until
  // the answers it hid are shown again (botOk true, section 11 regenerated, redeployed). Only the film's wait is left.
  const WAITS = { 'narration-voice': 'the end credits of the locked film (LAUNCH-RUNBOOK E6)' };
  const stale = ROOM_FAQ.entries
    .filter((e) => e.botOk === false && WAITS[e.id] === undefined)
    .filter((e) => !e.sources.filter((s) => s.startsWith('CLAIMS ')).some((s) => MARK.test(item(s.slice('CLAIMS '.length)) ?? '')))
    .map((e) => e.id);
  assert.deepEqual(stale, [], 'hidden, but no CLAIMS source is marked any more: set botOk true and regenerate section 11, or name the wait in WAITS');
  assert.deepEqual(Object.keys(WAITS).filter((id) => byId.get(id)?.botOk !== false), [], 'every wait in WAITS is an answer still hidden');
});

test('room answers: every heading and answer is in CLAIMS.md section 11 word for word, with no word section 3 rules out, no "live" and no first person', () => {
  const eleven = section(11);
  assert.ok(eleven !== null, 'CLAIMS.md has a section 11');
  const missing = ROOM_FAQ.entries.filter((e) => !eleven.includes(`\`${e.q}\` \`${e.answer}\``)).map((e) => e.id);
  assert.deepEqual(missing, [], 'regenerate CLAIMS.md section 11 from worker/lib/room-faq.js');
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
    [/\blive\b/i, 'live'],
    [/will answer|reads every question|good question/i, 'a promise to answer'],
    [/\bI\b|\bI['’](?:m|ve|ll|d)\b/, 'first person'],
    [/\b(?:me|my|mine|myself|we|our|ours|us|ourselves)\b/i, 'first person'],
  ];
  // The secret refusal's "move your coins to a new wallet" is advice, not a claim about Doorstub.
  const exempt = { 'refusal-secret': 'new' };
  for (const e of ROOM_FAQ.entries) {
    for (const text of [e.q, e.answer]) {
      for (const [re, word] of banned) if (exempt[e.id] !== word) assert.doesNotMatch(text, re, `${e.id} uses "${word}": ${text}`);
    }
  }
});

test('room FAQ sources: every repo file a source names exists, and every name after a .js file is in it', () => {
  const missing = [];
  for (const e of ROOM_FAQ.entries) {
    for (const source of e.sources) {
      const [path, ...names] = source.split(' ');
      // CLAIMS items are the gate's job; "film end card (...)" is not a file.
      if (source.startsWith('CLAIMS ') || !/[./]/.test(path)) continue;
      const url = new URL(`../${path}`, import.meta.url);
      if (!existsSync(url)) {
        missing.push(`${e.id}: ${path} does not exist`);
        continue;
      }
      if (path.endsWith('/')) continue;
      const text = readFileSync(url, 'utf8');
      if (!path.endsWith('.js')) continue;
      for (const name of names.filter((n) => /^[A-Za-z_]\w*$/.test(n))) {
        if (!new RegExp(`\\b${name}\\b`).test(text)) missing.push(`${e.id}: ${path} has no ${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
