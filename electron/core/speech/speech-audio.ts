// Audio for speech services: recognition takes a limited length per request, so longer speech goes in pieces cut at
// quiet moments, where a word is rarely split; synthesis comes back as WAV or MP3, and voice messages need Ogg Opus.

/** Sample rates every recognition service accepts for WAV. */
const WAV_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);

export interface Pcm {
  sampleRate: number;
  /** Mono 16-bit samples. */
  samples: Int16Array;
}

/** Mono samples of a 16-bit PCM WAV file at a common rate; undefined for anything else. */
export function readWav(bytes: Uint8Array): Pcm | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return;
  let format: { channels: number; rate: number } | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at),
      size = view.getUint32(at + 4, true),
      body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      const code = view.getUint16(body, true),
        bits = view.getUint16(body + 14, true);
      // 0xFFFE is WAVE_FORMAT_EXTENSIBLE, which names its real format in a GUID that starts with the plain code.
      const pcm = code === 1 || (code === 0xfffe && size >= 26 && view.getUint16(body + 24, true) === 1);
      if (!pcm || bits !== 16) return;
      format = { channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true) };
    } else if (id === 'data') {
      if (!format || !format.channels || !WAV_RATES.has(format.rate)) return;
      // Streamed files may leave the size open; then the data runs to the end.
      const end = Math.min(bytes.length, size ? body + size : bytes.length),
        frames = Math.floor((end - body) / 2 / format.channels),
        samples = new Int16Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel++)
          sum += view.getInt16(body + (frame * format.channels + channel) * 2, true);
        samples[frame] = Math.round(sum / format.channels);
      }
      return { sampleRate: format.rate, samples };
    }
    at = body + size + (size % 2);
  }
}

/** A mono 16-bit PCM WAV file. */
export function wavFile(samples: Int16Array, sampleRate: number) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(bytes, 44);
  return bytes;
}

/**
 * Sets the sizes in a streamed WAV file's header, which the server writes before it knows the length; some
 * players refuse a file whose sizes are open. Returns the audio's length in seconds.
 */
export function closeWav(bytes: Buffer) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    return;
  bytes.writeUInt32LE(bytes.length - 8, 4);
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4),
      size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16) byteRate = bytes.readUInt32LE(at + 16);
    if (id === 'data') {
      bytes.writeUInt32LE(bytes.length - at - 8, at + 4);
      return byteRate ? (bytes.length - at - 8) / byteRate : undefined;
    }
    at += 8 + size + (size % 2);
  }
}

/**
 * Sample ranges of at most `maxSeconds` covering all of the speech. Each cut falls on the quietest tenth of a second
 * in the last fifth of the piece, which is usually a pause between words.
 */
export function speechPieces(samples: Int16Array, sampleRate: number, maxSeconds: number): Array<[number, number]> {
  const longest = Math.floor(sampleRate * maxSeconds),
    step = Math.max(1, Math.round(sampleRate / 10)),
    search = Math.floor(longest / 5),
    pieces: Array<[number, number]> = [];
  let start = 0;
  while (samples.length - start > longest) {
    const limit = start + longest;
    let cut = limit,
      quietest = Infinity;
    for (let at = limit - step; at >= limit - search; at -= step) {
      let energy = 0;
      for (let index = at; index < at + step; index++) energy += samples[index] * samples[index];
      if (energy < quietest) {
        quietest = energy;
        cut = at + Math.floor(step / 2);
      }
    }
    pieces.push([start, cut]);
    start = cut;
  }
  if (samples.length > start) pieces.push([start, samples.length]);
  return pieces;
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function clock(seconds: number) {
  const whole = Math.floor(seconds),
    hours = Math.floor(whole / 3600),
    minutes = Math.floor(whole / 60) % 60,
    rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Characters as DeepSeek speech synthesis bills them: a Chinese character counts two, anything else one. */
export function billedCharacters(text: string) {
  let count = 0;
  for (const character of text) count += /\p{Script=Han}/u.test(character) ? 2 : 1;
  return count;
}

/** Opus packets from an encoder, each with its length in 48 kHz samples. */
export interface OpusPackets {
  packets: Array<{ data: Uint8Array; samples: number }>;
  /** Samples the decoder drops at the start, at 48 kHz. */
  preSkip: number;
  /** Samples of the original sound, at 48 kHz, so the end of the last packet's padding is cut. */
  length: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});
function oggPage(packets: Uint8Array[], granule: number, sequence: number, flags: number) {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(255, left));
      if (left < 255) break;
    }
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[5] = flags;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(0x4165_6c69, 14); // stream serial: "Aeli"
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  lacing.forEach((value, index) => (header[27 + index] = value));
  const page = Buffer.concat([header, ...packets]);
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  page.writeUInt32LE(crc, 22);
  return page;
}

/** An Ogg Opus file (RFC 7845) holding the packets, mono, as voice messages are. */
export function oggOpus({ packets, preSkip, length }: OpusPackets, inputRate = 48000) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(inputRate, 12);
  const vendor = Buffer.from('AelionBot'),
    tags = Buffer.alloc(16 + vendor.length);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  const pages = [oggPage([head], 0, 0, 0x02), oggPage([tags], 0, 1, 0)];
  const end = preSkip + length;
  let granule = 0,
    page: Uint8Array[] = [],
    segments = 0;
  packets.forEach((packet, index) => {
    const needed = Math.floor(packet.data.length / 255) + 1,
      last = index === packets.length - 1;
    if (segments + needed > 255) {
      pages.push(oggPage(page, Math.min(granule, end), pages.length, 0));
      page = [];
      segments = 0;
    }
    page.push(packet.data);
    segments += needed;
    granule += packet.samples;
    if (last) pages.push(oggPage(page, Math.min(granule, end), pages.length, 0x04));
  });
  return Buffer.concat(pages);
}
