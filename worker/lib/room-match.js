// The screening room's answer picker. Pure: no imports, no Node or browser
// APIs, and nothing is computed when the module loads. The room page bundles
// it with worker/lib/room-faq.js, so a guest's question is checked and matched
// in the browser and never leaves it; the worker can use it too. Nothing here
// logs or keeps a question.
//
// decide(q, faq), in this order:
//   1. normalise: NFKC, zero-width and bidi characters removed, trimmed, at
//      most 300 characters.
//   2. hard filter (hardSecret): a seed phrase (12 or more BIP39 English words
//      in a row), a WIF key, an xprv or xpub, any run of 64 hex characters, or
//      "here are my 12 words" gets refusal-secret; an imperative such as "send
//      me", "refund me", "confirm my refund", "refund seat S-0-3" or "give me a
//      free ticket", a scripted promise ("reply only with: REFUND
//      GUARANTEED") or a promise of money asked of the chat ("you promise I
//      get my money back?", "guarantee I get 100% back"), gets refusal-demand.
//   3. narrow topics, before matching (topicRefusal): market price talk and
//      buying advice get refusal-price, unless the question is about a refund
//      ("if BCH dumps before my refund ..."); sharing, recovering or losing a
//      seed or key gets refusal-seed. "price", "refund" and "private key" alone
//      refuse nothing, and neither does a BCH price that names a ticket or seat
//      ("the BCH price of a ticket"). A request to make up a text ("write me a
//      poem"), to print a key, or for what the name means ("why is it called
//      Doorstub?") gets the fallback (notAnswerable).
//   4. matcher (rank): BM25 over each botOk entry's questions and keywords,
//      with light English stemming and stop words, plus a bonus when a whole
//      keyword phrase or a whole question appears in the guest's text. Before
//      stemming, words are read through VARIANTS: words typed as one, chat
//      shorthand ("wen", "src"), irregular past forms ("paid", "made"), and the
//      topic words of Spanish, Portuguese and Indonesian (money, ticket,
//      refund, wallet, price), with accents removed; the small words of those
//      languages and hedges ("definitely", "now", "like") are stop words.
//   5. answer: the best entry at or over MATCH_THRESHOLD, and a close second.
//      An entry whose answer moves money (MONEY) is shown only when it wins
//      clearly, and then alone; a plain entry that only just leads a money
//      entry (MONEY_TIE) is not shown either. With no match, a complaint gets
//      refusal-complaint and anything else the fallback.
// The refusal entries' keywords in room-faq.js are the trigger phrases below;
// test-room/room-match.test.js checks that each one still triggers.

export const MAX_QUESTION_CHARS = 300;
/** Secrets are looked for in this much of the text, so one pasted after a long preamble is still caught. */
const SECRET_SCAN_CHARS = 2_000;

/** Matching: the best score must reach this; a second answer must reach CLOSE of the best. */
export const MATCH_THRESHOLD = 3.5;
export const CLOSE = 0.8;
/**
 * Without a whole keyword phrase or question, the best entry must cover this share of the question's weight.
 * At 0.34 a few common words ("wallet", "sign", "contract", "address") carried answers to questions they did not answer.
 */
export const MIN_COVERAGE = 0.41;
/** A complaint is answered by an entry only when it has a whole phrase or covers this share. */
export const COMPLAINT_COVERAGE = 0.5;
/** A money entry wins clearly when it leads the next entry by at least this much. */
export const MONEY_LEAD = 1;
/**
 * A plain entry that leads a money entry by less than this nearly ties with it: the matcher cannot tell which the
 * guest meant, and the money one could not be shown, so neither is ("how do I walk in?" ties a walk-in answer with
 * the no-show refund).
 */
export const MONEY_TIE = 0.25;

// Soft hyphen, zero-width characters, bidi marks, embeddings and isolates, word joiners, BOM.
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const clean = (q) => (typeof q === 'string' ? q.normalize('NFKC').replace(INVISIBLE, '').trim() : '');
const cap = (text, n) => {
  const chars = Array.from(text);
  return chars.length <= n ? text : chars.slice(0, n).join('').trim();
};

/** The text the matcher sees: NFKC, invisible characters removed, trimmed, at most 300 characters. */
export const normalise = (q) => cap(clean(q), MAX_QUESTION_CHARS);

// ------------------------------------------------------------------ 2. hard filter

