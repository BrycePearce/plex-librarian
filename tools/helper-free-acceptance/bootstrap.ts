// Generates fresh local fixture configuration only; never invokes Docker or an API.
const destination = new URL('./.runtime/', import.meta.url);
try {
  await Deno.stat(destination);
  throw new Error('Fixture state already exists. Use its credentials; do not overwrite a run.');
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

const secret = () => crypto.randomUUID().replaceAll('-', '');
const credentials = { sonarrApiKey: secret(), radarrApiKey: secret() };
await Deno.mkdir(destination, { recursive: true });
for (
  const [service, port, apiKey] of [
    ['sonarr', 8989, credentials.sonarrApiKey],
    ['radarr', 7878, credentials.radarrApiKey],
  ] as const
) {
  await Deno.writeTextFile(
    new URL(`${service}.xml`, destination),
    `<Config><BindAddress>*</BindAddress><Port>${port}</Port><ApiKey>${apiKey}</ApiKey><AuthenticationMethod>External</AuthenticationMethod><AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired><LaunchBrowser>False</LaunchBrowser></Config>\n`,
    { createNew: true },
  );
}
await Deno.writeTextFile(
  new URL('qBittorrent.conf', destination),
  '[Preferences]\nWebUI\\Port=8080\nWebUI\\Username=acceptance\nDownloads\\SavePath=/downloads-root/payloads/\n',
  { createNew: true },
);
await Deno.writeTextFile(
  new URL('credentials.json', destination),
  JSON.stringify(credentials, null, 2) + '\n',
  { createNew: true },
);
console.log(
  'Generated ignored disposable configuration. No containers or service calls performed.',
);
