import { useEffect, useRef, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { LABELS, say } from '../lib/copy.js';
import { isPhone } from '../hooks.js';
import { CopyButton } from './parts.jsx';

/**
 * The connect dialog, modelled on bchblaze.cash: a QR code (uppercase WIZ://
 * so it fits an alphanumeric QR), Open Selene (the raw wiz:// link; the main
 * button on a phone), Open in Cashonize, and Copy link for Paytaca. The link
 * is never regenerated on a timer, so a pasted link keeps working.
 */
export const ConnectDialog = ({ open, wallet, onClose, onOtherRelay }) => {
  const ref = useRef(null);
  const [qr, setQr] = useState('');
  const phone = isPhone();
  const [qrOnPhone, setQrOnPhone] = useState(false);
  const pairing = wallet.pairing;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    let live = true;
    setQr('');
    if (pairing?.qrUri) {
      QRCode.toString(pairing.qrUri, { type: 'svg', errorCorrectionLevel: 'L', margin: 1, color: { dark: '#1d1813', light: '#00000000' } })
        .then((svg) => live && setQr(svg))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [pairing?.qrUri]);

  const showQr = !phone || qrOnPhone;
  const relayLine =
    wallet.state === 'wrong-network' && wallet.error
      ? say(wallet.error.key, wallet.error.vars)
      : wallet.relaySlow
        ? say('connectRelayDown')
        : say('connectWaiting');

  return (
    <dialog
      ref={ref}
      class="sheet"
      aria-labelledby="connect-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="ticket-shadow">
        <div class="ticket" style="--band: var(--band-a)">
          <div class="band" />
          <div class="face">
            <button type="button" class="close" aria-label={LABELS.close} onClick={onClose}>
              ✕
            </button>
            <div class="kicker">
              <span>Doorstub · WizardConnect</span>
            </div>
            <h2 class="display" id="connect-title" tabIndex={-1} autofocus>
              {LABELS.connect}
            </h2>
            <p class="intro">{say('connectIntro')}</p>
            {showQr ? (
              <div class="qr" aria-label="QR code" data-qr>
                {qr ? <div dangerouslySetInnerHTML={{ __html: qr }} style="width:100%;height:100%" /> : <span class="wait">…</span>}
              </div>
            ) : null}
            <div class="buttons">
              <a class={phone ? 'btn block' : 'btn quiet block'} href={pairing?.selene ?? '#'} data-open-selene aria-disabled={pairing ? 'false' : 'true'}>
                {LABELS.openSelene}
              </a>
              <div class="pair">
                <a class="btn quiet" href={pairing?.cashonize ?? '#'} target="_blank" rel="noopener noreferrer">
                  {LABELS.openCashonize}
                </a>
                {pairing ? <CopyButton text={pairing.copy} class="btn quiet" /> : <button class="btn quiet" disabled type="button">{LABELS.copyLink}</button>}
              </div>
              {phone && !qrOnPhone ? (
                <button type="button" class="linkish" onClick={() => setQrOnPhone(true)}>
                  {LABELS.showQr}
                </button>
              ) : null}
            </div>
            {pairing ? (
              <div class="link-field">
                <input readOnly value={pairing.uri} aria-label="WizardConnect link" data-wiz-uri onFocus={(e) => e.currentTarget.select()} />
              </div>
            ) : null}
            <div class="relay" role="status">
              {wallet.state === 'wrong-network' || wallet.relaySlow ? null : <span class="spin" aria-hidden="true" />}
              <span>{relayLine}</span>
              {wallet.relaySlow ? (
                <button type="button" class="btn quiet small" onClick={onOtherRelay}>
                  {LABELS.otherRelay}
                </button>
              ) : null}
            </div>
            <ul class="notes">
              <li>{say('connectPaste')}</li>
              <li>{say('connectCashonize')}</li>
              <li>{say('connectTested')}</li>
            </ul>
          </div>
        </div>
      </div>
    </dialog>
  );
};
