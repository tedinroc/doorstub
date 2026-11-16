// Doorstub probe page: pair a wallet over WizardConnect, send sign-only
// requests for each shape, check every reply, keep a results log.
import QRCode from 'qrcode';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { SHAPES, buildShape, makeProbeShow } from './shapes.js';
import { toSignRequest } from './wire.js';
import { checkReply, refusal } from './check.js';
import { cashonizeLink, requestSignature, scanAddresses, startPairing } from './connect.js';
import { scanCoins } from './fulcrum.js';
import { redactRun, redactRuns } from './records.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
};

const RESULTS_KEY = 'doorstub-probe-results-v1';
const NOTES_KEY = 'doorstub-probe-notes-v1';

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private window or blocked storage: results still live in memory
    }
  },
};

const state = {
  pairing: null,
  wallet: null,
  probe: null,
  coins: null,
  busy: null, // { id, controller }
  // Runs saved by an older page may still hold an A-real signature: drop it on load.
  runs: redactRuns(store.get(RESULTS_KEY, [])),
  last: {}, // shape id -> last result for the current wallet
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.focus();
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
};

const flash = (node, text) => {
  const before = node.textContent;
  node.textContent = text;
  setTimeout(() => (node.textContent = before), 1500);
};

// ---------------------------------------------------------------- pairing

const relayStatusText = {
  connected: 'Relay connected. Waiting for the wallet to join…',
  reconnecting: 'Relay reconnecting…',
  disconnected: 'Relay disconnected.',
  session_deleted: 'Relay session deleted.',
};

const startConnect = async () => {
  await resetPairing();
  state.probe = makeProbeShow();
  renderShow();
  const pairing = startPairing({
    onStatus: (status, error) => {
      if (state.pairing !== pairing) return;
      if (state.wallet && status === 'connected') {
        $('relay-status').textContent = `Relay connected. Wallet: ${state.wallet.name}.`;
        return;
      }
      $('relay-status').textContent = `${relayStatusText[status] ?? `Relay: ${status}`}${error ? ` (${error})` : ''}`;
    },
    onWalletReady: (info) => {
      if (state.pairing !== pairing) return;
      onWalletReady(info);
    },
    onDisconnect: (reason, message) => {
      if (state.pairing !== pairing) return;
      $('relay-status').textContent = `Wallet disconnected (${reason}${message ? `: ${message}` : ''}). Press Disconnect, then Connect wallet to pair again.`;
    },
  });
  state.pairing = pairing;
  $('qr').innerHTML = await QRCode.toString(pairing.qrUri, { type: 'svg', errorCorrectionLevel: 'L', margin: 1 });
  $('open-selene').href = pairing.uri;
  $('open-cashonize').href = cashonizeLink(pairing.uri);
  $('wiz-uri').textContent = pairing.uri;
  $('connect-idle').hidden = true;
  $('connect-dialog').hidden = false;
  $('wallet-box').hidden = true;
};

const resetPairing = async () => {
  if (state.busy) state.busy.controller.abort('Pairing closed');
  const old = state.pairing;
  state.pairing = null;
  state.wallet = null;
  state.coins = null;
  state.last = {};
  if (old) await old.close().catch(() => {});
  renderShapes();
};

const onWalletReady = (info) => {
  const first = state.wallet === null;
  state.wallet = info;
  $('w-name').textContent = info.name;
  $('w-network').textContent = info.network === 'mainnet' ? 'mainnet' : `${info.network} (signing still works; A-real scan uses mainnet servers only)`;
  $('w-token-address').textContent = info.receive0.tokenAddress;
  $('w-address').textContent = info.receive0.address;
  $('wallet-box').hidden = false;
  $('connect-dialog').hidden = true;
  if (first) {
    $('scan-status').textContent = 'Scan not run. Only needed for shape A-real.';
    // A new wallet: start the record line with its name; add version and device by hand.
    const notes = $('notes');
    notes.value = info.name;
    store.set(NOTES_KEY, notes.value);
  }
  renderShapes();
};

