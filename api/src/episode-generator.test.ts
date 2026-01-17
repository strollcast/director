import { describe, it, expect, vi } from 'vitest';
import {
  validateApiKey,
  deriveEpisodeId,
  generateWebVtt,
  generateAudioSegments,
  concatenateWithFFmpeg,
  generateEpisode,
  getCachedSegment,
  saveCachedSegment,
} from './episode-generator';

describe('validateApiKey', () => {
  it('returns elevenlabs API key when provider is elevenlabs', () => {
    const apiKey = validateApiKey('elevenlabs', {
      elevenlabs: 'test-elevenlabs-key',
      inworld: 'test-inworld-key',
    });

    expect(apiKey).toBe('test-elevenlabs-key');
  });

  it('returns inworld API key when provider is inworld', () => {
    const apiKey = validateApiKey('inworld', {
      elevenlabs: 'test-elevenlabs-key',
      inworld: 'test-inworld-key',
    });

    expect(apiKey).toBe('test-inworld-key');
  });

  it('throws error when elevenlabs key is missing', () => {
    expect(() => {
      validateApiKey('elevenlabs', { inworld: 'test-key' });
    }).toThrow('API key not provided for elevenlabs');
  });

  it('throws error when inworld key is missing', () => {
    expect(() => {
      validateApiKey('inworld', { elevenlabs: 'test-key' });
    }).toThrow('API key not provided for inworld');
  });
});

describe('deriveEpisodeId', () => {
  it('returns episode name as-is (no conversion needed)', () => {
    const episodeId = deriveEpisodeId('chen-2023-punica_multi_tenant');
    expect(episodeId).toBe('chen-2023-punica_multi_tenant');
  });

  it('handles various episode name formats', () => {
    expect(deriveEpisodeId('dao-2023-flashattention_2_fa')).toBe('dao-2023-flashattention_2_fa');
    expect(deriveEpisodeId('narayanan-2021-efficient_large_sca')).toBe('narayanan-2021-efficient_large_sca');
  });

  it('returns single word as-is', () => {
    const episodeId = deriveEpisodeId('standalone');
    expect(episodeId).toBe('standalone');
  });
});

describe('generateWebVtt', () => {
  it('generates valid WebVTT format', () => {
    const timingInfo = [
      { speaker: 'ERIC', text: 'Hello world', vttText: 'Hello world', start: 0, end: 1.5 },
      { speaker: 'MAYA', text: 'Welcome to the show', vttText: 'Welcome to the show', start: 1.5, end: 3.2 },
    ];

    const vtt = generateWebVtt(timingInfo);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500');
    expect(vtt).toContain('<v Eric>Hello world');
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.200');
    expect(vtt).toContain('<v Maya>Welcome to the show');
  });

  it('numbers cues sequentially', () => {
    const timingInfo = [
      { speaker: 'ERIC', text: 'First', vttText: 'First', start: 0, end: 1 },
      { speaker: 'MAYA', text: 'Second', vttText: 'Second', start: 1, end: 2 },
      { speaker: 'ERIC', text: 'Third', vttText: 'Third', start: 2, end: 3 },
    ];

    const vtt = generateWebVtt(timingInfo);
    const lines = vtt.split('\n');

    expect(lines).toContain('1');
    expect(lines).toContain('2');
    expect(lines).toContain('3');
  });

  it('skips PAUSE segments', () => {
    const timingInfo = [
      { speaker: 'ERIC', text: 'Before pause', vttText: 'Before pause', start: 0, end: 1 },
      { speaker: 'PAUSE', text: '', vttText: '', start: 1, end: 1.8 },
      { speaker: 'MAYA', text: 'After pause', vttText: 'After pause', start: 1.8, end: 3 },
    ];

    const vtt = generateWebVtt(timingInfo);

    expect(vtt).toContain('<v Eric>Before pause');
    expect(vtt).not.toContain('PAUSE');
    expect(vtt).toContain('<v Maya>After pause');
  });

  it('handles hour-long timestamps', () => {
    const timingInfo = [
      { speaker: 'ERIC', text: 'Long episode', vttText: 'Long episode', start: 3665.5, end: 3670.2 },
    ];

    const vtt = generateWebVtt(timingInfo);

    // 3665.5 seconds = 1 hour, 1 minute, 5.5 seconds
    expect(vtt).toContain('01:01:05.500 --> 01:01:10.200');
  });

  it('returns empty VTT for no segments', () => {
    const vtt = generateWebVtt([]);

    expect(vtt).toBe('WEBVTT\n');
  });

  it('preserves markdown links in VTT text', () => {
    const timingInfo = [
      {
        speaker: 'ERIC',
        text: 'Check out FlashAttention for details',  // TTS text without link
        vttText: 'Check out [FlashAttention](https://arxiv.org) for details',  // VTT with link
        start: 0,
        end: 2
      },
    ];

    const vtt = generateWebVtt(timingInfo);

    expect(vtt).toContain('<v Eric>Check out [FlashAttention](https://arxiv.org) for details');
  });
});

