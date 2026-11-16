// The mainnet broadcast gate. On simnet --broadcast sends at once. On mainnet
// the studio prints what it will send and the total cost, and sends only after
// the person at an interactive terminal types BROADCAST.
import { createInterface } from 'node:readline/promises';

export const CONFIRM_WORD = 'BROADCAST';

export const terminalPrompt = async (question) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('mainnet broadcast needs an interactive terminal; nothing was sent. Run the command yourself and type BROADCAST.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

/**
 * Resolve when sending is allowed; throw (nothing sent) otherwise.
 * `prompt(question)` returns the typed answer; tests inject one.
 */
export const confirmBroadcast = async ({ network, summary, prompt = terminalPrompt, print = console.log }) => {
  if (network === 'simnet') return;
  if (network !== 'mainnet') throw new Error(`unknown network ${network}; nothing was sent`);
  print(summary);
  const answer = await prompt(`\nThis sends real BCH on mainnet. Type ${CONFIRM_WORD} to send, anything else to stop: `);
  if (String(answer).trim() !== CONFIRM_WORD) throw new Error('not confirmed; nothing was sent');
};
