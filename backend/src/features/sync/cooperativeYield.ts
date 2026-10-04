// Awaiting the SQLite proxy only drains microtasks: its native work completes
// synchronously. During long write phases, periodically let HTTP, SSE and timers
// run. Call only between statements/transactions so atomic writes stay atomic.
// A 50ms budget keeps long phases responsive without paying timer scheduling
// overhead for every fast batch. One statement can still exceed this budget.
export function createSyncYield(budgetMs = 50): () => Promise<void> {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield < budgetMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYield = performance.now();
  };
}
