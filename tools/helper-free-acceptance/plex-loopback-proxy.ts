// Disposable unclaimed-Plex adapter only. Run in the test Plex network namespace.
// Every request reaches native PMS; no catalogs, responses or delete effects are mocked.
// This exercises native deletion, not claimed-server authentication acceptance.
const faultFile = Deno.args.includes('--inject-response-loss') ? '/fixture-fault.json' : null;
const injected = new Set<string>();
Deno.serve({ port: 32500, hostname: '0.0.0.0' }, async (request) => {
  const incoming = new URL(request.url);
  const destination = new URL(incoming.pathname + incoming.search, 'http://127.0.0.1:32400');
  try {
    let loseResponse = false;
    if (faultFile && request.method === 'DELETE') {
      const fault = JSON.parse(await Deno.readTextFile(faultFile));
      loseResponse = fault.deletePath === incoming.pathname && !injected.has(incoming.pathname);
    }
    const response = await fetch(new Request(destination, request));
    if (request.method === 'DELETE') {
      console.log(JSON.stringify({
        event: 'native_delete',
        path: incoming.pathname,
        status: response.status,
        loseResponse,
      }));
    }
    if (loseResponse && response.ok) {
      await response.arrayBuffer();
      injected.add(incoming.pathname);
      // Native PMS has already answered successfully; simulate an upstream
      // gateway losing that success. Never report this as native service failure.
      return new Response('Injected loss after native success', { status: 502 });
    }
    return response;
  } catch {
    return new Response('Disposable native Plex unavailable', { status: 502 });
  }
});