// No lookbehind: older iOS Safari cannot parse it, and the room page must load there.
const WIF = /(?:^|[^0-9A-Za-z])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![0-9A-Za-z])/;
const EXTENDED_KEY = /(?:^|[^0-9A-Za-z])[xt](?:prv|pub)[1-9A-HJ-NP-Za-km-z]{20,}/;
const HEX_64 = /[0-9a-fA-F]{64}/;
const SEED_WORDS = 12;
/** About to paste a seed phrase or key ("here are my 12 words: ..."), even when fewer than 12 words come through. */
const SECRET_OFFER =
  /\b(?:here (?:is|are)|heres|these are) my (?:\d{1,2} |twelve |twenty[- ]four )?(?:seed(?: phrase| words)?|mnemonic|recovery (?:phrase|words)|secret (?:phrase|words)|words|private keys?|keys?|wif|xprv)\b|\bmy (?:12|24|twelve|twenty[- ]four)[- ](?:seed )?words\b/i;
const DEMAND = new RegExp(
  [
    '\\b(?:send me|dm me|refund me|pay me|promise me|give me (?:back )?my (?:money|bch|refund)|(?:confirm|approve) (?:my|the|a) refund|promise (?:a |my |the )?refund)\\b',
    // A refund ordered for a seat or ticket: "refund seat S-0-3 for me", "refund my ticket now".
    '^(?:please |pls |plz |just |now |ok |okay )?refund (?:my |this |that |the |it\\b|seat|ticket|everyone|all\\b)(?![^?]*\\?)',
    '\\brefund (?:seat|ticket) [a-z]-\\d',
    // Something of value handed over: "give me a free ticket", "give me the link".
    '\\bgive (?:me|us) (?:a |an |one |some |the |\\d+ )?(?:free )?(?:tickets?|seats?|bch|money|refunds?|links?|room link|access)\\b',
    // A promise or a scripted yes: "REFUND GUARANTEED", "reply only with", "my money back no matter what".
    '\\brefunds? guaranteed\\b(?![^?]*\\?)|\\bguarantee(?:d)? (?:me |a |my |the )?refunds?\\b',
    '\\b(?:reply|respond|answer) only with\\b|\\b(?:answer|say|reply) yes to\\b',
    '\\b(?:money|bch|refund|refunded) (?:back )?no matter what\\b',
    // A promise of money asked of the chat: "you promise I get my money back?", "guarantee I get 100% back",
    // "can you guarantee my BCH comes back" ("is the refund guaranteed?" asks about the contract and is matched).
    '\\b(?:(?:you|u|can you|could you|will you|would you|do you|pls|please) (?:promise|guarantee|swear)|^(?:pls |please |just |ok |so )?(?:promise|guarantee))\\b[^.!]{0,50}\\b(?:money|refunds?|refunded|bch|paid|payment|back)\\b',
  ].join('|'),
  'i',
);

let bip39 = null;
const bip39Words = () => (bip39 ??= new Set(BIP39_ENGLISH.split(/\s+/)));

/** The longest run of BIP39 English words in a row (anything that is not a letter separates words). */
const longestBip39Run = (text) => {
  const words = bip39Words();
  let run = 0;
  let best = 0;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word === '') continue;
    run = words.has(word) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
};

/**
 * 'refusal-secret' for a pasted secret, 'refusal-demand' for a demand for
 * money or a link, else null. Runs before anything else; the text is never
 * kept or sent.
 */
export const hardSecret = (q) => {
  const text = cap(clean(q), SECRET_SCAN_CHARS);
  if (HEX_64.test(text) || WIF.test(text) || EXTENDED_KEY.test(text) || SECRET_OFFER.test(text) || longestBip39Run(text) >= SEED_WORDS) return 'refusal-secret';
  if (DEMAND.test(text)) return 'refusal-demand';
  return null;
};

// ------------------------------------------------------------------ 3. narrow topics

