// Doorstub, the public site. See app/src/lib/controller.js for what it does.
import { render } from 'preact';
import './styles.css';
import { TEST_HOOKS, runtime } from './env.js';
import { createApi } from './lib/api.js';
import { createController } from './lib/controller.js';
import { devTools } from './lib/dev.js';
import { fetchUsdPerBch } from './lib/price.js';
import { App } from './components/App.jsx';

if (!TEST_HOOKS) {
  // WizardConnect logs every relay message with console.log under a "[relay]"-style
  // scope; keep a production console quiet without touching the library.
  const log = console.log.bind(console);
  console.log = (...args) => {
    if (typeof args[0] === 'string' && /^\[(?:relay|network|misc)\]$/.test(args[0])) return;
    log(...args);
  };
}

const fetchShows = async () => {
  const response = await fetch(runtime.showsUrl, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`shows.json answered ${response.status}`);
  return response.text();
};

const controller = createController({
  runtime,
  deps: {
    api: createApi({ origin: runtime.apiOrigin }),
    fetchShows,
    fetchUsd: runtime.usd === undefined ? () => fetchUsdPerBch() : async () => null,
    dappIcon: `${globalThis.location.origin}/icon.png`,
    keeper: runtime.pageKeeper !== false,
    ...(runtime.relayUrls !== undefined && { relayUrls: runtime.relayUrls }),
  },
});

// Simnet and dev builds only: the dev panel's helpers, and a handle for the E2E.
const dev = TEST_HOOKS ? devTools(controller) : undefined;
if (TEST_HOOKS) globalThis.__doorstub = { controller, dev };

render(<App controller={controller} dev={dev} />, document.getElementById('app'));
controller.start();
