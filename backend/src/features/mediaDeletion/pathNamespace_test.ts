import { assertRejects } from '@std/assert';
import { lstatChain } from './pathNamespace.ts';

Deno.test('local identity rejects a symlink in any parent component', async () => {
  const root = await Deno.makeTempDir();
  try {
    const real = `${root}/real`;
    const alias = `${root}/alias`;
    await Deno.mkdir(real);
    await Deno.writeTextFile(`${real}/file.mkv`, 'video');
    try {
      await Deno.symlink(real, alias, { type: 'dir' });
      await assertRejects(
        () => lstatChain(`${alias}/file.mkv`),
        Error,
        'Symbolic links are unavailable',
      );
    } catch (error) {
      if (
        Deno.build.os !== 'windows' || !(error instanceof Error) ||
        !/privilege/i.test(error.message)
      ) throw error;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
