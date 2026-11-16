import { useEffect, useState } from 'preact/hooks';
import { formatBch } from '../../../src/shows/format.js';
import { BLAZE, CONTRACT_FILES, DOC_FILES, EXPLORER, WIZARDCONNECT_SOURCE, sourceFileUrl } from '../config.js';
import { TEST_HOOKS } from '../env.js';
import { LABELS, PRIOR_ART, SENTENCES, fill, say } from '../lib/copy.js';
import { num, proofModel, shortBch, showCardModel } from '../lib/view.js';
import { usePrevious } from '../hooks.js';
import { CopyButton, Logo, TxLink } from './parts.jsx';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

/** The BLAZE banner, required at the very top of the home page. */
export const Banner = () => (
  <div class="blaze" role="region" aria-label="BCH BLAZE 2026">
    <div class="wrap">
      <strong class="blaze-mark">
        BCH BLAZE <span class="flame">2026</span>
      </strong>
      <span class="blaze-links">
        {BLAZE.presentationUrl ? (
          <a href={BLAZE.presentationUrl} {...ext} data-blaze="presentation">
            {LABELS.presentation}
          </a>
        ) : (
          <span class="soon">{LABELS.presentation}</span>
        )}
        {BLAZE.sourceUrl ? (
          <a href={BLAZE.sourceUrl} {...ext} data-blaze="source">
            {LABELS.source}
          </a>
        ) : (
          <span class="soon">{LABELS.source}</span>
        )}
        <span class="donate">
          <span class="donate-word">{LABELS.donations}</span>
          {BLAZE.donationAddress ? (
            <>
              <code title={BLAZE.donationAddress}>{BLAZE.donationAddress.replace(/^bitcoincash:/, '').slice(0, 8)}…</code>
              <CopyButton text={BLAZE.donationAddress} class="chip-btn" label={LABELS.copy} />
            </>
          ) : (
            <span class="soon">…</span>
          )}
        </span>
      </span>
      <span class="line">{say('blazeLine')}</span>
    </div>
  </div>
);

export const Header = ({ state, ticketCount, onConnect, onOpenTickets }) => {
  const w = state.wallet;
  const connected = w.state === 'connected' || w.state === 'reconnecting';
  const chain = state.chain.status;
  const tip = state.chain.tip;
  return (
    <header class="top">
      <div class="wrap">
        <a class="brand" href="#top" aria-label="Doorstub">
          <Logo />
          <b>Doorstub</b>
        </a>
        <span class="chain" title={state.chain.server ?? ''}>
          <span class={`chain-dot${chain === 'connected' ? ' on' : chain === 'down' ? ' down' : ''}`} aria-hidden="true" />
          <span class="tip">{tip === null ? '' : `${LABELS.block} ${num(tip)}`}</span>
        </span>
        {TEST_HOOKS && state.network !== 'mainnet' ? <span class="net-pill">SIMNET</span> : null}
        <span class="spacer" />
        {connected ? (
          <button type="button" class="wallet-chip" data-wallet-chip onClick={onOpenTickets} aria-label={`${LABELS.myTickets}: ${ticketCount}`}>
            <span class="name">{w.name}</span>
            <span class="bal">
              {w.balance === null ? (
                '…'
              ) : (
                <>
                  {shortBch(w.balance).replace(/ BCH$/, '')}
                  <span class="unit"> BCH</span>
                </>
              )}
            </span>
            <span class="count">
              <span class="word long">{LABELS.myTickets}</span>
              <span class="word short">{LABELS.tickets}</span>
              {ticketCount > 0 ? <span class="n">{ticketCount}</span> : null}
            </span>
          </button>
        ) : (
          <button type="button" class="btn small" onClick={onConnect} data-connect>
            {LABELS.connect}
          </button>
        )}
      </div>
    </header>
  );
};

/** "Tickets that refund themselves." in four words, the third in red. */
const h = SENTENCES.headline.replace(/\.$/, '').split(' ');

