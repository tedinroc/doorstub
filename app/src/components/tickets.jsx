import { useEffect, useRef, useState } from 'preact/hooks';
import { bchNumber } from '../../../src/shows/format.js';
import { LABELS, say } from '../lib/copy.js';
import { flyCoin, reducedMotion, useCut, usePrevious } from '../hooks.js';
import { Barcode, FlowStatus, RefundTrack, Stamp, TxLink } from './parts.jsx';

const BAND = { 'sample-settle': 'a', 'sample-refund-seat': 'b', real: 'real', proof: 'proof' };
const bandStyle = (kind) => `--band: var(--band-${BAND[kind] ?? 'a'})`;

const busy = (flow) => flow !== undefined && flow.error === undefined && ['preparing', 'approve', 'sending'].includes(flow.step);

/**
 * A show for sale: the box-office ticket. On a phone the price and the
 * button sit right under the show's words (the judge reaches "Get a ticket"
 * in one screen); from 720 px the stub with the price tears off on the right.
 */
export const ShowCard = ({ model, flow, onBuy, onAction, onCancel, children }) => {
  const working = busy(flow);
  const cutRef = useCut();
  const status = flow !== undefined && flow.step !== 'done' ? <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} /> : null;
  return (
    <div class={`show-col kind-${BAND[model.kind] ?? 'a'}`} data-show={model.id}>
      <div class="ticket-shadow">
        <article ref={cutRef} class="ticket wide show" style={bandStyle(model.kind)} aria-labelledby={`t-${model.id}`}>
          <div class="band" />
          <div class="face">
            <div class="kicker">
              <span>Doorstub</span>
              <span class="pill">{model.sample ? LABELS.sample : LABELS.realShow}</span>
              {model.onSale === false ? <span class="pill ended-pill">{LABELS.ended}</span> : <span class="serial">No. {model.serial}</span>}
            </div>
            <div class="title-row">
              <div class="letter" aria-hidden="true">
                {model.letter}
              </div>
              <div class="titles">
                <h3 class="display" id={`t-${model.id}`}>
                  {model.title}
                </h3>
                {model.subtitle ? <div class="subtitle">{model.subtitle}</div> : null}
              </div>
            </div>
            <p class="card-text">{model.card}</p>
          </div>
          <div class="stub">
            <div class="admit">{LABELS.admitOne}</div>
            <div class="buy-row">
              <div class="price-box">
                <div class="price">
                  {bchNumber(model.priceSats)}
                  <small>BCH</small>
                </div>
                <div class="usd">{model.priceUsd ? say('usdAbout', { usd: model.priceUsd }) : ''}</div>
              </div>
              {model.onSale === false ? (
                <p class="ended" data-sales-ended={model.id}>
                  {model.endedLine}
                </p>
              ) : (
                <button type="button" class="btn cta" onClick={onBuy} disabled={working} data-buy={model.id}>
                  {working ? <span class="spin" aria-hidden="true" /> : null}
                  {LABELS.getTicket}
                </button>
              )}
            </div>
            {model.sold !== null ? <div class="sold">{say('soldLine', { sold: model.sold, shards: model.shards })}</div> : null}
          </div>
          <div class="status">{status}</div>
          <dl class="facts">
            {model.callLine ? (
              <div data-fact="call">
                <dt>{LABELS.call}</dt>
                <dd>{model.callLine}</dd>
              </div>
            ) : null}
            {model.startLine ? (
              <div data-fact="start">
                <dt>{model.startLabel}</dt>
                <dd>{model.startLine}</dd>
              </div>
            ) : null}
            {model.kind !== 'sample-refund-seat' ? (
              <div>
                <dt>{LABELS.refundsLabel}</dt>
                <dd>{model.settleLine}</dd>
              </div>
            ) : null}
            <div>
              <dt>{LABELS.fees}</dt>
              <dd>{model.feesLine}</dd>
            </div>
          </dl>
        </article>
      </div>
      {children ? <div class="col-mine">{children}</div> : null}
    </div>
  );
};

const SPEND_LABEL = { handBack: LABELS.handBackTx, checkIn: LABELS.checkInTx, settle: LABELS.settleTx, refund: LABELS.refundTx };

