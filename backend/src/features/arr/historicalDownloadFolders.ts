import { historicalMountEntry } from '../mediaDeletion/historicalDownloadIdentity.ts';

/** UI suggestions only; mounting a folder does not authorize historical cleanup. */
export async function historicalDownloadFolders(
  readMounts = () =>
    Deno.build.os === 'linux' ? Deno.readTextFile('/proc/self/mountinfo') : Promise.resolve(''),
  inspect: (path: string) => Promise<Pick<Deno.FileInfo, 'isDirectory'>> = Deno.lstat,
): Promise<string[]> {
  try {
    const mounts = await readMounts();
    const folders: string[] = [];
    // Only recognize conventional download mount targets, never arbitrary media
    // or app-data mounts. Do not walk the filesystem or infer service namespaces.
    for (const path of ['/downloads', '/cleanup-downloads']) {
      try {
        const { mount } = historicalMountEntry(path, mounts);
        if (mount.split(' ')[4] !== path) continue;
        if ((await inspect(path)).isDirectory) folders.push(path);
      } catch { /* Missing, inaccessible or ambiguous mounts are not suggestions. */ }
    }
    return folders;
  } catch {
    return [];
  }
}
