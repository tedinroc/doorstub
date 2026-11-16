import { useEffect, useState } from 'preact/hooks';
import { nextOpenInstance, showsOnSale } from '../../../src/shows/schedule.js';
import { formatBch } from '../../../src/shows/format.js';
import { TEST_HOOKS } from '../env.js';
import { LABELS, say } from '../lib/copy.js';
import { listedShows, num, showCardModel, ticketModel } from '../lib/view.js';
import { useNow, useStore } from '../hooks.js';
import { ConnectDialog } from './connect.jsx';
import { Banner, CheckIt, DevPanel, Footer, Header, Hero, HowItWorks, ProofStrip } from './sections.jsx';
import { ShowCard, Ticket } from './tickets.jsx';

const keyOf = (t) => `${t.showId}:${t.seatHex}`;
const FRESH_MS = 12_000;

export const App = ({ controller, dev }) => {
  const state = useStore(controller.store);
  const now = useNow(20_000);
  const [drawer, setDrawer] = useState(false);
  const tip = state.chain.tip;
  const onSale = tip === null ? [] : showsOnSale(state.shows, tip);
  const nextA = tip === null ? null : nextOpenInstance(state.shows, tip);
  const touched = controller.touched();
  const cap = state.shows[0]?.minerFeeCap ?? 1500n;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') setDrawer(false);
    };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, []);

  // Held tickets first, then the newest (a buy still in the mempool counts as newest).
  const age = (t) => (t.buy?.height ? t.buy.height : Number.MAX_SAFE_INTEGER);
  const tickets = [...state.tickets]
    .sort((a, b) => (a.state === 'held') - (b.state === 'held') || age(a) - age(b))
    .reverse()
    .map((t) => ({
      ticket: t,
      model: ticketModel(t, { tip: tip ?? undefined, now, returned: state.returned[keyOf(t)] ?? null }),
    }));
  // This wallet's tickets shown under a show card: held ones, and any this page acted on.
  const mineOf = (show) => tickets.filter(({ ticket }) => ticket.showId === show.id && (ticket.state === 'held' || touched.has(keyOf(ticket))));
  const listed = tip === null ? [] : listedShows({ shows: state.shows, onSale, tickets: state.tickets, touched });
  const freshKeys = new Set(
    Object.values(state.flows)
      .filter((f) => f?.kind === 'buy' && f.step === 'done' && f.ticketKey && now - f.at < FRESH_MS + 30_000)
      .map((f) => f.ticketKey),
  );

  const ticketAction = (key) => (action) => {
    const flow = state.flows[key];
    if (action === 'dismiss') return controller.dismiss(key);
    if (action === 'connect') return controller.connect();
    if (action === 'retryDoor') return controller.retryDoor(key);
    if (action === 'retryRefund') return controller.retryRefund(key);
    if (action === 'reload') return globalThis.location?.reload();
    if (action === 'retry') {
      if (flow?.kind === 'walkIn') return controller.walkIn(key);
      if (flow?.kind === 'refund') return controller.retryRefund(key);
      return controller.handBack(key);
    }
    return undefined;
  };

  const buyAction = (showId) => (action) => {
    if (action === 'dismiss') return controller.dismiss(showId);
    if (action === 'retry') return controller.buy(showId);
    if (action === 'nextInstance') {
      controller.dismiss(showId);
      return nextA ? controller.buy(nextA.id) : undefined;
    }
    if (action === 'connect') return controller.connect();
    if (action === 'reload') return globalThis.location?.reload();
    return undefined;
  };

  const renderTicket = ({ ticket, model }, reveal = false) => {
    const key = keyOf(ticket);
    const settleAt = Number(ticket.show.startHeight) + Number(ticket.show.graceBlocks) + 1;
    const left = tip === null ? 1 : Math.max(0, settleAt - 1 - tip);
    return (
      <Ticket
        key={key}
        model={model}
        flow={state.flows[key]}
        network={state.network}
        fresh={freshKeys.has(key)}
        reveal={reveal}
        settleProgress={1 - Math.min(1, left / 40)}
        onHandBack={() => controller.handBack(key)}
        onWalkIn={() => controller.walkIn(key)}
        onAction={ticketAction(key)}
        onCancel={() => controller.cancelSign()}
      />
    );
  };

  const walletNotice = state.wallet.error && !state.connectOpen && state.wallet.state !== 'connected' ? state.wallet.error : null;

  return (
    <>
      <Banner />
      <Header state={state} ticketCount={state.tickets.length} onConnect={() => controller.connect()} onOpenTickets={() => setDrawer(true)} />
      <main>
        <Hero state={state} />
        <section class="section" id="shows" aria-label={LABELS.getTicket}>
          <div class="wrap">
            {state.bootError ? (
              <div class="notice-box" role="alert" style="margin-bottom:16px">
                {say(state.bootError.key, state.bootError.vars)}{' '}
                {state.bootError.actions.includes('reload') ? (
                  <button type="button" class="btn small" onClick={() => globalThis.location?.reload()}>
                    {LABELS.reload}
                  </button>
                ) : null}
              </div>
            ) : null}
            {walletNotice ? (
              <div class="notice-box" role="alert" style="margin-bottom:16px">
                {say(walletNotice.key, walletNotice.vars)}{' '}
                <button type="button" class="btn small" onClick={() => controller.connect()}>
                  {LABELS.connect}
                </button>
              </div>
            ) : null}
            {state.boot === 'loading' || (state.boot === 'ready' && tip === null) ? (
              <div class="shows n2" aria-busy="true">
                <p class="sr-only">{say('showsChecking')}</p>
                <div class="skeleton" />
                <div class="skeleton" />
              </div>
            ) : state.boot === 'failed' ? null : listed.length === 0 ? (
              <div class="notice-box">{state.unverified.length > 0 && state.shows.length === 0 ? say('showUnverified') : say('showsNone')}</div>
            ) : (
              <div class={`shows n${Math.min(listed.length, 3)}`}>
                {listed.map((show) => {
                  const mine = mineOf(show);
                  return (
                    <ShowCard
                      key={show.id}
                      model={{ ...showCardModel(show, { tip, usd: state.usd, ledger: state.ledgers.get(show.id), now }), priceSats: show.price }}
                      flow={state.flows[show.id]}
                      onBuy={() => controller.buy(show.id)}
                      onAction={buyAction(show.id)}
                      onCancel={() => controller.cancelSign()}
                    >
                      {mine.length > 0 ? (
                        <>
                          <div class="slot" aria-hidden="true" />
                          {mine.map((t) => renderTicket(t, true))}
                        </>
                      ) : null}
                    </ShowCard>
                  );
                })}
              </div>
            )}
            <p class="fine-after">
              {say('smallPrint', { cap: num(cap) })} {say('keeperLine')}
            </p>
            {TEST_HOOKS ? <DevPanel state={state} dev={dev} /> : null}
          </div>
        </section>
        <ProofStrip state={state} />
        <HowItWorks cap={cap} />
        <CheckIt state={state} shows={onSale.length > 0 ? onSale : state.shows.slice(0, 3)} />
      </main>
      <Footer />
      <ConnectDialog
        open={state.connectOpen}
        wallet={state.wallet}
        onClose={() => controller.closeConnect()}
        onOtherRelay={() => controller.connect({ relay: (state.wallet.relay + 1) % 2 })}
      />
      {drawer ? (
        <div
          class="drawer"
          role="dialog"
          aria-modal="true"
          aria-label={LABELS.myTickets}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawer(false);
          }}
        >
          <div class="inner">
            <div class="head">
              <h2 class="display">{LABELS.myTickets}</h2>
              <button type="button" class="btn quiet small" onClick={() => setDrawer(false)}>
                {LABELS.close}
              </button>
            </div>
            <p class="wallet-line">
              <span>{state.wallet.balance !== null ? say('walletConnected', { name: state.wallet.name, balance: formatBch(state.wallet.balance) }) : say('walletScanning')}</span>
              <button type="button" class="linkish" onClick={() => controller.refreshWallet().catch(() => {})}>
                {LABELS.refresh}
              </button>
              <button
                type="button"
                class="linkish"
                onClick={() => {
                  setDrawer(false);
                  controller.disconnect();
                }}
              >
                {LABELS.disconnect}
              </button>
            </p>
            <div class="list">{tickets.length === 0 ? <div class="notice-box">{say('noTickets')}</div> : tickets.map((t) => renderTicket(t))}</div>
          </div>
        </div>
      ) : null}
    </>
  );
};