/** A ticket the wallet holds (or held): seat, money, countdown or refund track, stamp, actions. */
export const Ticket = ({ model, flow, network, fresh, reveal = false, onHandBack, onWalkIn, onAction, onCancel }) => {
  const prevState = usePrevious(model.state);
  const moneyRef = useRef(null);
  const cutRef = useCut();
  const justStamped = prevState !== undefined && prevState !== model.state && model.stamp !== null;
  const [thud, setThud] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    // A ticket just printed: bring it into view (it may sit under the fold on a phone).
    if (!fresh || !reveal || rootRef.current === null) return;
    const r = rootRef.current.getBoundingClientRect();
    if (r.top < 60 || r.bottom > globalThis.innerHeight) {
      rootRef.current.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }
  }, []);
  useEffect(() => {
    if (!justStamped) return;
    setThud(true);
    if (model.state === 'handedBack' || model.state === 'refunded') {
      flyCoin(moneyRef.current, globalThis.document?.querySelector('[data-wallet-chip]'), { delay: 250 });
    }
  }, [justStamped, model.state]);

  const held = model.state === 'held';
  const refundRunning = flow?.kind === 'refund';
  const actionBusy = busy(flow) || (refundRunning && flow.error === undefined && flow.step !== 'back');
  const showHandBack = model.canHandBack && !actionBusy && !(model.autoRefund && refundRunning && flow.error === undefined);
  const doorFlow = flow?.kind === 'walkIn' ? flow : null;
  const spendKind = model.state === 'refunded' ? model.refundPath ?? 'refund' : model.state === 'handedBack' ? 'handBack' : model.state === 'walkedIn' ? 'checkIn' : '';
  const spendLabel = SPEND_LABEL[spendKind] ?? null;
  const showCountdown = held && model.settleLine && !model.autoRefund && model.countdown !== null;
  const call = showCountdown ? model.call : null;

  return (
    <div ref={rootRef} class={`printed${fresh ? ' fresh' : ''}`} data-ticket={model.key} data-state={model.state}>
      <div class="ticket-shadow">
        <article
          ref={cutRef}
          class={`ticket mine${held ? '' : ' done'}${thud ? ' stamped' : ''}`}
          style={bandStyle(model.kind)}
          aria-label={`${LABELS.yourTicket} ${model.seat}`}
        >
          <div class="band" />
          <div class="face">
            <div class="kicker">
              <span class="admit-word">{LABELS.admitOne}</span>
              <span class="show-name">{model.title}</span>
              <span class="serial">No. {model.serial}</span>
            </div>
            <div class="seat-row">
              <div>
                <div class="seat-label">{LABELS.seat}</div>
                <div class="seat" ref={moneyRef}>
                  {model.seat}
                </div>
              </div>
              {held && model.valueText ? (
                <div class="held-value">
                  <span class="coin-mark" aria-hidden="true" />
                  <b>{model.valueText}</b>
                  <span>{LABELS.inContract}</span>
                </div>
              ) : null}
            </div>
            <div class="lines" aria-live="polite">
              {model.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {call !== null ? (
              <div class="countdown call" data-call={call.phase}>
                <div class="cd-head">
                  <span class="cd-l">{call.phase === 'before' ? LABELS.callIn : LABELS.call}</span>
                  <span class="cd-n display">{call.phase === 'before' ? call.countdown : LABELS.onNow}</span>
                </div>
                <p>{call.line}</p>
                <p class="cd-small">{model.settleLine}</p>
              </div>
            ) : showCountdown ? (
              <div class="countdown">
                <div class="cd-head">
                  <span class="cd-l">{LABELS.settleIn}</span>
                  <span class="cd-n display">{model.countdown}</span>
                </div>
                {model.progress !== null ? (
                  <div class="bar" aria-hidden="true">
                    <i style={`width:${Math.max(3, Math.round(model.progress * 100))}%`} />
                  </div>
                ) : null}
                <p>{model.settleSmall}</p>
              </div>
            ) : null}
            {model.autoRefund && (refundRunning || !held) ? (
              <>
                <RefundTrack step={refundRunning && flow.error === undefined ? flow.step : held ? 'held' : 'back'} />
                {refundRunning && flow.step === 'sent' && flow.txid ? (
                  <div class="track-tx">
                    <TxLink network={network} label={LABELS.refundTx} txid={flow.txid} />
                  </div>
                ) : null}
              </>
            ) : null}
            {flow !== undefined && (flow.step !== 'done' || flow.error !== undefined) && flow.kind !== 'refund' && flow.step !== 'door' ? (
              <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} />
            ) : null}
            {refundRunning && flow.error !== undefined ? <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} /> : null}
            {doorFlow?.step === 'door' ? (
              <div class="flow" role="status">
                <div class="line">
                  <span class="spin" aria-hidden="true" />
                  <span>{say('doorAsking')}</span>
                </div>
              </div>
            ) : null}
            {doorFlow?.link ? (
              <div class="door" role="status">
                <p>{say('doorAnswered')}</p>
                <a class="btn" href={doorFlow.link} target="_blank" rel="noopener noreferrer" data-door-link>
                  {LABELS.openEvent} ↗
                </a>
              </div>
            ) : null}
            {doorFlow?.doorError ? (
              <div class="flow error" role="alert" data-door-error={doorFlow.doorError.key}>
                <div class="line">
                  <span>{say(doorFlow.doorError.key, doorFlow.doorError.vars)}</span>
                </div>
                {doorFlow.doorError.actions.includes('retryDoor') ? (
                  <div class="actions">
                    <button type="button" class="btn small" onClick={() => onAction('retryDoor')}>
                      {LABELS.tryAgain}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {model.state === 'walkedIn' && model.kind === 'real' && doorFlow === null ? (
              <div class="act">
                <button type="button" class="btn small" onClick={() => onAction('retryDoor')} data-door-again={model.key}>
                  {LABELS.getEventLink}
                </button>
              </div>
            ) : null}
            {(showHandBack || model.canWalkIn) && !actionBusy ? (
              <div class="act">
                {model.canWalkIn ? (
                  <button type="button" class="btn small" onClick={onWalkIn} data-walk-in={model.key}>
                    {LABELS.walkIn}
                  </button>
                ) : null}
                {showHandBack ? (
                  <button type="button" class={`btn small ${model.canWalkIn ? 'ghost' : 'ghost'}`} onClick={onHandBack} data-hand-back={model.key}>
                    {LABELS.handBack}
                  </button>
                ) : null}
                {model.canWalkIn ? <p class="act-note">{say('checkInFinal')}</p> : null}
              </div>
            ) : null}
            <div class="links">
              <TxLink network={network} label={LABELS.buyTx} txid={model.buyTxid} />
              {model.escrowOutpoint ? <TxLink network={network} label={LABELS.coinLink} txid={model.escrowOutpoint.txid} vout={model.escrowOutpoint.vout} /> : null}
              {spendLabel && model.spendTxid ? <TxLink network={network} label={spendLabel} txid={model.spendTxid} /> : null}
            </div>
            <Stamp stamp={model.stamp} thud={thud} />
          </div>
          <div class="stub">
            <Barcode bits={model.barcode} />
            <div class="serial">
              NFT
              <b>{model.seat}</b>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
};
