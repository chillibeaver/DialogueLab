import { describe, expect, it } from "vitest";

import { concatAudio, stripMp3Headers } from "../server/lib/audio";

function wav(samples: number[], sampleRate = 24000): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(samples);
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => [...text].forEach((ch, i) => (out[offset + i] = ch.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

// MPEG-2 Layer III, 32 kbps, 24 kHz, no padding => 72 * 32000 / 24000 = 96-byte frames.
const FRAME_HEADER = [0xff, 0xf3, 0x44, 0xc4];
const FRAME_LENGTH = 96;

function mp3Frame(fill: number, tag?: string): number[] {
  const frame = new Array<number>(FRAME_LENGTH).fill(fill);
  frame.splice(0, 4, ...FRAME_HEADER);
  if (tag) [...tag].forEach((ch, i) => (frame[13 + i] = ch.charCodeAt(0)));
  return frame;
}

const id3 = (payloadSize: number) => [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, payloadSize, ...new Array(payloadSize).fill(0)];

describe("concatAudio", () => {
  it("returns a single part unchanged", () => {
    const part = new Uint8Array([1, 2, 3]);
    expect(concatAudio("mp3", [part])).toBe(part);
  });

  it("joins WAV payloads under one correct header", () => {
    const joined = concatAudio("wav", [wav([1, 2, 3, 4]), wav([5, 6])]);
    const view = new DataView(joined.buffer, joined.byteOffset);

    expect(joined.length).toBe(44 + 6);
    expect(view.getUint32(4, true)).toBe(36 + 6); // RIFF size
    expect(view.getUint32(40, true)).toBe(6); // data size
    expect([...joined.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(view.getUint32(24, true)).toBe(24000);
  });

  it("refuses to join WAVs with different formats", () => {
    expect(() => concatAudio("wav", [wav([1, 2], 24000), wav([3, 4], 16000)])).toThrow(/different audio formats/);
  });

  it("joins MP3 parts, dropping ID3 tags and Xing/Info frames", () => {
    const first = new Uint8Array([...id3(5), ...mp3Frame(0, "Info"), ...mp3Frame(1)]);
    const second = new Uint8Array([...mp3Frame(0, "Xing"), ...mp3Frame(2)]);
    const joined = concatAudio("mp3", [first, second]);

    expect(joined.length).toBe(2 * FRAME_LENGTH);
    expect(joined[4]).toBe(1);
    expect(joined[FRAME_LENGTH + 4]).toBe(2);
  });

  it("refuses to join OGG_OPUS", () => {
    expect(() => concatAudio("ogg_opus", [new Uint8Array(1), new Uint8Array(1)])).toThrow();
  });
});

describe("stripMp3Headers", () => {
  it("leaves plain audio frames alone", () => {
    const audio = new Uint8Array([...mp3Frame(7), ...mp3Frame(8)]);
    expect(stripMp3Headers(audio)).toEqual(audio);
  });
});

describe("mp3Silence", () => {
  // Google's Chirp 3: HD output: MPEG-2 Layer III, 24 kHz, 32 kbps, mono: 96-byte frames of 24 ms.
  const frame = new Uint8Array(96);
  frame.set([0xff, 0xf3, 0x44, 0xc4]);

  it("makes whole frames in the clip's format, covering the requested time", async () => {
    const { mp3Silence } = await import("../server/lib/audio");
    const silence = mp3Silence(frame, 1000);
    expect(silence.length).toBe(Math.ceil(1000 / 24) * 96);
    expect([...silence.subarray(0, 4)]).toEqual([0xff, 0xf3, 0x44, 0xc4]);
    expect([...silence.subarray(96, 100)]).toEqual([0xff, 0xf3, 0x44, 0xc4]);
    expect(silence.subarray(4, 96).every((b) => b === 0)).toBe(true);
  });

  it("gives nothing for no time, or for something that is not MP3", async () => {
    const { mp3Silence } = await import("../server/lib/audio");
    expect(mp3Silence(frame, 0).length).toBe(0);
    expect(mp3Silence(new TextEncoder().encode("audio-1"), 500).length).toBe(0);
  });
});