const disconnect = async () => {
  await resetPairing();
  $('connect-idle').hidden = false;
  $('connect-dialog').hidden = true;
  $('wallet-box').hidden = true;
};

// ---------------------------------------------------------------- scan

const runScan = async () => {
  if (!state.pairing || !state.wallet) return;
  const btn = $('scan-btn');
  btn.disabled = true;
  const status = $('scan-status');
  try {
    if (state.wallet.network !== 'mainnet') throw new Error('the scan only knows mainnet Fulcrum servers');
    const addresses = scanAddresses(state.pairing.manager, state.wallet.prefix, 20);
    const found = await scanCoins(addresses, { onProgress: (m) => (status.textContent = `Scanning: ${m}…`) });
    state.coins = found.coins;
    const total = found.coins.reduce((a, c) => a + c.value, 0n);
    status.textContent =
      `${found.server}: ${found.coins.length} plain BCH coin(s), ${total} sats in receive/change 0-20` +
      (found.tokenCoins ? ` (${found.tokenCoins} token coin(s) skipped)` : '') +
      '. Read-only query; nothing was sent.';
  } catch (e) {
    status.textContent = `Scan failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    renderShapes();
  }
};

// ---------------------------------------------------------------- shapes

const shapeNodes = new Map();

const renderShapes = () => {
  const box = $('shapes');
  if (shapeNodes.size === 0) {
    for (const info of SHAPES) {
      const button = el('button', { class: 'primary', type: 'button', text: `Sign ${info.id}` });
      const cancel = el('button', { class: 'btn quiet', type: 'button', text: 'Cancel' });
      cancel.hidden = true;
      button.addEventListener('click', () => runShape(info.id));
      cancel.addEventListener('click', () => state.busy?.controller.abort('Cancelled on the page'));
      const pill = el('span', { class: 'pill' });
      const result = el('div', { class: 'shape-result' });
      const node = el(
        'div',
        { class: 'shape' },
        el('div', { class: 'shape-head' }, el('span', { class: 'shape-id', text: info.id }), el('span', { class: 'shape-title', text: info.title }), pill, cancel, button),
        el('p', { class: 'shape-summary', text: info.summary }),
        result,
      );
      shapeNodes.set(info.id, { node, button, cancel, pill, result });
      box.append(node);
    }
  }
  for (const info of SHAPES) {
    const n = shapeNodes.get(info.id);
    const connected = state.wallet !== null;
    const needsCoins = info.needsCoins && (state.coins === null || state.coins.length === 0);
    n.button.disabled = !connected || state.busy !== null || needsCoins;
    n.button.title = !connected ? 'Connect a wallet first' : needsCoins ? 'Run the scan first; needs real coins' : '';
    n.cancel.hidden = state.busy?.id !== info.id;
    const last = state.last[info.id];
    if (state.busy?.id === info.id) {
      setPill(n.pill, 'WAITING', 'waiting for wallet');
    } else if (last) {
      setPill(n.pill, last.verdict, pillLabel(info, last), info.expect === 'refuse-41' && last.verdict === 'REFUSED');
    } else {
      setPill(n.pill, '', '');
    }
    if (info.needsCoins && connected && needsCoins && !last) {
      n.result.replaceChildren(el('span', { class: 'hint', text: state.coins === null ? 'Press "Scan for real coins" first.' : 'The scan found no plain coins; skip A-real.' }));
    } else if (!last && state.busy?.id !== info.id) {
      n.result.replaceChildren();
    }
  }
};

const pillLabel = (info, result) => {
  if (info.expect === 'refuse-41' && result.verdict === 'REFUSED') return 'REFUSED (expected)';
  if (info.expect === 'refuse-41' && result.verdict === 'SIGNED') return 'SIGNED (no 40-byte limit)';
  return result.verdict;
};

const setPill = (pill, verdict, label, expected = false) => {
  pill.className = `pill ${verdict}${expected ? ' expected' : ''}`;
  pill.textContent = label;
  pill.hidden = !label;
};

const renderResult = (id, result) => {
  const n = shapeNodes.get(id);
  const parts = [el('div', { class: 'text', text: result.summary })];
  if (result.walletError) parts.push(el('div', {}, el('strong', { text: 'Wallet error text: ' }), el('code', { text: result.walletError })));
  if (result.checks?.length) {
    const list = el('ul', { class: 'checks' });
    for (const c of result.checks) list.append(el('li', { class: c.ok ? 'ok' : 'bad', text: `${c.name}${c.detail ? ` — ${c.detail}` : ''}` }));
    parts.push(el('details', { ...(result.verdict === 'FAIL' ? { open: '' } : {}) }, el('summary', { text: `${result.checks.length} checks` }), list));
  }
  if (result.elapsedMs !== undefined) parts.push(el('div', { class: 'hint', text: `Reply after ${(result.elapsedMs / 1000).toFixed(1)} s` }));
  n.result.replaceChildren(...parts);
};

const runShape = async (id) => {
  if (!state.pairing || !state.wallet || state.busy) return;
  const n = shapeNodes.get(id);
  let shape;
  try {
    shape = buildShape(id, { probe: state.probe, walletPkh: state.wallet.receive0.pkh, coins: state.coins ?? [] });
  } catch (e) {
    n.result.replaceChildren(el('span', { class: 'text', text: `Could not build ${id}: ${e.message}` }));
    return;
  }
  const request = toSignRequest(shape);
  const controller = new AbortController();
  state.busy = { id, controller };
  renderShapes();
  n.result.replaceChildren(
    el('span', { class: 'hint', text: `Request sent. Open ${state.wallet.name} and look at the confirm screen. Screenshot it before you approve.` }),
  );
  const started = Date.now();
  let result;
  try {
    const hex = await requestSignature(state.pairing.manager, request, { signal: controller.signal });
    result = checkReply(shape, hex);
  } catch (e) {
    if (e?.name === 'AbortError') {
      result = { ...refusal(shape, e.message), verdict: 'CANCELLED', summary: `Cancelled on the page (${e.message}).` };
    } else {
      result = refusal(shape, e?.message ?? String(e));
    }
  }
  result.elapsedMs = Date.now() - started;
  // A-real signs real coins: keep only the verdict and the checks, never the signed transaction.
  result = redactRun({ ...result, shape: id });
  if (state.busy?.controller === controller) state.busy = null;
  state.last[id] = result;
  record(shape, request, result);
  renderResult(id, result);
  renderShapes();
};

// ---------------------------------------------------------------- results

const record = (shape, request, result) => {
  state.runs.push(redactRun({
    at: new Date().toISOString(),
    shape: shape.id,
    verdict: result.verdict,
    summary: result.summary,
    walletError: result.walletError ?? null,
    elapsedMs: result.elapsedMs,
    notes: $('notes').value.trim(),
    wallet: state.wallet && {
      name: state.wallet.name,
      network: state.wallet.network,
      receive0: state.wallet.receive0.tokenAddress,
      paths: state.wallet.paths,
    },
    checks: result.checks,
    signatures: result.signatures,
    vm: result.vm,
    sent: {
      transactionHex: binToHex(encodeTransaction(shape.transaction)),
      inputPaths: request.inputPaths,
      sourceOutputs: request.transaction.sourceOutputs,
      madeUpInputs: shape.madeUpInputIndexes,
      broadcast: request.transaction.broadcast,
      userPrompt: request.transaction.userPrompt,
      notes: shape.notes,
    },
    signedHex: result.signedHex ?? null,
  }));
  store.set(RESULTS_KEY, state.runs);
  renderRuns();
};

const exportJson = () =>
  JSON.stringify(
    {
      tool: 'doorstub-probe',
      schema: 1,
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      summary: state.runs.map((r) => `${r.wallet?.name ?? '?'} | ${r.notes} | ${r.shape} | ${r.verdict}${r.walletError ? ` | ${r.walletError}` : ''}`),
      runs: redactRuns(state.runs),
    },
    null,
    2,
  );

const renderRuns = () => {
  const table = $('runs');
  if (state.runs.length === 0) {
    table.replaceChildren();
    $('results-status').textContent = 'No results yet.';
    return;
  }
  $('results-status').textContent = `${state.runs.length} result(s), kept in this browser until you clear them.`;
  const head = el('tr', {}, ...['Time', 'Wallet', 'Shape', 'Result', 'Wallet said', 'Reply'].map((h, i) => el('th', { class: ['time', '', '', '', '', 'ms'][i], text: h })));
  const rows = state.runs
    .slice()
    .reverse()
    .map((r) =>
      el(
        'tr',
        {},
        el('td', { class: 'time', text: new Date(r.at).toLocaleTimeString() }),
        el('td', { text: r.notes || r.wallet?.name || '?' }),
        el('td', { text: r.shape }),
        el('td', {}, el('span', { class: `pill ${r.verdict}${r.shape === 'D' && r.verdict === 'REFUSED' ? ' expected' : ''}`, text: r.verdict })),
        el('td', { class: 'msg', text: r.walletError ?? '' }),
        el('td', { class: 'ms', text: r.elapsedMs !== undefined ? `${(r.elapsedMs / 1000).toFixed(1)} s` : '' }),
      ),
    );
  table.replaceChildren(head, ...rows);
};

const renderShow = () => {
  const facts = $('show-facts');
  if (!state.probe) {
    facts.replaceChildren(el('dt', { text: 'Status' }), el('dd', { text: 'Made when you press Connect wallet.' }));
    return;
  }
  const { show, contracts } = state.probe;
  const items = [
    ['Token category (made up)', binToHex(show.category)],
    ['BoxOffice address', contracts.boxOffice.address()],
    ['Escrow address', contracts.escrow.address()],
    ['Ticket price', `${show.price} sats (+1,000 sats in the ticket NFT, +1,000 in the escrow marker)`],
    ['Organiser keys', 'fresh; the private halves were thrown away'],
  ];
  facts.replaceChildren(...items.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, el('code', { text: v }))]));
};

// ---------------------------------------------------------------- wiring

$('connect-btn').addEventListener('click', () => startConnect().catch((e) => ($('relay-status').textContent = `Could not start: ${e.message}`)));
$('disconnect-btn').addEventListener('click', () => disconnect());
$('cancel-pairing').addEventListener('click', () => disconnect());
$('scan-btn').addEventListener('click', () => runScan());
$('copy-link').addEventListener('click', async (event) => {
  if (!state.pairing) return;
  flash(event.currentTarget, (await copyText(state.pairing.uri)) ? 'Copied' : 'Copy failed: select the link below');
});
$('copy-results').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const json = exportJson();
  const ok = await copyText(json);
  flash(button, ok ? 'Copied' : 'Copy blocked: select the text below');
  const box = $('results-json');
  if (!ok) {
    // The browser blocked the clipboard: show the JSON so it can be copied by hand.
    box.value = json;
    box.hidden = false;
    box.focus();
    box.select();
  } else {
    box.hidden = true;
  }
});
$('download-results').addEventListener('click', () => {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `doorstub-probe-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
});
$('clear-results').addEventListener('click', () => {
  if (!confirm('Clear all saved probe results in this browser?')) return;
  state.runs = [];
  store.set(RESULTS_KEY, state.runs);
  renderRuns();
});
const notes = $('notes');
notes.value = store.get(NOTES_KEY, '');
notes.addEventListener('input', () => store.set(NOTES_KEY, notes.value));
window.addEventListener('beforeunload', () => {
  state.pairing?.close();
});

// Rewrite saved runs that held an A-real signature, so it leaves this browser too.
if (state.runs.some((run) => run.signedHexRedacted)) store.set(RESULTS_KEY, state.runs);
renderShapes();
renderRuns();
renderShow();