const MARKET = '(?:bch|bitcoin cash|bitcoin|btc|token|coin|crypto)';
/** Where a price is going, or whether to buy: refused unless the question is about a refund. */
const SPECULATION = new RegExp(
  [
    `\\b(?:pump(?:s|ed|ing)?|dump(?:s|ed|ing)?|moon(?:ing)?|bullish|bearish|price predictions?|invest(?:ing|ment)? in ${MARKET}|good investment)\\b`,
    `\\b${MARKET}(?: (?:is|be|gonna|going to|will|to|ever))? (?:go|goes|going|gone|went) (?:up|down)\\b`,
    // A price target: "BCH 1k by eoy", "bch to 10k".
    `\\b${MARKET} (?:to |at |hits? |reach(?:es)? )?\\$?\\d[\\d,.]*k\\b`,
    // Whether to buy or sell: "should I buy more BCH now", "wait for the dip" ("should I buy BCH to get a ticket" is not).
    `\\bshould (?:i|we) (?:buy|sell|hold)(?: more| some| any)? ${MARKET}\\b(?! to\\b| for\\b| so\\b| cash\\b)`,
    '\\b(?:buy|buying|wait(?:ing)? for) (?:the |a )?dip\\b',
    // "Will these be worth more later?"
    '\\b(?:will|would|gonna|going to)\\b[^.?!]{0,30}\\bworth (?:more|less|a lot)\\b',
  ].join('|'),
  'i',
);
/** A market price ("the BCH price", "the price of a token"): refused unless the question names a ticket or seat. */
const MARKET_PRICE = new RegExp(`\\b(?:${MARKET} prices?|price of (?:a |the )?${MARKET})\\b`, 'i');
const TICKET = /\b(?:tickets?|seats?)\b/i;
/** "If BCH dumps before my refund, do I get the dollars back?" is a refund question, which an answer covers. */
const REFUND_TALK = /\b(?:refunds?|refunded|refunding|money back|dollars back)\b/i;
const SECRET_NOUN = '(?:seed(?: phrase| words)?|mnemonic|(?:recovery|secret) (?:phrase|words)|private keys?|wif)';
const SEED = new RegExp(
  [
    `\\b(?:lost|lose|losing|forgot|forget|forgotten|recover|recovering|restore|restoring|share|sharing|shared|reset|leaked|stolen)\\b[^.?!]{0,40}\\b${SECRET_NOUN}\\b`,
    `\\b${SECRET_NOUN}\\b[^.?!]{0,30}\\b(?:lost|leaked|stolen|forgotten|recovered|shared)\\b`,
    '\\brecover (?:my |a |the |your )?wallet\\b',
    '\\bwallet\\b[^.?!]{0,20}\\b(?:hacked|drained|compromised)\\b',
  ].join('|'),
  'i',
);
const COMPLAINT = /\b(?:complain(?:s|ed|ing)?|complaints?|angry|disappointed|disappointing|terrible|awful|waste of (?:my )?time|unacceptable|ripped off|rip-?off)\b/i;

/** 'refusal-price' or 'refusal-seed' for the two narrow topics checked before matching, else null. */
export const topicRefusal = (text) => {
  if (!REFUND_TALK.test(text) && (SPECULATION.test(text) || (MARKET_PRICE.test(text) && !TICKET.test(text)))) return 'refusal-price';
  if (SEED.test(text)) return 'refusal-seed';
  return null;
};

/** A complaint, checked only when no entry matched. */
export const isComplaint = (text) => COMPLAINT.test(text);

/** Asked to make up a text ("write me a poem about ..."): no written answer is about that. */
const MAKE_UP =
  /\b(?:write|compose|draw|sing|generate|make)(?: me| us)? (?:a |an |some |another )?(?:poems?|songs?|story|stories|jokes?|essays?|haikus?|limericks?|raps?|tweets?|memes?|pictures?|images?)\b|\btell (?:me |us )?(?:a |another )?(?:joke|story)\b/i;
/** Asked to print a key or password: the answer about which keys the worker holds would read as going along with it. */
const PRINT_KEY =
  /\b(?:print|reveal|dump|leak|paste|output|expose|disclose|display|show me|give me)\b[^.?!]{0,30}\b(?:private keys?|room key|keeper key|signing key|secret key|api key|keys|passwords?|env vars?|environment variables?)\b/i;

