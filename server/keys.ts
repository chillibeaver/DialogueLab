import { ApiError } from "./errors";

/**
 * API keys for the clips endpoint. They come from the API_KEYS secret as
 * comma-separated "name:secret" entries, so each collaborator gets their own
 * key: the name shows in logs and owns a daily quota, and removing one entry
 * revokes one person without touching anyone else.
 */
export interface ApiKey {
  name: string;
  secret: string;
}

export function parseApiKeys(raw: string | undefined): ApiKey[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const colon = entry.indexOf(":");
      return colon > 0
        ? { name: entry.slice(0, colon).trim(), secret: entry.slice(colon + 1).trim() }
        : { name: `key${index + 1}`, secret: entry };
    })
    .filter((key) => key.secret.length > 0);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Compares SHA-256 digests in constant time, and checks every key rather than
 * stopping at a match, so response timing reveals neither the secret nor which
 * entry matched.
 */
export async function authenticate(raw: string | undefined, header: string | undefined): Promise<ApiKey> {
  const keys = parseApiKeys(raw);
  const unauthorized = (message: string) =>
    new ApiError(401, "unauthorized", message, { headers: { "www-authenticate": 'Bearer realm="tts-studio"' } });

  if (!keys.length) {
    console.error("API_KEYS is not set; the clips API refuses every request");
    throw unauthorized("This server does not accept API keys.");
  }
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
  if (!presented) throw unauthorized("Send your key as: Authorization: Bearer <key>");

  const given = await digest(presented);
  let match: ApiKey | null = null;
  for (const key of keys) {
    const expected = await digest(key.secret);
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ given[i];
    if (difference === 0 && !match) match = key;
  }
  if (!match) throw unauthorized("This API key is not valid.");
  return match;
}