describe('generateAudioSegments', () => {
  it('caches and returns segment info', async () => {
    // Mock R2 cache with cached segment
    const mockAudio = new Uint8Array([1, 2, 3, 4]);
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: vi.fn().mockResolvedValue(mockAudio.buffer),
        customMetadata: { duration: '2.5' },
      }),
    } as unknown as R2Bucket;

    const segments = [
      { speaker: 'ERIC', text: 'Hello world', vttText: 'Hello world' },
      { speaker: 'MAYA', text: 'Welcome', vttText: 'Welcome' },
    ];

    const result = await generateAudioSegments(
      segments,
      'elevenlabs',
      'test-api-key',
      mockR2Cache
    );

    expect(result.cacheHits).toBe(2);
    expect(result.apiCalls).toBe(0);
    expect(result.timingInfo).toHaveLength(2);
    expect(result.cacheKeys).toHaveLength(2);
    expect(result.timingInfo[0].text).toBe('Hello world');
    expect(result.timingInfo[1].text).toBe('Welcome');
  });

  it('handles PAUSE segments correctly', async () => {
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
        customMetadata: { duration: '1.0' },
      }),
    } as unknown as R2Bucket;

    const segments = [
      { speaker: 'ERIC', text: 'Before', vttText: 'Before' },
      { speaker: 'PAUSE', text: null, vttText: null },
      { speaker: 'MAYA', text: 'After', vttText: 'After' },
    ];

    const result = await generateAudioSegments(
      segments,
      'elevenlabs',
      'test-api-key',
      mockR2Cache
    );

    // Should have 2 cache hits (ERIC, MAYA), 0 for PAUSE
    expect(result.cacheHits).toBe(2);
    expect(result.timingInfo).toHaveLength(2);
    // PAUSE adds 0.8 seconds between segments
    expect(result.totalDuration).toBe(2.8); // 1.0 + 0.8 + 1.0
  });

  it('skips segments with null text', async () => {
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;

    const segments = [
      { speaker: 'ERIC', text: null, vttText: null },
      { speaker: 'MAYA', text: null, vttText: null },
    ];

    const result = await generateAudioSegments(
      segments,
      'elevenlabs',
      'test-api-key',
      mockR2Cache
    );

    expect(result.cacheHits).toBe(0);
    expect(result.apiCalls).toBe(0);
    expect(result.timingInfo).toHaveLength(0);
  });
});

describe('concatenateWithFFmpeg', () => {
  it('calls FFmpeg container and returns result', async () => {
    // Mock FFmpeg container
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            duration_seconds: 125.5,
            file_size: 1024000,
          }),
          { status: 200 }
        )
      ),
    };

    const mockNamespace = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue(mockContainer),
    } as unknown as DurableObjectNamespace;

    const mockCredentials = {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      accountId: 'test-account-id',
    };

    const result = await concatenateWithFFmpeg(
      ['key1', 'key2', 'key3'],
      'smith-2024-attention',
      'smith-2024-attention',
      mockCredentials,
      mockNamespace
    );

    expect(result.audioUrl).toBe(
      'https://released.strollcast.com/episodes/smith-2024-attention/smith-2024-attention.mp3'
    );
    expect(result.durationSeconds).toBe(125.5);
    expect(mockContainer.fetch).toHaveBeenCalledWith(
      'http://container/concat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('throws error when container returns error', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response('Container error', { status: 500 })
      ),
    };

    const mockNamespace = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue(mockContainer),
    } as unknown as DurableObjectNamespace;

    const mockCredentials = {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      accountId: 'test-account-id',
    };

    await expect(
      concatenateWithFFmpeg(
        ['key1'],
        'test-2024',
        'test-episode',
        mockCredentials,
        mockNamespace
      )
    ).rejects.toThrow('FFmpeg container error');
  });

  it('throws error when concatenation fails', async () => {
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Invalid input format',
          }),
          { status: 200 }
        )
      ),
    };

    const mockNamespace = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue(mockContainer),
    } as unknown as DurableObjectNamespace;

    const mockCredentials = {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      accountId: 'test-account-id',
    };

    await expect(
      concatenateWithFFmpeg(
        ['key1'],
        'test-2024',
        'test-episode',
        mockCredentials,
        mockNamespace
      )
    ).rejects.toThrow('FFmpeg concatenation');
  });
});

