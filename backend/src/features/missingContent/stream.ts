/** Bounded, incremental parser for Radarr's unpaged JSON object array. */
export async function* objectArray(
  body: ReadableStream<Uint8Array>,
  maxBytes = 512 * 1024 * 1024,
  maxRecordBytes = 1024 * 1024,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let state: 'start' | 'value' | 'object' | 'comma' | 'end' = 'start';
  let allowEnd = true;
  let text = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  try {
    while (true) {
      const part = await reader.read();
      bytes += part.value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new Error('Radarr inventory exceeds response budget');
      const chunk = decoder.decode(part.value, { stream: !part.done });
      // Scan delimiters without allocating a string node for every character.
      // Only retain the current record, joining at chunk and record boundaries.
      let recordStart = state === 'object' ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (state === 'object') {
          if (text.length + i - recordStart + 1 > maxRecordBytes / 2) {
            throw new Error('Radarr record exceeds budget');
          }
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') depth--;
          if (depth === 0) {
            yield JSON.parse(text + chunk.slice(recordStart, i + 1));
            text = '';
            recordStart = -1;
            state = 'comma';
          }
        } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
        else if (state === 'start' && c === '[') state = 'value';
        else if (state === 'value' && c === '{') {
          state = 'object';
          text = '';
          recordStart = i;
          depth = 1;
        } else if ((state === 'comma' || state === 'value' && allowEnd) && c === ']') state = 'end';
        else if (state === 'comma' && c === ',') {
          state = 'value';
          allowEnd = false;
        } else throw new Error('Invalid Radarr inventory JSON');
      }
      if (state === 'object') text += chunk.slice(recordStart);
      if (part.done) break;
    }
    if (state !== 'end') throw new Error('Incomplete Radarr inventory');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