export const Hero = ({ state }) => {
  const cap = state.shows[0]?.minerFeeCap ?? 1500n;
  return (
    <section class="hero" id="top">
      <div class="wrap">
        <h1 class="display">
          <span class="row">{`${h[0]} ${h[1]} `}</span>
          <span class="row">
            <span class="refund">{h[2]}</span> {h[3]}
            <span class="dot">.</span>
          </span>
        </h1>
        <div class="hero-foot">
          <p class="sub">{say('subline')}</p>
          <p class="fine">
            {say('smallPrint', { cap: num(cap) })} {say('keeperLine')}
          </p>
        </div>
      </div>
    </section>
  );
};

export const ProofStrip = ({ state }) => {
  const model = proofModel(state.proof);
  // With no show to read (an empty shows.json), there is nothing to wait for: zero, and say so.
  const loaded = state.proof !== null || (state.boot !== 'loading' && state.shows.length === 0);
  const prev = usePrevious(model.rows.map((r) => r.count).join(','));
  const now = model.rows.map((r) => r.count).join(',');
  const changed = prev !== undefined && prev !== now ? prev.split(',').map(Number) : null;
  const pushed = state.keeper.at(-1);
  return (
    <section class="section" id="proof">
      <div class="wrap">
        <div class="proof">
          <div class="head">
            <span class={`chain-dot${state.chain.status === 'connected' ? ' on' : ''}`} aria-hidden="true" />
            <h2 class="display">{state.network === 'mainnet' ? LABELS.onMainnet : LABELS.onSimnet}</h2>
            <p>{model.total === 0 && loaded ? say('proofEmpty') : say('proofIntro')}</p>
          </div>
          <div class="counts">
            {model.rows.map((row, i) => (
              <div key={row.path} class={`count${changed && changed[i] !== row.count ? ' bump' : ''}`} data-proof={row.path}>
                <div class="n" key={`${row.path}-${row.count}`}>
                  {loaded ? row.count : '…'}
                </div>
                <div class="l">{row.label}</div>
                {row.latest ? <TxLink network={state.network} label={LABELS.latest} txid={row.latest} /> : <div class="none">—</div>}
              </div>
            ))}
          </div>
          {pushed ? (
            <div class="pushed">
              {say('pushedSettle', { show: pushed.title, count: pushed.count, coins: pushed.count === 1 ? LABELS.coin : LABELS.coins })}{' '}
              <TxLink network={state.network} txid={pushed.txid} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
};

/** One diagram: a buy puts the money in an escrow coin; it leaves by one of four paths, and each says who it pays. */
export const HowItWorks = ({ cap }) => (
  <section class="section" id="how">
    <div class="wrap">
      <div class="section-head">
        <h2 class="display">{LABELS.howItWorks}</h2>
        <span class="perf" aria-hidden="true" />
      </div>
      <div class="how">
        <div class="box buy">
          <span class="tag">1 · {LABELS.buyTx}</span>
          <h3 class="display">{LABELS.getTicket}</h3>
          <p>{say('howBuy')}</p>
        </div>
        <div class="box coin-box">
          <span class="tag">2 · {LABELS.coinLink}</span>
          <h3 class="display">
            <span class="coin-mark" aria-hidden="true" />
            Escrow
          </h3>
          <p>{say('howCoin')}</p>
        </div>
        <div class="outs">
          <div class="box out green">
            <span class="tag">3 · {LABELS.checkInTx}</span>
            <h3 class="display">
              {LABELS.youWalkIn} <span class="to">→ {LABELS.toOrganiser}</span>
            </h3>
            <p>
              {say('howWalkIn')} {say('ticketNft')}
            </p>
          </div>
          <div class="box out blue">
            <span class="tag">3 · {LABELS.handBackTx} / {LABELS.settleTx}</span>
            <h3 class="display">
              {LABELS.youHandBack} <span class="to">→ {LABELS.toBuyer}</span>
            </h3>
            <p>
              {say('ticketHandBack')} {say('howSettle')}
            </p>
          </div>
          <div class="box out red">
            <span class="tag">3 · {LABELS.refundTx}</span>
            <h3 class="display">
              {LABELS.organiserRefunds} <span class="to">→ {LABELS.toBuyer}</span>
            </h3>
            <p>
              {say('howRefund', { cap: num(cap) })} {say('howOnlyBuyer')}
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
);

/** Who Doorstub is for, what an organiser gains, and how Doorstub would earn (a plan, marked as one). */
export const ForOrganisers = () => (
  <section class="section" id="organisers">
    <div class="wrap">
      <div class="section-head">
        <h2 class="display">{LABELS.forOrganisers}</h2>
        <span class="perf" aria-hidden="true" />
      </div>
      <div class="org">
        <div class="org-col">
          <h3 class="display">{LABELS.orgWho}</h3>
          <p>{say('orgWho')}</p>
        </div>
        <div class="org-col">
          <h3 class="display">{LABELS.orgGain}</h3>
          <p>{say('orgPaid')}</p>
          <p>{say('orgFees')}</p>
        </div>
        <div class="org-col plan">
          <h3 class="display">{LABELS.orgEarn}</h3>
          <p>{say('orgPlan')}</p>
        </div>
      </div>
    </div>
  </section>
);

/** "Genesis {txid} is confirmed ..." with the txid itself as the explorer link (the sentence stays CLAIMS.md's). */
const [genesisBefore, genesisAfter] = SENTENCES.checkGenesis.split('{txid}');

/** Repository files, one per line, each a link to the source (plain text until there is a repository link). */
const FileLinks = ({ files }) => (
  <ul class="files">
    {files.map((file) => {
      const url = sourceFileUrl(file);
      return (
        <li key={file}>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" data-source-file={file}>
              {file} ↗
            </a>
          ) : (
            file
          )}
        </li>
      );
    })}
  </ul>
);

const LIMIT_KEYS = ['limitBch', 'limitBefore', 'limitSeat', 'limitOrganiser', 'limitMoved', 'limitFinal', 'limitHaveBch', 'limitStuck', 'limitSales', 'limitContention'];

export const CheckIt = ({ state, shows }) => {
  const [picked, setPicked] = useState(null);
  const show = shows.find((s) => s.id === picked) ?? shows[0];
  useEffect(() => {
    if (picked !== null && !shows.some((s) => s.id === picked)) setPicked(null);
  }, [shows, picked]);
  const tip = state.chain.tip ?? 0;
  const model = show ? showCardModel(show, { tip }) : null;
  const addressLink = (address) =>
    state.network === 'mainnet' ? (
      <a href={EXPLORER.address(address)} {...ext}>
        {address} ↗
      </a>
    ) : (
      address
    );
  return (
    <section class="section" id="check">
      <div class="wrap">
        <div class="section-head">
          <h2 class="display">{LABELS.checkIt}</h2>
          <span class="perf" aria-hidden="true" />
        </div>
        <div class="checks">
          <div class="panel">
            <p>{say('checkIntro')}</p>
            {shows.length > 1 ? (
              <div class="show-tabs" role="group">
                {shows.map((s) => (
                  <button type="button" key={s.id} aria-pressed={String(s.id === show?.id)} onClick={() => setPicked(s.id)}>
                    {s.title}
                  </button>
                ))}
              </div>
            ) : null}
            {show ? (
              <div class="verify">
                <div class="row">
                  <span class="ok" aria-hidden="true" />
                  <div>
                    <div class="what">
                      {LABELS.boxOfficeAddress} · {LABELS.recomputed}
                    </div>
                    <div class="val">{addressLink(show.derived.boxOfficeTokenAddress)}</div>
                  </div>
                </div>
                <div class="row">
                  <span class="ok" aria-hidden="true" />
                  <div>
                    <div class="what">
                      {LABELS.escrowAddress} · {LABELS.recomputed}
                    </div>
                    <div class="val">{addressLink(show.derived.escrowTokenAddress)}</div>
                  </div>
                </div>
                {show.genesis ? (
                  <div class="row">
                    <span class="ok" aria-hidden="true" />
                    <div>
                      <div class="what">
                        {LABELS.genesis} · {LABELS.verified}
                      </div>
                      <div class="val text">
                        {genesisBefore}
                        <TxLink network={state.network} txid={show.genesisTxid} />
                        {fill(genesisAfter, { height: num(show.genesis.height) })}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div class="row plain">
                  <span class="dot" aria-hidden="true" />
                  <div>
                    <div class="what">{LABELS.postedFees}</div>
                    <div class="val text">{model.feesLine}</div>
                  </div>
                </div>
                <div class="row plain">
                  <span class="dot" aria-hidden="true" />
                  <div>
                    <div class="what">{LABELS.category}</div>
                    <div class="val">{show.categoryHex}</div>
                  </div>
                </div>
                <div class="row plain">
                  <span class="dot" aria-hidden="true" />
                  <div>
                    <div class="what">{LABELS.contractSource}</div>
                    <FileLinks files={CONTRACT_FILES} />
                  </div>
                </div>
                <div class="row plain">
                  <span class="dot" aria-hidden="true" />
                  <div>
                    <div class="what">{LABELS.docs}</div>
                    <FileLinks files={DOC_FILES} />
                  </div>
                </div>
              </div>
            ) : (
              <p>{say('showsChecking')}</p>
            )}
          </div>
          <div class="panel">
            <h3 class="display">{LABELS.limits}</h3>
            <ul class="limits">
              {LIMIT_KEYS.map((k) => (
                <li key={k}>{say(k)}</li>
              ))}
            </ul>
            <h3 class="display" style="margin-top:18px">
              {LABELS.testsLabel}
            </h3>
            <p>{say('checkTests')}</p>
          </div>
        </div>
      </div>
    </section>
  );
};

export const Footer = () => (
  <footer class="foot">
    <div class="wrap">
      <div class="cols">
        <div>
          <h2 class="display">{LABELS.priorArt}</h2>
          <p>{say('priorArtIntro')}</p>
          <ul>
            {PRIOR_ART.map(([name, text]) => (
              <li key={name}>
                <b>{name}</b> {text}
              </li>
            ))}
          </ul>
          <p style="margin-top:12px">{say('addsLine')}</p>
        </div>
        <div>
          <h2 class="display">{LABELS.credits}</h2>
          <ul>
            <li>
              {SENTENCES.wizardCredit}{' '}
              <a href={WIZARDCONNECT_SOURCE} {...ext}>
                Source ↗
              </a>{' '}
              · <a href="/licenses.txt">{LABELS.licences}</a>
            </li>
            <li>{say('libsCredit')}</li>
            <li>{say('aiCredit')}</li>
            <li>{say('walletLine')}</li>
          </ul>
          <div class="small">Doorstub · BCH BLAZE 2026</div>
        </div>
      </div>
    </div>
  </footer>
);

/** Simnet only (never in a production build): fund the wallet, mine blocks. */
export const DevPanel = ({ state, dev }) => {
  const [devState, setDevState] = useState({ busy: false, message: '' });
  if (state.network !== 'simnet' || dev === undefined) return null;
  const busy = devState.busy;
  const run = async (fn) => {
    setDevState({ busy: true, message: '' });
    setDevState({ busy: false, message: await fn() });
  };
  return (
    <div class="wrap">
      <div class="dev">
        <b>SIMNET</b>
        <button type="button" class="btn quiet small" disabled={busy || state.wallet.state !== 'connected'} onClick={() => run(() => dev.fund(500_000))} data-dev-fund>
          Fund wallet 0.005 BCH
        </button>
        <button type="button" class="btn quiet small" disabled={busy} onClick={() => run(() => dev.mine(1))} data-dev-mine>
          Mine 1 block
        </button>
        <button type="button" class="btn quiet small" disabled={busy} onClick={() => run(() => dev.mine(12))}>
          Mine 12 blocks
        </button>
        <span>{devState.message}</span>
      </div>
    </div>
  );
};
