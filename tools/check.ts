// Collect entry points without shell glob expansion or generated runtime directories.
export async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await sourceFiles(path));
    else if (entry.isFile && /\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

if (import.meta.main) {
  const files = (await Promise.all(
    ['backend/src', 'frontend/src', 'shared', 'tools'].map(sourceFiles),
  )).flat();
  const result = await new Deno.Command(Deno.execPath(), {
    args: ['check', ...files],
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  Deno.exit(result.code);
}
