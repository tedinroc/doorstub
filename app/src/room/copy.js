// Every sentence the screening room shows, in one place.
//
// CLAIMS.md lists each one word for word with the rule that makes it true:
// the room's sentences in section 9, the chat label and "From the FAQ: {q}"
// in section 11 (11.1). test-room/room-page.test.js checks both, and that no
// sentence uses a word CLAIMS.md section 3 rules out. The answers themselves
// are worker/lib/room-faq.js (CLAIMS.md section 11).
//
// `{name}` marks a value the page fills in. LABELS are button and heading
// words, not sentences; they make no claim.

export const ROOM_SENTENCES = Object.freeze({
  // Page head and the no-JavaScript line (app/room/index.html).
  pageTitle: 'Doorstub screening room',
  pageDescription: "The room for Doorstub's online screenings: a short film on how Doorstub works, then Q&A in the chat.",
  noscript: 'This screening room needs JavaScript to play the film and the chat.',

  // States
  connecting: 'Connecting to the room…',
  badLink: 'Open this room from your walked-in ticket on doorstub.pages.dev: Get the event link, then Open the event.',
  startsAt: 'Starts {time} · in {countdown}',
  receipt: 'Seat {seat} · your check-in is on chain: {txid}.',
  paid: 'The organiser was paid when you walked in.',
  filmFinished: 'The film has finished. Questions are open until {time}.',
  ended: 'This screening has ended.',
  thanks: 'Thank you for walking in.',
  filmMissing: 'The film did not load. Reload the page to try again.',

  // Chat (CLAIMS.md 11.1): the first label only while an AI model can pick answers.
  labelAi:
    "Answers here are picked from Doorstub's written FAQ: by an AI model when one is available, otherwise by matching words. They only repeat those written answers, so they cannot make promises or move money. For anything else, you can ask Ted Chen in the BCH BLAZE Telegram chat. Nobody from Doorstub will ask you to send BCH or your seed phrase, here or by direct message.",
  labelMatch:
    "Answers here are picked from Doorstub's written FAQ by matching words. They only repeat those written answers, so they cannot make promises or move money. For anything else, you can ask Ted Chen in the BCH BLAZE Telegram chat. Nobody from Doorstub will ask you to send BCH or your seed phrase, here or by direct message.",
  fromFaq: 'From the FAQ: {q}',

  // Credits
  hlsCredit: 'Video playback by hls.js, under the Apache License 2.0.',
});

/** Short words on buttons and headings. */
export const ROOM_LABELS = Object.freeze({
  room: 'Screening room',
  enterRoom: 'Enter the room',
  tapSound: 'Tap to watch with sound',
  watchFromStart: 'Watch from the start',
  watchPreview: 'Watch the preview',
  copyLink: "Copy this room's link",
  copied: 'Copied',
  chat: 'Questions',
  ask: 'Ask',
  askPlaceholder: 'Type a question',
  youAsked: 'You asked',
  licences: 'Licences',
  film: 'Film',
});

/** Fill `{name}` slots. Unknown slots stay visible so a missing value is noticed. */
export const fill = (template, vars = {}) => template.replace(/\{(\w+)\}/g, (all, name) => (vars[name] === undefined || vars[name] === null ? all : String(vars[name])));

/** A room sentence by key, filled. */
export const say = (key, vars) => {
  const template = ROOM_SENTENCES[key];
  if (template === undefined) throw new Error(`no room sentence "${key}"`);
  return fill(template, vars);
};
