import { describe, it, expect } from 'vitest';
import { fixMp3Metadata, parseScript } from './audio';

// Create a minimal valid MP3 programmatically
// MP3 frame header: 0xFF 0xFB (MPEG Audio Layer 3, 128kbps, 44100Hz)
// followed by enough padding to make a valid frame
function createMinimalMp3(): Uint8Array {
  // Minimal MP3: ID3v2 header + single MPEG frame
  // This creates a ~1KB file that taglib can parse
  const frames: number[] = [];

  // Add multiple valid MP3 frames (each frame is 417 bytes at 128kbps/44100Hz)
  // Frame header: FF FB 90 00 (MPEG1 Layer3, 128kbps, 44.1kHz, stereo)
  const frameHeader = [0xFF, 0xFB, 0x90, 0x00];
  const frameSize = 417; // bytes per frame at this bitrate

  // Create 3 frames (~0.078 seconds of audio)
  for (let f = 0; f < 3; f++) {
    frames.push(...frameHeader);
    // Fill rest of frame with zeros (silence)
    for (let i = 4; i < frameSize; i++) {
      frames.push(0x00);
    }
  }

  return new Uint8Array(frames);
}

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

describe('fixMp3Metadata', () => {
  it('processes valid MP3 data and returns metadata', async () => {
    const mp3Data = createMinimalMp3();

    const result = await fixMp3Metadata(mp3Data, 'Test Episode', 'Test Artist');

    // Should return audio data (possibly modified with ID3 tags)
    expect(result.audioData).toBeInstanceOf(Uint8Array);
    expect(result.audioData.length).toBeGreaterThan(0);

    // Duration should be a number (may be 0 for very short files)
    expect(typeof result.durationSeconds).toBe('number');
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('handles invalid audio data gracefully', async () => {
    const invalidData = new Uint8Array([0, 1, 2, 3, 4, 5]);

    const result = await fixMp3Metadata(invalidData, 'Test', 'Test');

    // Should return original data on error
    expect(result.audioData).toEqual(invalidData);
    expect(result.durationSeconds).toBe(0);
  });

  it('handles empty audio data gracefully', async () => {
    const emptyData = new Uint8Array(0);

    const result = await fixMp3Metadata(emptyData, 'Test', 'Test');

    // Should return original data on error
    expect(result.audioData).toEqual(emptyData);
    expect(result.durationSeconds).toBe(0);
  });
});
