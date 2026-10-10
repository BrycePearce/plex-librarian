import { deepStrictEqual } from 'node:assert/strict';
import { sourceFiles } from './check.ts';

Deno.test('type-check discovery includes nested TSX and declarations but excludes runtime probes', async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const directory of ['routes/nested', '.runtime', 'node_modules']) {
      await Deno.mkdir(`${root}/${directory}`, { recursive: true });
    }
    for (
      const file of [
        'main.ts',
        'routes/nested/view.tsx',
        'types.d.ts',
        'style.css',
        '.runtime/old.ts',
        'node_modules/dependency.ts',
      ]
    ) {
      await Deno.writeTextFile(`${root}/${file}`, '');
    }
    deepStrictEqual(
      await sourceFiles(root),
      [
        `${root}/main.ts`,
        `${root}/routes/nested/view.tsx`,
        `${root}/types.d.ts`,
      ].sort(),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
