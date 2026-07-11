function ipv4Octets(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function ipv6Hextets(value: string): string[] | null {
  const address = value.toLowerCase().split('%', 1)[0];
  if (!address || (address.match(/::/g)?.length ?? 0) > 1) return null;

  const expandSide = (side: string): string[] | null => {
    if (!side) return [];
    const result: string[] = [];
    for (const part of side.split(':')) {
      const embeddedV4 = ipv4Octets(part);
      if (embeddedV4) {
        result.push(
          ((embeddedV4[0] << 8) | embeddedV4[1]).toString(16),
          ((embeddedV4[2] << 8) | embeddedV4[3]).toString(16),
        );
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        result.push(part);
      } else {
        return null;
      }
    }
    return result;
  };

  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = expandSide(leftRaw);
  const right = expandSide(rightRaw);
  if (!left || !right) return null;

  if (!address.includes('::')) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<string>(missing).fill('0'), ...right];
}

// A privacy-conscious comparison key for account-sharing heuristics. Raw IP remains in
// the observation for review, but diversity is measured at a stable network prefix so
// DHCP churn and IPv6 privacy addresses do not count as separate locations by default.
export function networkKeyForIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ipv4Octets(ip);
  if (v4) return `v4:${v4[0]}.${v4[1]}.${v4[2]}.0/24`;

  const v6 = ipv6Hextets(ip);
  if (v6) return `v6:${v6.slice(0, 4).map((part) => part.padStart(4, '0')).join(':')}::/64`;
  return null;
}
