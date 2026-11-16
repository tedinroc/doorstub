import { useEffect, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { EXPLORER } from '../config.js';
import { LABELS, say } from '../lib/copy.js';
import { refundTrack } from '../lib/view.js';
import { copyText } from '../hooks.js';

/** The Doorstub mark: a ticket stub with its notch. */
export const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path
      d="M4 7a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v5a4 4 0 0 0 0 8v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a4 4 0 0 0 0-8z"
      fill="var(--accent)"
    />
    <path d="M20.5 7v18" stroke="var(--paper)" stroke-width="1.8" stroke-dasharray="2.2 2.4" stroke-linecap="round" />
    <path d="M9 12.5h7.5M9 16h5.5M9 19.5h7" stroke="var(--paper)" stroke-width="2" stroke-linecap="round" />
  </svg>
);

export const Stamp = ({ stamp, thud }) =>
  stamp === null ? null : (
    <div class={`stamp ${stamp.tone}${thud ? ' thud' : ''}`} role="img" aria-label={stamp.text}>
      {stamp.text}
    </div>
  );

/** The NFT commitment as bars: 1 = a bar, 0 = a gap. */
export const Barcode = ({ bits }) => {
  const bars = [];
  let x = 0;
  for (let i = 0; i < bits.length; i += 1) {
    const w = i % 8 === 0 ? 2 : 1;
    if (bits[i] === '1') bars.push(<rect key={i} x={x} y="0" width={w} height="40" />);
    x += w + 0.6;
  }
  return (
    <svg class="barcode" viewBox={`0 0 ${x} 40`} preserveAspectRatio="none" aria-hidden="true" fill="currentColor">
      {bars}
    </svg>
  );
};

/** A txid as a short explorer link (plain text on simnet, where no explorer can see it). */
export const TxLink = ({ txid, network, label, vout }) => {
  if (!txid) return null;
  const text = `${label ? `${label} ` : ''}${txid.slice(0, 8)}…${txid.slice(-4)}${vout !== undefined ? `:${vout}` : ''}`;
  if (network !== 'mainnet') return <span class="mono" title={txid}>{text}</span>;
  return (
    <a href={EXPLORER.tx(txid)} target="_blank" rel="noopener noreferrer" title={txid}>
      {text} ↗
    </a>
  );
};

export const CopyButton = ({ text, class: cls = 'btn quiet small', label = LABELS.copyLink }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class={cls}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      {done ? LABELS.copied : label}
    </button>
  );
};

/** A QR code as inline SVG (dark modules on a light tile in both themes). */
export const QrCode = ({ text, label, class: cls = 'qr' }) => {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    setSvg('');
    if (text) {
      QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1d1813', light: '#00000000' } })
        .then((out) => live && setSvg(out))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div class={cls} role="img" aria-label={label}>
      {svg ? <div class="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
    </div>
  );
};

/** An empty wallet is a road, not a wall: where to send BCH, and the buy goes on when it arrives. */
export const FundBox = ({ fund }) => (
  <div class="fund" data-fund>
    <QrCode text={fund.uri} label={LABELS.receiveQr} class="fund-qr" />
    <div class="fund-text">
      <p>{say('fundHere', { amount: fund.amount })}</p>
      <div class="fund-address">
        <code data-fund-address>{fund.address}</code>
        <CopyButton text={fund.address} label={LABELS.copyAddress} />
      </div>
      <p class="fund-wait" role="status">
        <span class="spin" aria-hidden="true" />
        {say('fundWatching')}
      </p>
    </div>
  </div>
);

const ACTION_LABEL = {
  retry: LABELS.tryAgain,
  connect: LABELS.connect,
  nextInstance: LABELS.getNext,
  reload: LABELS.reload,
  retryDoor: LABELS.tryAgain,
  retryRefund: LABELS.tryAgain,
};

/**
 * Where a flow stands: waiting for the wallet (with the exact words the
 * wallet shows), sending, or stuck with a sentence and a next step.
 */
export const FlowStatus = ({ flow, onAction, onCancel }) => {
  if (flow === undefined || flow === null) return null;
  if (flow.error !== undefined) {
    const actions = flow.error.actions.filter((a) => ACTION_LABEL[a] !== undefined);
    return (
      <div class="flow error" role="alert">
        <div class="line">
          <span>{say(flow.error.key, flow.error.vars)}</span>
        </div>
        {flow.error.detail ? <div class="detail">{flow.error.detail}</div> : null}
        {flow.error.fund ? <FundBox fund={flow.error.fund} /> : null}
        <div class="actions">
          {actions.map((a, i) => (
            <button type="button" key={a} class={i === 0 ? 'btn small' : 'btn quiet small'} onClick={() => onAction(a)}>
              {ACTION_LABEL[a]}
            </button>
          ))}
          <button type="button" class="linkish" onClick={() => onAction('dismiss')}>
            {LABELS.close}
          </button>
        </div>
      </div>
    );
  }
  if (flow.step === 'preparing') {
    return (
      <div class="flow" role="status">
        <div class="line">
          <span class="spin" aria-hidden="true" />
          <span>{flow.retrying ? say(flow.retryReason ?? 'shardTaken') : flow.kind === 'buy' ? say('buyPreparing') : say('sending')}</span>
        </div>
      </div>
    );
  }
  if (flow.step === 'approve') {
    return (
      <div class="flow" role="status" data-flow="approve">
        {flow.retrying ? (
          <div class="line">
            <span>{say(flow.retryReason ?? 'shardTaken')}</span>
          </div>
        ) : null}
        <div class="line">
          <span class="spin" aria-hidden="true" />
          <span>{say('approveIn', { wallet: flow.wallet ?? 'your wallet', prompt: flow.prompt })}</span>
        </div>
        <div class="actions">
          <button type="button" class="linkish" onClick={onCancel}>
            {LABELS.cancel}
          </button>
        </div>
      </div>
    );
  }
  if (flow.step === 'sending') {
    return (
      <div class="flow" role="status">
        <div class="line">
          <span class="spin" aria-hidden="true" />
          <span>{say('sending')}</span>
        </div>
      </div>
    );
  }
  return null;
};

export const RefundTrack = ({ step }) => (
  <ol class="track" aria-label={LABELS.refundProgress}>
    {refundTrack(step).map((s) => (
      <li key={s.id} class={`step${s.done ? ' done' : ''}${s.active ? ' active' : ''}`} style="list-style:none">
        <span class="dot" aria-hidden="true" />
        <span>{s.label}</span>
      </li>
    ))}
  </ol>
);
