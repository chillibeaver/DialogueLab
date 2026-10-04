import type { AudioFormat } from "../google/tts";

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Joins audio returned for consecutive text chunks into one file.
 *
 * - MP3: frames can simply be appended. Leading ID3v2 tags and Xing/Info/VBRI
 *   header frames are dropped, because a header describing only the first chunk
 *   would make players report the wrong duration.
 * - WAV (LINEAR16): Google returns RIFF/WAVE files; the PCM payloads are joined
 *   under a single rewritten header.
 * - OGG_OPUS: cannot be joined safely (chained Ogg is poorly supported), so
 *   callers must keep it to a single chunk.
 */
export function concatAudio(format: AudioFormat, parts: Bytes[]): Bytes {
  if (parts.length === 0) throw new Error("No audio to concatenate");
  if (parts.length === 1) return parts[0];
  switch (format) {
    case "mp3":
      return concatBytes(parts.map(stripMp3Headers));
    case "wav":
      return concatWav(parts);
    case "ogg_opus":
      throw new Error("OGG_OPUS audio cannot be concatenated");
  }
}

export function concatBytes(parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

// --- MP3 -------------------------------------------------------------------

const MP3_BITRATES_KBPS = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Byte length of the MPEG Layer III frame starting at `offset`, or 0 if there is no valid frame header. */
function mp3FrameLength(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  const [b0, b1, b2] = [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return 0; // frame sync
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return 0; // reserved version / not Layer III
  const bitrate = (version === 3 ? MP3_BITRATES_KBPS.v1 : MP3_BITRATES_KBPS.v2)[(b2 >> 4) & 0x0f];
  const sampleRate = MP3_SAMPLE_RATES[version][(b2 >> 2) & 0x03];
  if (!bitrate || !sampleRate) return 0;
  const padding = (b2 >> 1) & 0x01;
  return Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
}

export function stripMp3Headers(bytes: Bytes): Bytes {
  let offset = 0;

  // ID3v2 tag: "ID3", version (2), flags (1), syncsafe size (4).
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const hasFooter = (bytes[5] & 0x10) !== 0;
    offset = 10 + size + (hasFooter ? 10 : 0);
  }

  // A Xing/Info/VBRI tag lives inside the first audio frame, within its first ~40 bytes.
  const frameLength = mp3FrameLength(bytes, offset);
  if (frameLength > 0) {
    const head = ascii(bytes, offset, Math.min(frameLength, 64));
    if (/Xing|Info|VBRI/.test(head)) offset += frameLength;
  }

  return bytes.subarray(Math.min(offset, bytes.length));
}

// --- WAV -------------------------------------------------------------------

interface WavParts {
  fmt: Bytes;
  data: Bytes;
}

function parseWav(bytes: Bytes): WavParts {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Audio is not a RIFF/WAVE file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Bytes | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const declared = view.getUint32(offset + 4, true);
    const start = offset + 8;
    // Streaming-style headers may declare 0 or 0xFFFFFFFF for the data size; clamp to what we have.
    const size = Math.min(declared, bytes.length - start);
    if (id === "fmt ") fmt = bytes.subarray(start, start + size);
    if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk appears before fmt chunk");
      const dataSize = declared === 0 || declared === 0xffffffff ? bytes.length - start : size;
      return { fmt, data: bytes.subarray(start, start + dataSize) };
    }
    offset = start + size + (size % 2); // chunks are padded to even sizes
  }
  throw new Error("WAV file has no data chunk");
}

function concatWav(parts: Bytes[]): Bytes {
  const parsed = parts.map(parseWav);
  const fmt = parsed[0].fmt;
  for (const { fmt: other } of parsed) {
    if (other.length !== fmt.length || other.some((byte, i) => byte !== fmt[i])) {
      throw new Error("WAV chunks have different audio formats");
    }
  }

  const dataLength = parsed.reduce((sum, p) => sum + p.data.length, 0);
  const fmtPadded = fmt.length + (fmt.length % 2);
  const header = new Uint8Array(12 + 8 + fmtPadded + 8);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, header.length - 8 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, fmt.length, true);
  header.set(fmt, 20);
  const dataHeader = 20 + fmtPadded;
  writeAscii(dataHeader, "data");
  view.setUint32(dataHeader + 4, dataLength, true);

  return concatBytes([header, ...parsed.map((p) => p.data)]);
}

/**
 * Silence in the same MPEG format as `clip` (version, bitrate, sample rate,
 * channels), so it can be joined to it: whole frames with zeroed side
 * information, which decoders play as silence. Used to put real pauses into an
 * exported script. Returns no bytes when `clip` has no recognisable frame.
 */
export function mp3Silence(clip: Bytes, ms: number): Bytes {
  const audio = stripMp3Headers(clip);
  const length = mp3FrameLength(audio, 0);
  if (!length || ms <= 0) return new Uint8Array(0);

  const [, b1, b2, b3] = audio;
  const version = (b1 >> 3) & 0x03;
  const sampleRate = MP3_SAMPLE_RATES[version][(b2 >> 2) & 0x03];
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const frameLength = length - ((b2 >> 1) & 0x01);
  // No CRC (its checksum would not match zeroed data), and no padding byte.
  const header = [0xff, b1 | 0x01, b2 & ~0x02, b3];

  const frames = Math.ceil(((ms / 1000) * sampleRate) / samplesPerFrame);
  const out = new Uint8Array(frames * frameLength);
  for (let frame = 0; frame < frames; frame++) out.set(header, frame * frameLength);
  return out;
}
