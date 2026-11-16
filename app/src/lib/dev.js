// Simnet-only helpers for the dev panel and the E2E: fund the connected
// wallet and mine blocks on the local simnet. Imported only behind the
// build-time test-hooks flag, so production bundles never contain them.
export const devTools = (controller) => ({
  fund: async (sats = 500_000) => {
    if (controller.store.get().network !== 'simnet') return 'simnet only';
    try {
      const scan = await controller.refreshWallet();
      if (scan === null) return 'Connect a wallet first.';
      await controller.pool.request('simnet.fund', { address: scan.receive.address, sats, mine: true });
      await controller.refreshWallet();
      return `Funded ${sats} sats on simnet.`;
    } catch (e) {
      return e.message;
    }
  },
  mine: async (blocks = 1) => {
    if (controller.store.get().network !== 'simnet') return 'simnet only';
    try {
      const r = await controller.pool.request('simnet.mine', { blocks });
      return `Mined to block ${r.height}.`;
    } catch (e) {
      return e.message;
    }
  },
});
