import { useEffect, useRef, useState } from 'preact/hooks';
import { bchNumber } from '../../../src/shows/format.js';
import { LABELS, say } from '../lib/copy.js';
import { flyCoin, usePrevious } from '../hooks.js';
import { Barcode, FlowStatus, RefundTrack, Stamp, TxLink } from './parts.jsx';

const BAND = { 'sample-settle': 'a', 'sample-refund-seat': 'b', real: 'real', proof: 'proof' };
const bandStyle = (kind) => `--band: var(--band-${BAND[kind] ?? 'a'})`;

const busy = (flow) => flow !== undefined && flow.error === undefined && ['preparing', 'approve', 'sending'].includes(flow.step);

/** A show for sale: the box-office ticket with its tear-off stub and the button. */
export const ShowCard = ({ model, flow, onBuy, onAction, onCancel, children }) => {
  const working = busy(flow);
  return (
    <div class="show-col" data-show={model.id}>
      <div class="ticket-shadow">
        <article class="ticket wide show" style={bandStyle(model.kind)} aria-labelledby={`t-${model.id}`}>
          <div class="band" />
          <div class="face">
            <div class="kicker">
              <span>Doorstub</span>
              {model.sample ? <span class="pill sample">{LABELS.sample}</span> : null}
              <span class="serial">No. {model.serial}</span>
            </div>
            <div class="title-row">
              <div class="letter" aria-hidden="true">
                {model.letter}
              </div>
              <div>
                <h3 class="display" id={`t-${model.id}`}>
                  {model.title}
                </h3>
                {model.subtitle ? <div class="subtitle">{model.subtitle}</div> : null}
              </div>
            </div>
            <p class="card-text">{model.card}</p>
            <dl class="facts">
              <div>
                <dt>{LABELS.starts}</dt>
                <dd>{model.startLine}</dd>
              </div>
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
            {flow?.step !== 'done' ? <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} /> : null}
          </div>
          <div class="stub">
            <div class="admit">{LABELS.admitOne}</div>
            <div class="price">
              {bchNumber(model.priceSats)}
              <small>BCH</small>
            </div>
            <div class="usd">{model.priceUsd ? say('usdAbout', { usd: model.priceUsd }) : ''}</div>
            <div class="cta">
              <button type="button" class="btn block" onClick={onBuy} disabled={working} data-buy={model.id}>
                {working ? <span class="spin" aria-hidden="true" /> : null}
                {LABELS.getTicket}
              </button>
            </div>
            {model.sold !== null ? <div class="sold">{say('soldLine', { sold: model.sold, shards: model.shards })}</div> : null}
          </div>
        </article>
      </div>
      {children}
    </div>
  );
};

const SPEND_LABEL = { handBack: LABELS.handBackTx, checkIn: LABELS.checkInTx, settle: LABELS.settleTx, refund: LABELS.refundTx };

/** A ticket the wallet holds (or held): seat, money, stamp, actions. */
export const Ticket = ({ model, flow, network, fresh, onHandBack, onWalkIn, onAction, onCancel, settleProgress }) => {
  const prevState = usePrevious(model.state);
  const moneyRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  const justStamped = prevState !== undefined && prevState !== model.state && model.stamp !== null;
  const [thud, setThud] = useState(false);
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
  const spendLabel = SPEND_LABEL[model.state === 'refunded' ? model.refundPath ?? 'refund' : model.state === 'handedBack' ? 'handBack' : model.state === 'walkedIn' ? 'checkIn' : ''] ?? null;

  return (
    <div class={`printed${fresh ? ' fresh' : ''}`} data-ticket={model.key} data-state={model.state}>
      <div class="ticket-shadow">
        <article class={`ticket mine${held ? '' : ' done'}${thud ? ' stamped' : ''}`} style={bandStyle(model.kind)} aria-label={`${LABELS.yourTicket} ${model.seat}`}>
          <div class="band" />
          <div class="face">
            <div class="kicker">
              <span>{LABELS.admitOne}</span>
              <span class="serial">No. {model.serial}</span>
            </div>
            <div class="seat-row">
              <div>
                <div class="seat-label">{LABELS.seat}</div>
                <div class="seat" ref={moneyRef}>
                  {model.seat}
                </div>
              </div>
              <div class="show-name">{model.title}</div>
            </div>
            <div class="lines">
              {model.lines.map((line) => (
                <p key={line}>
                  {held && line.startsWith('Your ') ? <span class="coin-mark" aria-hidden="true" /> : null}
                  {line}
                </p>
              ))}
              {held && model.canHandBack && !model.autoRefund ? <p>{say('ticketHandBack')}</p> : null}
            </div>
            {held && model.settleLine && !model.autoRefund ? (
              <div class="countdown">
                <div class="bar" aria-hidden="true">
                  <i style={`width:${Math.round((settleProgress ?? 0) * 100)}%`} />
                </div>
                <p>{model.settleLine}</p>
              </div>
            ) : null}
            {model.autoRefund && (refundRunning || !held) ? <RefundTrack step={held ? flow?.step ?? 'held' : 'back'} /> : null}
            {flow?.step === 'back' && flow.returned !== undefined ? null : null}
            {flow !== undefined && flow.step !== 'done' && flow.kind !== 'refund' ? <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} /> : null}
            {refundRunning && flow.error !== undefined ? <FlowStatus flow={flow} onAction={onAction} onCancel={onCancel} /> : null}
            {doorFlow?.step === 'door' ? (
              <div class="flow" role="status">
                <div class="line">
                  <span class="spin" aria-hidden="true" />
                  <span>{say('walkedIn')}</span>
                </div>
              </div>
            ) : null}
            {doorFlow?.link ? (
              <div class="flow" role="status">
                <div class="line">
                  <span>{say('doorAnswered')}</span>
                </div>
                <div class="actions">
                  <a class="btn small" href={doorFlow.link} target="_blank" rel="noopener noreferrer">
                    {LABELS.openEvent}
                  </a>
                </div>
              </div>
            ) : null}
            {doorFlow?.doorError ? (
              <div class="flow error" role="alert">
                <div class="line">
                  <span>{say('doorDown')}</span>
                </div>
                <div class="actions">
                  <button type="button" class="btn small" onClick={() => onAction('retryDoor')}>
                    {LABELS.tryAgain}
                  </button>
                </div>
              </div>
            ) : null}
            {confirming && model.canWalkIn ? (
              <div class="flow" role="alertdialog" aria-label={LABELS.walkIn}>
                <div class="line">
                  <span>{say('checkInFinal')}</span>
                </div>
                <div class="actions">
                  <button
                    type="button"
                    class="btn small"
                    onClick={() => {
                      setConfirming(false);
                      onWalkIn();
                    }}
                  >
                    {LABELS.walkInNow}
                  </button>
                  <button type="button" class="btn quiet small" onClick={() => setConfirming(false)}>
                    {LABELS.notYet}
                  </button>
                </div>
              </div>
            ) : null}
            {(showHandBack || model.canWalkIn) && !confirming && !actionBusy ? (
              <div class="act">
                {model.canWalkIn ? (
                  <button type="button" class="btn small" onClick={() => setConfirming(true)} data-walk-in={model.key}>
                    {LABELS.walkIn}
                  </button>
                ) : null}
                {showHandBack ? (
                  <button type="button" class="btn ghost small" onClick={onHandBack} data-hand-back={model.key}>
                    {LABELS.handBack}
                  </button>
                ) : null}
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