describe('generateEpisode (integration)', () => {
  it('orchestrates full episode generation', async () => {
    // Mock R2 cache
    const mockAudio = new Uint8Array([1, 2, 3, 4]);
    const mockR2Cache = {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: vi.fn().mockResolvedValue(mockAudio.buffer),
        customMetadata: { duration: '2.5' },
      }),
    } as unknown as R2Bucket;

    const mockR2Bucket = {} as R2Bucket;

    // Mock FFmpeg container
    const mockContainer = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            duration_seconds: 5.0,
            file_size: 100000,
          }),
          { status: 200 }
        )
      ),
    };

    const mockNamespace = {
      idFromName: vi.fn().mockReturnValue('mock-id'),
      get: vi.fn().mockReturnValue(mockContainer),
    } as unknown as DurableObjectNamespace;

    const mockCredentials = {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      accountId: 'test-account-id',
    };

    const script = `
**ERIC:** Welcome to the show!
**MAYA:** Thanks for having me.
`;

    const result = await generateEpisode(
      script,
      'smith-2024-attention',
      { elevenlabs: 'test-api-key' },
      mockR2Bucket,
      mockR2Cache,
      mockNamespace,
      mockCredentials,
      'elevenlabs'
    );

    expect(result.audioUrl).toContain('smith-2024-attention.mp3');
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.durationSeconds).toBe(5.0);
    expect(result.segmentCount).toBe(2);
    expect(result.cacheHits).toBe(2);
  });

  it('throws error for empty script', async () => {
    const mockR2Cache = {} as R2Bucket;
    const mockR2Bucket = {} as R2Bucket;
    const mockNamespace = {} as DurableObjectNamespace;
    const mockCredentials = {
      accessKeyId: 'test',
      secretAccessKey: 'test',
      accountId: 'test',
    };

    await expect(
      generateEpisode(
        '',
        'test-2024-episode',
        { elevenlabs: 'test-key' },
        mockR2Bucket,
        mockR2Cache,
        mockNamespace,
        mockCredentials,
        'elevenlabs'
      )
    ).rejects.toThrow('No valid segments found in script');
  });

  it('throws error when API key is missing', async () => {
    const mockR2Cache = {} as R2Bucket;
    const mockR2Bucket = {} as R2Bucket;
    const mockNamespace = {} as DurableObjectNamespace;
    const mockCredentials = {
      accessKeyId: 'test',
      secretAccessKey: 'test',
      accountId: 'test',
    };

    await expect(
      generateEpisode(
        '**ERIC:** Hello',
        'test-2024-episode',
        {}, // No API keys provided
        mockR2Bucket,
        mockR2Cache,
        mockNamespace,
        mockCredentials,
        'elevenlabs'
      )
    ).rejects.toThrow('API key not provided for elevenlabs');
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

    expect(mockR2Cache.get).toHaveBeenCalledWith('tts_cache/test-key.mp3');
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
      'tts_cache/test-key.mp3',
      audioData,
      {
        httpMetadata: { contentType: 'audio/mpeg' },
        customMetadata: { duration: '5.5' },
      }
    );
  });

  it('handles R2 put error gracefully', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
    const mockR2Cache = {
      put: vi.fn().mockRejectedValue(new Error('R2 error')),
    } as unknown as R2Bucket;

    // Should not throw
    await saveCachedSegment(mockR2Cache, 'error-key', audioData, 3.0);

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
