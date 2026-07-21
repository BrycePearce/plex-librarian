const hooks = ['.githooks/pre-commit', '.githooks/pre-push'];

for (const hook of hooks) {
  try {
    await Deno.chmod(hook, 0o755);
  } catch (error) {
    if (Deno.build.os !== 'windows') throw error;
  }
}

const command = new Deno.Command('git', {
  args: ['config', 'core.hooksPath', '.githooks'],
  stdout: 'inherit',
  stderr: 'inherit',
});
const result = await command.output();

if (!result.success) {
  throw new Error(`git config failed with exit code ${result.code}`);
}

console.log('Installed Plex Librarian Git hooks.');
