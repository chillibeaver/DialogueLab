/**
 * Synthesized-audio cache in Workers KV, so identical requests are only billed once.
 * Every operation is best-effort: cache failures are logged and never fail a request.
 */

// KV values are limited to 25 MiB.
const MAX_VALUE_BYTES = 25 * 1024 * 1024;

export interface CachedAudioMeta {
  chunks: number;
  characters: number;
}

export async function cacheKey(request: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `tts:v1:${hex}`;
}

export async function readCachedAudio(
  kv: KVNamespace | undefined,
  key: string,
): Promise<{ audio: ArrayBuffer; meta: CachedAudioMeta } | null> {
  if (!kv) return null;
  try {
    const { value, metadata } = await kv.getWithMetadata<CachedAudioMeta>(key, "arrayBuffer");
    return value && metadata ? { audio: value, meta: metadata } : null;
  } catch (error) {
    console.warn("Audio cache read failed", error);
    return null;
  }
}

export async function writeCachedAudio(
  kv: KVNamespace | undefined,
  key: string,
  audio: Uint8Array,
  meta: CachedAudioMeta,
  ttlSeconds: number,
): Promise<void> {
  if (!kv || audio.byteLength > MAX_VALUE_BYTES) return;
  try {
    await kv.put(key, audio, { expirationTtl: ttlSeconds, metadata: meta });
  } catch (error) {
    console.warn("Audio cache write failed", error);
  }
}
