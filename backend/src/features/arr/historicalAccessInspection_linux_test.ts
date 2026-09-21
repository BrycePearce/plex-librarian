import { strictEqual } from 'node:assert';
import { access, constants } from 'node:fs/promises';
import {
  HistoricalAccessError,
  inspectHistoricalAccessSample,
} from './historicalAccessInspection.ts';

const root = Deno.env.get('HISTORICAL_ACCESS_FIXTURE');
const scenario = Deno.env.get('HISTORICAL_ACCESS_CASE');
Deno.test({
  name: `OS access diagnostic: ${scenario ?? 'requires disposable Linux gate'}`,
  ignore: Deno.build.os !== 'linux' || !root,
  fn: async () => {
    const path = root! + '/' + scenario;
    const snapshot = await Deno.stat(path);
    let diagnostic;
    try {
      diagnostic = await inspectHistoricalAccessSample(path, path + '/sample');
    } catch (error) {
      if (!(error instanceof HistoricalAccessError)) throw error;
      diagnostic = error.diagnostic;
    }
    if (scenario === 'root') {
      strictEqual(Deno.uid(), 0);
      strictEqual(Deno.gid(), 0);
      strictEqual(snapshot.uid, 99);
      strictEqual(snapshot.gid, 100);
      strictEqual(snapshot.mode! & 0o777, 0o775);
      const old = await access(path, constants.R_OK | constants.W_OK | constants.X_OK).then(
        () => 'allowed',
        () => 'EACCES',
      );
      console.info('Deno ' + Deno.version.deno + ' old node access: ' + old);
      strictEqual(old, 'EACCES');
      strictEqual(diagnostic, null);
    } else if (scenario === 'denied') {
      strictEqual(Deno.uid(), 65534);
      strictEqual(diagnostic?.code, 'access_denied');
    } else if (scenario === 'group') {
      strictEqual(Deno.uid(), 65534);
      strictEqual(Deno.gid(), 65534);
      strictEqual(snapshot.gid, 100);
      strictEqual(snapshot.mode! & 0o777, 0o770);
      strictEqual(diagnostic, null);
    } else if (scenario === 'readonly') strictEqual(diagnostic?.code, 'read_only');
    else if (scenario === 'absent') strictEqual(diagnostic?.code, 'sample_absent');
    const after = await Deno.stat(path);
    strictEqual(after.mtime?.getTime(), snapshot.mtime?.getTime());
    strictEqual(after.mode, snapshot.mode);
    const missing = await inspectHistoricalAccessSample(
      root! + '/missing',
      root! + '/missing/sample',
    ).catch((error) => error);
    strictEqual(missing.diagnostic.code, 'missing_root');
  },
});
