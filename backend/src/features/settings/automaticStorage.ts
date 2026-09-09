import { createHash } from 'node:crypto';
import {
  configuredStoragePath,
  type ProposedServiceRoot,
  type ServicePathRoot,
  type ServiceStorageAutomation,
  type ServiceStorageEndpoint,
  storageContains,
  storagePath,
} from '../../../../shared/serviceStorage.ts';

/** Discovery suggests a layout; only explicit confirmation grants it authority. */
export function automaticStorage(
  endpoints: ServiceStorageEndpoint[],
  roots: ServicePathRoot[],
): ServiceStorageAutomation {
  const complete = evaluateAutomaticStorage(endpoints, roots);
  if (complete.status !== 'unavailable') return complete;
  // Arr is an optional destination. All Plex libraries and configured download
  // clients remain in the base scope because retained ownership depends on them.
  const included = endpoints.filter((endpoint) => !endpoint.key.startsWith('arr:'));
  let available = evaluateAutomaticStorage(included, roots);
  if (available.status === 'unavailable') return complete;
  const unavailableServices: NonNullable<ServiceStorageAutomation['unavailableServices']> = [];
  for (
    const endpoint of endpoints.filter((entry) =>
      entry.key.startsWith('arr:') && entry.supportedMedia !== false
    ).sort((a, b) => a.key.localeCompare(b.key))
  ) {
    const next = evaluateAutomaticStorage([...included, endpoint], roots);
    if (next.status === 'unavailable') {
      unavailableServices.push({
        serviceKey: endpoint.key,
        name: endpoint.name,
        reason: next.reason ?? 'Automatic setup is unavailable for this service.',
      });
    } else {
      included.push(endpoint);
      available = next;
    }
  }
  return { ...available, unavailableServices };
}

function evaluateAutomaticStorage(
  endpoints: ServiceStorageEndpoint[],
  roots: ServicePathRoot[],
): ServiceStorageAutomation {
  const relevant = endpoints.filter((endpoint) => endpoint.supportedMedia !== false);
  const unavailable = (reason: string): ServiceStorageAutomation => ({
    status: 'unavailable',
    reason,
  });
  if (!relevant.some((endpoint) => endpoint.key.startsWith('plex:'))) {
    return unavailable('No movie or TV library is available for coordinated deletion.');
  }
  if (
    relevant.some((endpoint) => endpoint.key.startsWith('plex:') && !endpoint.connectionTestedAt)
  ) {
    return unavailable('Test the Plex connection before using deletion.');
  }
  if (!relevant.some((endpoint) => !endpoint.key.startsWith('plex:'))) {
    return { status: 'ready', reason: 'Plex deletion needs no cross-service storage setup.' };
  }
  if (
    relevant.some((endpoint) =>
      endpoint.discoveryError || !endpoint.connectionTestedAt || !endpoint.roots.length
    )
  ) {
    return unavailable(
      'Storage discovery is incomplete. Test connections and refresh before enabling coordinated deletion.',
    );
  }
  const saved = roots.filter((root) =>
    relevant.some((endpoint) => endpoint.key === root.serviceKey)
  );
  if (
    saved.some((root) =>
      root.hasAliases ||
      relevant.find((endpoint) => endpoint.key === root.serviceKey)?.configurationIdentity !==
        root.configurationIdentity
    )
  ) {
    return unavailable(
      'An existing storage relationship has aliases or a changed connection. Coordinated deletion remains unavailable until that conflict is resolved.',
    );
  }
  try {
    for (const [index, root] of saved.entries()) {
      if (
        saved.slice(index + 1).some((other) =>
          other.serviceKey === root.serviceKey && (
            storageContains(root.serviceRoot, other.serviceRoot, false) ||
            storageContains(other.serviceRoot, root.serviceRoot, false) ||
            storageContains(root.storageRoot, other.storageRoot, false) ||
            storageContains(other.storageRoot, root.storageRoot, false)
          )
        )
      ) throw new Error('Overlapping saved relationships');
    }
    const missing = relevant.filter((endpoint) =>
      endpoint.roots.some((path) => {
        const matches = saved.filter((root) =>
          root.serviceKey === endpoint.key &&
          storageContains(root.serviceRoot, path, root.caseSensitive)
        );
        if (matches.length > 1) throw new Error('Overlapping saved relationships');
        return !matches.length;
      })
    );
    if (!missing.length) {
      return {
        status: 'ready',
        reason: 'Saved storage relationships apply automatically to these services.',
      };
    }
    const sharedRoot = '/data';
    if (
      relevant.some((endpoint) => endpoint.roots.some((path) => !storageContains(sharedRoot, path)))
    ) {
      return unavailable(
        'These services use different storage layouts. Automatic coordinated deletion setup is unavailable for this layout; independently eligible actions remain available.',
      );
    }
    // Never replace narrow, translated, stale, or conflicting saved authority.
    if (
      missing.some((endpoint) => saved.some((root) => root.serviceKey === endpoint.key)) ||
      saved.some((root) =>
        !root.caseSensitive || storagePath(root.serviceRoot) !== storagePath(root.storageRoot)
      )
    ) {
      return unavailable(
        'The proposed shared layout conflicts with existing storage relationships. Coordinated deletion remains unavailable until that conflict is resolved.',
      );
    }
    for (const endpoint of relevant.filter((entry) => !missing.includes(entry))) {
      for (const path of endpoint.roots) {
        if (configuredStoragePath(saved, endpoint.key, path) !== storagePath(path)) {
          throw new Error('Conflicting translation');
        }
      }
    }
    const relationships: ProposedServiceRoot[] = missing.flatMap((endpoint) => {
      // Keep section evidence narrow so a TV selection can exclude disjoint movie
      // libraries. The user confirms the group once, not each generated prefix.
      const discovered = [...new Set(endpoint.roots.map(storagePath))];
      const prefixes = endpoint.key.startsWith('plex:')
        ? discovered.filter((path) =>
          !discovered.some((other) => other !== path && storageContains(other, path))
        )
        : [sharedRoot];
      if (
        prefixes.some((path, index) =>
          prefixes.slice(index + 1).some((other) =>
            storageContains(path, other, false) || storageContains(other, path, false)
          )
        )
      ) throw new Error('Case-ambiguous discovered roots');
      return prefixes.map((prefix) => ({
        serviceKey: endpoint.key,
        configurationIdentity: endpoint.configurationIdentity,
        serviceRoot: prefix,
        storageRoot: prefix,
        caseSensitive: true,
        hasAliases: false,
      }));
    }).sort((a, b) =>
      a.serviceKey.localeCompare(b.serviceKey) || a.serviceRoot.localeCompare(b.serviceRoot)
    );
    const evidence = relevant.map((endpoint) => ({
      key: endpoint.key,
      identity: endpoint.configurationIdentity,
      roots: endpoint.roots.map(storagePath).sort(),
    })).sort((a, b) => a.key.localeCompare(b.key));
    const fingerprint = createHash('sha256').update(JSON.stringify({
      policy: 1,
      evidence,
      roots: [...roots].sort((a, b) => a.id - b.id),
      relationships,
    })).digest('hex');
    return {
      status: 'confirmation_required',
      proposal: {
        fingerprint,
        sharedRoot,
        serviceNames: relevant.map((endpoint) => endpoint.name),
        relationships,
      },
    };
  } catch {
    return unavailable(
      'Storage relationships are overlapping or ambiguous. Coordinated deletion remains unavailable until that conflict is resolved.',
    );
  }
}
