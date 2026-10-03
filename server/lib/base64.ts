type FromBase64 = (input: string) => Uint8Array<ArrayBuffer>;

/** Decodes standard base64. Uses the native `Uint8Array.fromBase64` when the runtime has it. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64;
  if (native) return native(input);
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encodes small payloads (JWT segments) as unpadded base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
