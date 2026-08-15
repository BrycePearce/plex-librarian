import type { DuplicateEpisodeGroup } from '../types.ts';

export interface SeasonPathEvidence {
  originalPath: string | null;
  normalizedPath: string | null;
  containingDirectoryKey: string | null;
  releaseRootKey: string | null;
  releaseRootLabel: string | null;
  filenameFamilyKey: string | null;
}

type PathPlatform = 'posix' | 'windows-drive' | 'unc' | 'relative';

function normalizedPathParts(rawPath: string): {
  platform: PathPlatform;
  normalizedPath: string;
  prefix: string;
  parts: string[];
} | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const slashed = trimmed.replaceAll('\\', '/');
  let platform: PathPlatform = 'relative';
  let prefix = '';
  let remainder = slashed;
  if (/^\/\/[^/]+\/[^/]+(?:\/|$)/.test(slashed)) {
    platform = 'unc';
    const match = slashed.match(/^\/\/([^/]+)\/([^/]+)/)!;
    prefix = `//${match[1]}/${match[2]}`;
    remainder = slashed.slice(match[0].length);
  } else if (/^[A-Za-z]:\//.test(slashed)) {
    platform = 'windows-drive';
    prefix = slashed.slice(0, 2);
    remainder = slashed.slice(2);
  } else if (slashed.startsWith('/')) {
    platform = 'posix';
    prefix = '/';
    remainder = slashed.slice(1);
  }
  const parts = remainder.split(/\/+/).filter(Boolean);
  if (parts.length === 0) return null;
  const normalizedPath = platform === 'unc'
    ? `${prefix}/${parts.join('/')}`
    : platform === 'windows-drive'
    ? `${prefix}/${parts.join('/')}`
    : platform === 'posix'
    ? `/${parts.join('/')}`
    : parts.join('/');
  return { platform, normalizedPath, prefix, parts };
}

function platformKey(value: string, platform: PathPlatform): string {
  return platform === 'windows-drive' || platform === 'unc' ? value.toLowerCase() : value;
}

function composeDirectory(
  prefix: string,
  parts: readonly string[],
  platform: PathPlatform,
): string {
  if (platform === 'unc' || platform === 'windows-drive') return `${prefix}/${parts.join('/')}`;
  if (platform === 'posix') return `/${parts.join('/')}`;
  return parts.join('/');
}

export function seasonPathEvidence(path: string | null | undefined): SeasonPathEvidence {
  const originalPath = path ?? null;
  if (originalPath === null) {
    return {
      originalPath: null,
      normalizedPath: null,
      containingDirectoryKey: null,
      releaseRootKey: null,
      releaseRootLabel: null,
      filenameFamilyKey: null,
    };
  }
  const parsed = normalizedPathParts(originalPath);
  if (!parsed) {
    return {
      originalPath,
      normalizedPath: null,
      containingDirectoryKey: null,
      releaseRootKey: null,
      releaseRootLabel: null,
      filenameFamilyKey: null,
    };
  }
  const directoryParts = parsed.parts.slice(0, -1);
  const absolute = parsed.platform !== 'relative';
  const containing = directoryParts.length > 0
    ? composeDirectory(parsed.prefix, directoryParts, parsed.platform)
    : null;
  let releaseParts: string[] | null = null;
  if (absolute && directoryParts.length > 0) {
    for (let index = directoryParts.length - 1; index >= 0; index--) {
      if (/^(?:season\s*\d{1,2}|specials)$/i.test(directoryParts[index]!)) {
        releaseParts = directoryParts.slice(0, index);
        break;
      }
    }
    releaseParts ??= directoryParts;
  }
  const qualifiedDepth = releaseParts !== null && releaseParts.length >= 1;
  const releaseRoot = qualifiedDepth
    ? composeDirectory(parsed.prefix, releaseParts!, parsed.platform)
    : null;
  return {
    originalPath,
    normalizedPath: parsed.normalizedPath,
    containingDirectoryKey: containing ? platformKey(containing, parsed.platform) : null,
    releaseRootKey: releaseRoot ? platformKey(releaseRoot, parsed.platform) : null,
    releaseRootLabel: releaseParts?.at(-1) ?? null,
    filenameFamilyKey: null,
  };
}

const FILENAME_TECHNICAL_TOKENS = new Set([
  'aac',
  'ac3',
  'atmos',
  'av1',
  'avc',
  'bluray',
  'bdrip',
  'dl',
  'dd',
  'ddp',
  'dolbyvision',
  'dts',
  'dv',
  'flac',
  'h264',
  'h265',
  'hdr',
  'hdr10',
  'hdtv',
  'hevc',
  'proper',
  'repack',
  'remux',
  'sdr',
  'truehd',
  'uhd',
  'web',
  'webdl',
  'webrip',
  'x264',
  'x265',
]);

function filenameTokens(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function technicalFilenameToken(token: string): boolean {
  return FILENAME_TECHNICAL_TOKENS.has(token) ||
    /^\d{3,4}p$/.test(token) ||
    /^\d{1,2}bit$/.test(token) ||
    /^(?:s\d{1,3}e\d{1,4}|\d{1,3}x\d{1,4})$/.test(token) ||
    /^\d+v\d+$/.test(token) ||
    /^(?:ddp?|dts|aac|flac|opus)\d+$/.test(token) ||
    /^\d(?:\d|\.\d)?ch$/.test(token);
}

/** Conservative recurring identity left after known title, episode, and technical tokens. */
export function seasonFilenameFamilyKey(
  path: string | null | undefined,
  episode: Pick<DuplicateEpisodeGroup, 'showTitle' | 'episodeTitle'>,
): string | null {
  if (!path) return null;
  const basename = path.trim().replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
  if (!basename) return null;
  const stem = basename.replace(/\.[a-z0-9]{1,8}$/i, '');
  const titleTokens = new Set(filenameTokens(`${episode.showTitle} ${episode.episodeTitle}`));
  const family = filenameTokens(stem).filter((token) =>
    token.length > 1 && !/^\d+$/.test(token) && !titleTokens.has(token) &&
    !['season', 'episode', 'episodes', 'special', 'specials'].includes(token) &&
    !technicalFilenameToken(token)
  );
  return family.length > 0 ? family.join('.') : null;
}

export function seasonVersionSourceHint(path: string | null | undefined): string | null {
  return seasonPathEvidence(path).releaseRootLabel;
}