/** Asked what the name means ("why is it called Doorstub?"): no written answer explains the name. */
const NAME_MEANING =
  /\b(?:why (?:is it|is this|was it|its|it's|the project is|doorstub is) (?:called|named)|why (?:call|name) it|(?:meaning|origin) of the name|what does the name|where does the name|why the name)\b/i;

/** A request no written answer is about, checked before matching: it gets the fallback. */
export const notAnswerable = (text) => MAKE_UP.test(text) || PRINT_KEY.test(text) || NAME_MEANING.test(text);

// ------------------------------------------------------------------ 4. matcher

const STOP_WORDS =
  'a an the and or but if so as at by for from in into of off on onto out over to up with without about ' +
  'i me my mine myself you your yours we us our they them their he him his she her it its this that these those there here ' +
  'is are was were be been being am do does did doing done have has had having ' +
  'can could would will should shall may might must ' +
  'what how why when where which who whom whose ' +
  'all any some just really very much many more most also still then than too only even no not ' +
  'get gets got getting please ok okay hi hello hey thanks thank yes work ' +
  // Contractions typed without the apostrophe ("dont", and "don't" once the apostrophe is dropped), and chat shorthand.
  'isnt arent wasnt werent dont doesnt didnt cant cannot couldnt wont wouldnt shouldnt havent hasnt hadnt aint im ive youre ' +
  'u r ur pls plz lol tbh btw want wanna gonna gotta guys yeah yep idk actually exactly basically honestly literally ' +
  // Hedges and fillers that carry no topic ("definitely", "is that normal", "possible now?").
  'definitely surely certainly probably maybe perhaps possible possibly now normal like next ' +
  // The commonest small words of Spanish, Portuguese and Indonesian, so a guest's question in one of them is
  // weighed by its topic words (see VARIANTS). None is an English stem the answers use.
  'mi mis tu su el la de del en y o que por para un una es se lo si como pero ya cuando donde ' +
  'meu minha em na da um uma ou mas ja quando onde ' +
  'di ke dari dan yang ini itu apa saya aku gue tapi bisa gak ga nggak enggak tidak kalau kalo kok sih dong juga mau masih atau dengan untuk kapan gimana bagaimana';

// Matched after stemming ("does" is looked up as "doe"), so the set holds the stems. Built on the first question.
let stops = null;
const stopSet = () => (stops ??= new Set(STOP_WORDS.split(' ').map(stem)));

const IRREGULAR = new Map([
  ['used', 'use'],
  ['using', 'use'],
  ['uses', 'use'],
]);

/**
 * Words read as other words before stemming: typed as one ("checkin"), misspelt or negated ("unused"); chat shorthand ("src", "wen");
 * irregular past forms ("paid", "made"), which the stemmer cannot reach; and the topic words of Spanish,
 * Portuguese and Indonesian that the answers are about (money, ticket, refund, wallet, price), accents removed.
 */
const VARIANTS = new Map([
  ['checkin', 'check in'],
  ['checkins', 'check ins'],
  ['handback', 'hand back'],
  ['handbacks', 'hand backs'],
  ['walkin', 'walk in'],
  ['unused', 'not used'],
  ['freind', 'friend'],
  ['freinds', 'friends'],
  // Chat shorthand.
  ['sig', 'signature'],
  ['sigs', 'signatures'],
  ['src', 'source'],
  ['addr', 'address'],
  ['wen', 'when'],
  ['w', 'with'],
  ['b4', 'before'],
  ['ppl', 'people'],
  // "Is Trezor supported?" asks whether it works, not for support.
  ['supported', 'work'],
  // A refund that "lands" or "arrives" reaches the wallet.
  ['land', 'reach'],
  ['lands', 'reaches'],
  ['landed', 'reached'],
  ['arrive', 'reach'],
  ['arrives', 'reaches'],
  ['arrived', 'reached'],
  // Irregular past forms.
  ['made', 'make'],
  ['built', 'build'],
  ['wrote', 'write'],
  ['written', 'write'],
  ['paid', 'pay'],
  ['sent', 'send'],
  ['gave', 'give'],
  ['given', 'give'],
  ['bought', 'buy'],
  ['took', 'take'],
  ['taken', 'take'],
  ['came', 'come'],
  ['went', 'go'],
  ['lost', 'lose'],
  ['sold', 'sell'],
  ['held', 'hold'],
  ['kept', 'keep'],
  ['told', 'tell'],
  ['broke', 'break'],
  ['broken', 'break'],
  ['chose', 'choose'],
  ['chosen', 'choose'],
  ['stole', 'steal'],
  ['stolen', 'steal'],
  ['forgot', 'forget'],
  ['forgotten', 'forget'],
  ['saw', 'see'],
  ['seen', 'see'],
  ['spent', 'spend'],
  // Spanish, Portuguese and Indonesian topic words.
  ['dinero', 'money'],
  ['dinheiro', 'money'],
  ['uang', 'money'],
  ['duit', 'money'],
  ['boleto', 'ticket'],
  ['boletos', 'tickets'],
  ['entrada', 'ticket'],
  ['entradas', 'tickets'],
  ['ingresso', 'ticket'],
  ['ingressos', 'tickets'],
  ['tiket', 'ticket'],
  ['reembolso', 'refund'],
  ['reembolsar', 'refund'],
  ['devolucion', 'refund'],
  ['regresa', 'back'],
  ['vuelve', 'back'],
  ['devuelve', 'back'],
  ['devolver', 'back'],
  ['volta', 'back'],
  ['kembali', 'back'],
  ['balik', 'back'],
  ['billetera', 'wallet'],
  ['cartera', 'wallet'],
  ['carteira', 'wallet'],
  ['dompet', 'wallet'],
  ['dolar', 'dollar'],
  ['dolares', 'dollars'],
  ['precio', 'price'],
  ['preco', 'price'],
  ['harga', 'price'],
  ['sudah', 'already'],
  ['udah', 'already'],
  ['estafa', 'scam'],
  ['penipuan', 'scam'],
  ['pelicula', 'film'],
  ['filme', 'film'],
  ['sonido', 'sound'],
  ['suara', 'sound'],
]);

/** Light English stemming: plurals, -ing, -ed, a final e, a doubled final consonant. */
export const stem = (word) => {
  if (IRREGULAR.has(word)) return IRREGULAR.get(word);
  if (word.length < 4 || /\d/.test(word)) return word;
  let s = word;
  let cut = false;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (/(?:ss|us|is)$/.test(s)) {
    // address, bus, analysis
  } else if (/(?:ch|sh|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s')) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length >= 6) {
    s = s.slice(0, -3);
    cut = true;
  } else if (s.endsWith('ed') && s.length >= 5) {
    s = s.slice(0, -2);
    cut = true;
  }
  if (cut && s.length >= 4 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(?:ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ll')) s = s.slice(0, -1);
  if (s.length >= 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
};

/**
 * Every word, lowercased and stemmed, stop words kept (for phrases). Accents are dropped, so a Spanish or Portuguese
 * word typed with them still reaches VARIANTS. US "organizer" is read as "organiser", "1,000" as "1000", and an amount
 * with a decimal point ("0.0098") is no word.
 */
const words = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .replace(/organiz/g, 'organis')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\d*\.\d+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '')
    .flatMap((w) => (VARIANTS.has(w) ? VARIANTS.get(w).split(' ') : [w]))
    .map(stem);

// One- and two-digit numbers ("2+2", "screening 2") match only inside a whole phrase.
const isContent = (w) => !stopSet().has(w) && !/^\d{1,2}$/.test(w);
const contentOf = (ws) => ws.filter(isContent);

const containsRun = (haystack, needle) => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

const K1 = 1.2;
const B = 0.5;
/** A keyword phrase found whole in the question adds this, plus PHRASE_IDF times its words' weight. */
const PHRASE_BASE = 1;
const PHRASE_IDF = 0.6;
/** The question's words are exactly one of an entry's questions. */
const SAME_QUESTION = 3;

// Built once per FAQ object, on the first question.
const indexes = new WeakMap();
const indexOf = (faq) => {
  let index = indexes.get(faq);
  if (index !== undefined) return index;
  const docs = faq.entries
    .filter((e) => e.botOk === true && (e.kind === 'faq' || e.kind === 'room'))
    .map((e) => {
      const terms = [...e.questions, ...e.keywords].flatMap((t) => contentOf(words(t)));
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      return {
        entry: e,
        tf,
        length: terms.length,
        phrases: e.keywords.map(words).filter((p) => p.length >= 2),
        questions: e.questions.map((t) => words(t).join(' ')),
      };
    });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, n);
  index = { docs, idf, avg };
  indexes.set(faq, index);
  return index;
};

/** Every botOk faq and room entry with its score for this text, best first. */
export const rank = (text, faq) => {
  const { docs, idf, avg } = indexOf(faq);
  const all = words(text);
  const terms = [...new Set(contentOf(all))];
  const asked = all.join(' ');
  const weight = terms.reduce((s, t) => s + idf(t), 0);
  return docs
    .map((d) => {
      let score = 0;
      let found = 0;
      let phrase = false;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (f === undefined) continue;
        found += idf(t);
        score += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avg));
      }
      for (const p of d.phrases) {
        if (!containsRun(all, p)) continue;
        phrase = true;
        score += PHRASE_BASE + PHRASE_IDF * contentOf(p).reduce((s, t) => s + idf(t), 0);
      }
      if (asked !== '' && d.questions.includes(asked)) {
        phrase = true;
        score += SAME_QUESTION;
      }
      // How much of the question's weight this entry covers (words no entry has weigh the most).
      return { entry: d.entry, score, coverage: weight === 0 ? 0 : found / weight, phrase };
    })
    .sort((a, b) => b.score - a.score);
};

/** Answers that say money moves by a refund, settle or hand-back: shown only on a clear win. */
const MONEY = /\b(?:refunds?|refunded|settles?|settled|hand[- ]?backs?|hands? back)\b/i;
export const movesMoney = (entry) => MONEY.test(entry.answer);

// ------------------------------------------------------------------ 5. answer

const shown = (entry) => ({ id: entry.id, q: entry.q, a: entry.answer });
const byId = (faq, id) => faq.entries.find((e) => e.id === id);
const only = (faq, via, id) => ({ via, answers: [shown(byId(faq, id))] });

/** The matcher's pick: up to 2 entries, or none. */
const pick = (ranked, complaint) => {
  const [first, second] = ranked;
  if (first === undefined || first.score < MATCH_THRESHOLD) return [];
  if (!first.phrase && first.coverage < (complaint ? COMPLAINT_COVERAGE : MIN_COVERAGE)) return [];
  const runnerUp = second?.score ?? 0;
  if (movesMoney(first.entry)) return first.score - runnerUp >= MONEY_LEAD ? [first.entry] : [];
  if (second !== undefined && movesMoney(second.entry) && first.score - runnerUp < MONEY_TIE) return [];
  if (second !== undefined && second.score >= MATCH_THRESHOLD && second.score >= CLOSE * first.score && !movesMoney(second.entry)) return [first.entry, second.entry];
  return [first.entry];
};

/**
 * The room's answer to one question:
 * { via: 'match' | 'refusal' | 'fallback', answers: [{ id, q, a }] } with at
 * most 2 answers, each a botOk entry of `faq` (worker/lib/room-faq.js ROOM_FAQ).
 */
export const decide = (q, faq) => {
  const secret = hardSecret(q);
  if (secret !== null) return only(faq, 'refusal', secret);
  const text = normalise(q);
  const topic = topicRefusal(text);
  if (topic !== null) return only(faq, 'refusal', topic);
  if (notAnswerable(text)) return only(faq, 'fallback', 'fallback');
  const complaint = isComplaint(text);
  const picked = text === '' ? [] : pick(rank(text, faq), complaint);
  if (picked.length > 0) return { via: 'match', answers: picked.map(shown) };
  if (complaint) return only(faq, 'refusal', 'refusal-complaint');
  return only(faq, 'fallback', 'fallback');
};

/** A chip's answer (no matching): { via: 'chip', answers: [{ id, q, a }] }, or null for an id that is not a botOk chip. */
export const chipAnswer = (id, faq) => {
  const entry = byId(faq, id);
  return entry !== undefined && entry.chip === true && entry.botOk === true ? { via: 'chip', answers: [shown(entry)] } : null;
};

// The BIP39 English word list (BIP-0039, 2048 words; the list @bitauth/libauth ships), as data.
const BIP39_ENGLISH = `
abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid
acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance
advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album
alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among
amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique
anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor
army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume
asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado
avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball
bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become
beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle
bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood
blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring
borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief
bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb
bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable
cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable
capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog
catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk
champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child
chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify
claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud
clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine
come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper
copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle
craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop
cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious
current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn
day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay
deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk
despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital
dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide
divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft
dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb
dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo
ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator
elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy
energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode
equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil
evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit
exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint
faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault
favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field
figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness
fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly
foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil
foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel
fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment
gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle
ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue
goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass
gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun
gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard
head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip
hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital
host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband
hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose
improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial
inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest
invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel
job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup
key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know
lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law
lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend
length lens leopard lesson letter level liar liberty library license life lift light like limb limit
link lion liquid list little live lizard load loan lobster local lock logic lonely long loop
lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet
maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin
marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure
meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message
metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake
mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning
mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music
must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative
neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee
noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey
object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay
old olive olympic omit once one onion online only open opera opinion oppose option orange orbit
orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over
own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper
parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut
pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical
piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet
plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony
pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare
present pretty prevent price pride primary print priority prison private prize problem process produce profit program
project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil
puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz
quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid
rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle
reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove
render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire
retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid
ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room
rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness
safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say
scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea
search season seat second secret section security seed seek segment select sell seminar senior sense sentence
series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine
ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side
siege sight sign silent silk silly silver similar simple since sing siren sister situate six size
skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan
slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social
sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup
source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin
spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium
staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting
stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject
submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme
sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim
swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target
task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that
theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger
tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token
tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist
toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree
trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try
tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical
ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown
unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful
useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle
velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view
village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote
voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave
way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat
wheel when where whip whisper wide width wife wild will win window wine wing wink winner
winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth
wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo
`;
