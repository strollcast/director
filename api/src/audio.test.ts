import { describe, it, expect, vi } from 'vitest';
import { parseScript, getCachedSegment, saveCachedSegment, getMp3Duration } from './audio';

describe('parseScript', () => {
  it('parses speaker segments correctly', () => {
    const script = `
## Introduction

**ERIC:** Welcome to the show!

**MAYA:** Thanks for having me.

## [Section Break]

**ERIC:** Let's dive in.
`;
    const segments = parseScript(script);

    expect(segments).toHaveLength(4); // 3 speech + 1 pause
    expect(segments[0]).toEqual({ speaker: 'ERIC', text: 'Welcome to the show!' });
    expect(segments[1]).toEqual({ speaker: 'MAYA', text: 'Thanks for having me.' });
    expect(segments[2]).toEqual({ speaker: 'PAUSE', text: null });
    expect(segments[3]).toEqual({ speaker: 'ERIC', text: "Let's dive in." });
  });

  it('removes markdown annotations', () => {
    const script = `**ERIC:** This is **bold** and {{page: 1}} citation.`;
    const segments = parseScript(script);

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('This is bold and citation.');
  });

  it('handles empty script', () => {
    const segments = parseScript('');
    expect(segments).toHaveLength(0);
  });

  it('ignores non-speaker lines', () => {
    const script = `
Some random text
# Header
**ERIC:** Valid segment.
More random text
`;
    const segments = parseScript(script);

    expect(segments).toHaveLength(1);
    expect(segments[0].speaker).toBe('ERIC');
  });
});

describe('getCachedSegment', () => {
  it('returns audio and duration from cache with metadata', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const mockR2Object = {
      arrayBuffer: vi.fn().mockResolvedValue(audioData.buffer),
      customMetadata: { duration: '5.5' },
    };
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue(mockR2Object),
    } as unknown as R2Bucket;

    const result = await getCachedSegment(mockR2Cache, 'test-key');

    expect(mockR2Cache.get).toHaveBeenCalledWith('segments/test-key.mp3');
    expect(result).not.toBeNull();
    expect(result!.duration).toBe(5.5);
    expect(result!.audio).toEqual(audioData);
  });

  it('returns null for cache miss', async () => {
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;

    const result = await getCachedSegment(mockR2Cache, 'missing-key');

    expect(result).toBeNull();
  });

  it('returns null for legacy cache without duration metadata', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const mockR2Object = {
      arrayBuffer: vi.fn().mockResolvedValue(audioData.buffer),
      customMetadata: {}, // No duration
    };
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue(mockR2Object),
    } as unknown as R2Bucket;

    const result = await getCachedSegment(mockR2Cache, 'legacy-key');

    expect(result).toBeNull();
  });

  it('returns null on R2 error', async () => {
    const mockR2Cache = {
      get: vi.fn().mockRejectedValue(new Error('R2 error')),
    } as unknown as R2Bucket;

    const result = await getCachedSegment(mockR2Cache, 'error-key');

    expect(result).toBeNull();
  });
});

describe('saveCachedSegment', () => {
  it('saves audio with duration in customMetadata', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const mockR2Cache = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await saveCachedSegment(mockR2Cache, 'test-key', audioData, 5.5);

    expect(mockR2Cache.put).toHaveBeenCalledWith(
      'segments/test-key.mp3',
      audioData,
      {
        httpMetadata: { contentType: 'audio/mpeg' },
        customMetadata: { duration: '5.5' },
      }
    );
  });

  it('handles R2 put error gracefully', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockR2Cache = {
      put: vi.fn().mockRejectedValue(new Error('R2 error')),
    } as unknown as R2Bucket;

    // Should not throw
    await saveCachedSegment(mockR2Cache, 'error-key', audioData, 3.0);

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('getMp3Duration', () => {
  // Helper to create a minimal MP3 frame header
  // Frame sync: 0xFF 0xFB (MPEG1 Layer3)
  // 0x90 = bitrate index 9 (128kbps for V1L3) + sample rate 0 (44100Hz)
  function createMp3Frame(bitrateByte: number, dataSize: number): Uint8Array {
    const data = new Uint8Array(dataSize);
    data[0] = 0xFF;  // Sync
    data[1] = 0xFB;  // MPEG1, Layer III, no CRC
    data[2] = bitrateByte;  // Bitrate + sample rate
    data[3] = 0x00;
    return data;
  }

  it('parses 128kbps MP3 duration correctly', () => {
    // 128kbps = bitrate index 9 = 0x90 (with 44100Hz sample rate)
    // 16000 bytes at 128kbps = 1 second
    const mp3Data = createMp3Frame(0x90, 16000);
    const duration = getMp3Duration(mp3Data);

    // duration = (16000 * 8) / 128000 = 1.0 seconds
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it('parses 192kbps MP3 duration correctly', () => {
    // 192kbps = bitrate index 11 = 0xB0 (with 44100Hz sample rate)
    // 24000 bytes at 192kbps = 1 second
    const mp3Data = createMp3Frame(0xB0, 24000);
    const duration = getMp3Duration(mp3Data);

    // duration = (24000 * 8) / 192000 = 1.0 seconds
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it('skips ID3v2 tag and parses correctly', () => {
    // Create ID3v2 header + MP3 frame
    // ID3v2 header: "ID3" + version + flags + size (syncsafe int)
    const id3Size = 100;  // Size of ID3 tag content
    const mp3Size = 16000;
    const data = new Uint8Array(10 + id3Size + mp3Size);

    // ID3v2 header
    data[0] = 0x49;  // 'I'
    data[1] = 0x44;  // 'D'
    data[2] = 0x33;  // '3'
    data[3] = 0x04;  // Version major
    data[4] = 0x00;  // Version minor
    data[5] = 0x00;  // Flags
    // Size as syncsafe integer (100 = 0x64)
    data[6] = 0x00;
    data[7] = 0x00;
    data[8] = 0x00;
    data[9] = 0x64;  // 100

    // MP3 frame starts at offset 10 + 100 = 110
    const frameOffset = 10 + id3Size;
    data[frameOffset] = 0xFF;
    data[frameOffset + 1] = 0xFB;
    data[frameOffset + 2] = 0x90;  // 128kbps
    data[frameOffset + 3] = 0x00;

    const duration = getMp3Duration(data);

    // duration = (16000 * 8) / 128000 = 1.0 seconds (ignoring ID3 tag)
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it('falls back to estimate for invalid data', () => {
    // Random data with no valid MP3 frame
    const data = new Uint8Array(16000);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 256;
    }

    const duration = getMp3Duration(data);

    // Fallback: 16000 / 16000 = 1.0 seconds (assuming 128kbps)
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it('handles empty data', () => {
    const data = new Uint8Array(0);
    const duration = getMp3Duration(data);
    expect(duration).toBe(0);
  });
});
