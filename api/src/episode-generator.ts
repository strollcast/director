/**
 * Episode generation orchestration.
 * Coordinates TTS generation, caching, and audio concatenation.
 */

import {
  parseScript,
  computeCacheKey,
  type TTSProvider,
} from "./audio";
import { AwsClient } from "aws4fetch";

const TTS_CACHE_BASE = "tts_cache";

// Voice configuration
const ELEVENLABS_VOICES: Record<string, string> = {
  ERIC: "l7PKZGTaZgsdjGbTQRfS",
  MAYA: "21m00Tcm4TlvDq8ikWAM",
};

const INWORLD_VOICES: Record<string, string> = {
  ERIC: "Dennis",
  MAYA: "Sarah",
};

const ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";
const INWORLD_MODEL_ID = "inworld-tts-1";
const INWORLD_API_URL = "https://api.inworld.ai/tts/v1/voice";

// Types
interface Segment {
  speaker: string;
  text: string | null;      // Text for TTS (links replaced with link text)
  vttText: string | null;   // Text for VTT (original markdown links preserved)
}

interface TimingInfo {
  speaker: string;
  text: string;      // Text for TTS (used for cache keys)
  vttText: string;   // Text for VTT (with markdown links)
  start: number;
  end: number;
}

interface SegmentAudio {
  audio: Uint8Array;
  duration: number;
}

interface GeneratedSegments {
  timingInfo: TimingInfo[];
  cacheKeys: string[];
  totalDuration: number;
  cacheHits: number;
  apiCalls: number;
}

export interface GenerateEpisodeResult {
  audioUrl: string;
  vttContent: string;
  durationSeconds: number;
  segmentCount: number;
  cacheHits: number;
  apiCalls: number;
}

interface ConcatRequest {
  episode_id: string;
  segments: string[];
  output_url: string;
  metadata: {
    title: string;
    artist: string;
    album: string;
    genre: string;
  };
}

interface ConcatResponse {
  success: boolean;
  duration_seconds: number;
  file_size: number;
  error?: string;
}

interface ElevenLabsResponse {
  audio_base64: string;
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
}

interface InworldApiResponse {
  audioContent?: string;
  audio?: { url?: string };
  timestampInfo?: {
    wordAlignment?: {
      words: string[];
      wordStartTimeSeconds: number[];
      wordEndTimeSeconds: number[];
    };
  };
}

/**
 * R2 credentials for generating presigned URLs.
 * Must be set via wrangler secrets.
 */
export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
}

/**
 * Cached segment with audio data and duration.
 */
export interface CachedSegment {
  audio: Uint8Array;
  duration: number;
}

/**
 * Check R2 cache for a segment.
 * Returns audio data and duration from customMetadata.
 * Returns null if segment is missing or lacks duration metadata (legacy cache).
 */
export async function getCachedSegment(
  r2Cache: R2Bucket,
  cacheKey: string
): Promise<CachedSegment | null> {
  try {
    const object = await r2Cache.get(`${TTS_CACHE_BASE}/${cacheKey}.mp3`);
    if (object) {
      // Skip legacy cached segments without duration metadata
      if (!object.customMetadata?.duration) {
        return null;
      }
      const arrayBuffer = await object.arrayBuffer();
      const audio = new Uint8Array(arrayBuffer);
      const duration = parseFloat(object.customMetadata.duration);
      return { audio, duration };
    }
  } catch {
    // Cache miss or error
  }
  return null;
}

/**
 * Save segment to R2 cache with duration in customMetadata.
 */
export async function saveCachedSegment(
  r2Cache: R2Bucket,
  cacheKey: string,
  audio: Uint8Array,
  duration: number
): Promise<void> {
  try {
    await r2Cache.put(`${TTS_CACHE_BASE}/${cacheKey}.mp3`, audio, {
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { duration: duration.toString() },
    });
  } catch (error) {
    console.error("Failed to cache segment:", error);
  }
}

/**
 * Validate API key for the selected TTS provider.
 */
export function validateApiKey(
  provider: TTSProvider,
  apiKeys: { elevenlabs?: string; inworld?: string }
): string {
  const apiKey = provider === "elevenlabs" ? apiKeys.elevenlabs : apiKeys.inworld;
  if (!apiKey) {
    throw new Error(`API key not provided for ${provider}`);
  }
  return apiKey;
}

/**
 * Derive episode ID from episode name.
 * Episode name format is now: "lastname-year-title_slug"
 * No conversion needed - episodeName IS the episodeId.
 */
export function deriveEpisodeId(episodeName: string): string {
  return episodeName;
}

/**
 * Get voice ID for a speaker based on provider.
 */
function getVoiceId(speaker: string, provider: TTSProvider): string {
  return provider === "elevenlabs"
    ? ELEVENLABS_VOICES[speaker]
    : INWORLD_VOICES[speaker];
}

/**
 * Generate audio for a single segment using ElevenLabs API.
 */
async function generateSegmentAudioElevenLabs(
  text: string,
  speaker: string,
  apiKey: string,
  options?: {
    previousText?: string;
    nextText?: string;
    seed?: number;
  }
): Promise<SegmentAudio> {
  const voiceId = ELEVENLABS_VOICES[speaker];

  const requestBody: Record<string, unknown> = {
    text,
    model_id: ELEVENLABS_MODEL_ID,
    output_format: "mp3_44100_128",
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  if (options?.previousText) {
    requestBody.previous_text = options.previousText;
  }
  if (options?.nextText) {
    requestBody.next_text = options.nextText;
  }
  if (options?.seed !== undefined) {
    requestBody.seed = options.seed;
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ElevenLabsResponse;

  // Decode base64 audio
  const binaryString = atob(data.audio_base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Calculate duration from timestamps
  const endTimes = data.alignment?.character_end_times_seconds;
  const duration = endTimes?.length > 0 ? endTimes[endTimes.length - 1] : 0;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ElevenLabs API returned invalid duration: ${duration}`);
  }

  return { audio: bytes, duration };
}

/**
 * Extract duration from Inworld API response.
 */
function getInworldDuration(response: InworldApiResponse): number {
  const wordEndTimes = response.timestampInfo?.wordAlignment?.wordEndTimeSeconds;
  if (!wordEndTimes || wordEndTimes.length === 0) {
    throw new Error(`Response missing word timestamps`);
  }
  return wordEndTimes[wordEndTimes.length - 1];
}

/**
 * Generate audio for a single segment using Inworld TTS.
 */
async function generateSegmentAudioInworld(
  text: string,
  speaker: string,
  apiKey: string
): Promise<SegmentAudio> {
  const voice = INWORLD_VOICES[speaker];

  const response = await fetch(INWORLD_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${apiKey}`,
    },
    body: JSON.stringify({
      text,
      voiceId: voice,
      modelId: INWORLD_MODEL_ID,
      timestampType: "WORD",
      applyTextNormalization: "ON",
      audioConfig: {
        speakingRate: 0.9,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Inworld API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as InworldApiResponse;

  // Get duration from word-level timestamps
  let duration: number;
  try {
    duration = getInworldDuration(data);
  } catch {
    throw new Error(
      `Inworld API response missing word timestamps: ${JSON.stringify(data)}`
    );
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration from timestamps: ${duration}`);
  }

  // Get audio bytes
  let bytes: Uint8Array;

  if (data.audioContent) {
    const binaryString = atob(data.audioContent);
    bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
  } else if (data.audio?.url) {
    const audioResponse = await fetch(data.audio.url);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch Inworld audio: ${audioResponse.status}`);
    }
    const audioBuffer = await audioResponse.arrayBuffer();
    bytes = new Uint8Array(audioBuffer);
  } else {
    throw new Error(
      `Inworld API response missing audio: ${JSON.stringify(data)}`
    );
  }

  return { audio: bytes, duration };
}

/**
 * Generate audio for a single segment (with provider selection).
 */
async function generateSegmentAudio(
  text: string,
  speaker: string,
  provider: TTSProvider,
  apiKey: string,
  options?: {
    previousText?: string;
    nextText?: string;
    seed?: number;
  }
): Promise<SegmentAudio> {
  if (provider === "elevenlabs") {
    return generateSegmentAudioElevenLabs(text, speaker, apiKey, options);
  } else {
    return generateSegmentAudioInworld(text, speaker, apiKey);
  }
}

/**
 * Generate audio for all script segments with caching.
 */
export async function generateAudioSegments(
  segments: Segment[],
  provider: TTSProvider,
  apiKey: string,
  r2Cache: R2Bucket
): Promise<GeneratedSegments> {
  const timingInfo: TimingInfo[] = [];
  const cacheKeys: string[] = [];
  let currentTime = 0;
  let cacheHits = 0;
  let apiCalls = 0;

  // Filter speech segments for continuity context
  const speechSegments = segments.filter(
    (s): s is Segment & { text: string } => s.speaker !== "PAUSE" && s.text !== null
  );

  // Consistent seeds per speaker (ElevenLabs only)
  const speakerSeeds: Record<string, number> = {
    ERIC: 12345,
    MAYA: 67890,
  };

  let speechIndex = 0;

  for (const segment of segments) {
    if (segment.speaker === "PAUSE") {
      // 800ms pause (no audio file needed)
      currentTime += 0.8;
      continue;
    }

    if (!segment.text) continue;

    const voiceId = getVoiceId(segment.speaker, provider);
    const cacheKey = computeCacheKey(segment.text, voiceId, provider);

    // Find adjacent segments for continuity
    const prevSegment = speechIndex > 0 ? speechSegments[speechIndex - 1] : null;
    const nextSegment =
      speechIndex < speechSegments.length - 1
        ? speechSegments[speechIndex + 1]
        : null;

    // Check cache
    const cached = await getCachedSegment(r2Cache, cacheKey);
    let audio: Uint8Array;
    let duration: number;

    if (cached) {
      cacheHits++;
      audio = cached.audio;
      duration = cached.duration;
    } else {
      // Generate via API
      const result = await generateSegmentAudio(
        segment.text,
        segment.speaker,
        provider,
        apiKey,
        {
          previousText: prevSegment?.text,
          nextText: nextSegment?.text,
          seed: speakerSeeds[segment.speaker],
        }
      );

      audio = result.audio;
      duration = result.duration;
      apiCalls++;

      // Cache the segment
      await saveCachedSegment(r2Cache, cacheKey, audio, duration);
    }

    cacheKeys.push(cacheKey);

    // Track timing for VTT
    timingInfo.push({
      speaker: segment.speaker,
      text: segment.text,
      vttText: segment.vttText || segment.text,
      start: currentTime,
      end: currentTime + duration,
    });

    currentTime += duration;
    speechIndex++;
  }

  return {
    timingInfo,
    cacheKeys,
    totalDuration: currentTime,
    cacheHits,
    apiCalls,
  };
}

/**
 * Generate a presigned URL for R2 object access.
 */
async function generatePresignedUrl(
  credentials: R2Credentials,
  bucket: string,
  key: string,
  method: "GET" | "PUT",
  expiresIn: number = 3600
): Promise<string> {
  const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });

  const url = `https://${credentials.accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const signedRequest = await client.sign(
    new Request(`${url}?X-Amz-Expires=${expiresIn}`, { method }),
    { aws: { signQuery: true } }
  );

  return signedRequest.url;
}

/**
 * Concatenate audio segments using FFmpeg container.
 */
export async function concatenateWithFFmpeg(
  cacheKeys: string[],
  episodeId: string,
  episodeName: string,
  r2Credentials: R2Credentials,
  ffmpegContainer: DurableObjectNamespace
): Promise<{ audioUrl: string; durationSeconds: number }> {
  // Generate presigned URLs for cached segments
  console.log(`Generating presigned URLs for ${cacheKeys.length} segments...`);
  const segmentUrls = await Promise.all(
    cacheKeys.map((key) =>
      generatePresignedUrl(
        r2Credentials,
        "strollcast-cache",
        `tts_cache/${key}.mp3`,
        "GET"
      )
    )
  );

  // Generate presigned URL for output
  const outputKey = `episodes/${episodeId}/${episodeId}.mp3`;
  const outputUrl = await generatePresignedUrl(
    r2Credentials,
    "strollcast-output",
    outputKey,
    "PUT"
  );

  // Call FFmpeg container
  console.log(`Calling FFmpeg container for concatenation of '${episodeName}'...`);
  const containerId = ffmpegContainer.idFromName("audio-processor");
  const container = ffmpegContainer.get(containerId);

  const concatRequest: ConcatRequest = {
    episode_id: episodeId,
    segments: segmentUrls,
    output_url: outputUrl,
    metadata: {
      title: episodeName,
      artist: "Strollcast",
      album: "Strollcast",
      genre: "Podcast",
    },
  };

  const containerResponse = await container.fetch("http://container/concat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(concatRequest),
  });

  if (!containerResponse.ok) {
    const errorText = await containerResponse.text();
    throw new Error(
      `FFmpeg container error: ${containerResponse.status} ${errorText}`
    );
  }

  const concatResult = (await containerResponse.json()) as ConcatResponse;
  if (!concatResult.success) {
    throw new Error(
      `FFmpeg concatenation of '${episodeName}' failed: ${concatResult.error}`
    );
  }

  console.log(
    `FFmpeg: Concatenated '${episodeName}', ${cacheKeys.length} segments, duration: ${concatResult.duration_seconds}s`
  );

  const audioUrl = `https://released.strollcast.com/${outputKey}`;
  return {
    audioUrl,
    durationSeconds: concatResult.duration_seconds,
  };
}

/**
 * Format seconds as VTT timestamp (HH:MM:SS.mmm).
 */
function formatVttTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid VTT timestamp: ${seconds}`);
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
}

/**
 * Generate WebVTT transcript content.
 */
export function generateWebVtt(timingInfo: TimingInfo[]): string {
  const lines = ["WEBVTT", ""];

  let cueNumber = 1;
  for (const segment of timingInfo) {
    if (segment.speaker === "PAUSE") continue;

    const start = formatVttTimestamp(segment.start);
    const end = formatVttTimestamp(segment.end);
    const speaker =
      segment.speaker.charAt(0) + segment.speaker.slice(1).toLowerCase();

    lines.push(String(cueNumber));
    lines.push(`${start} --> ${end}`);
    lines.push(`<v ${speaker}>${segment.vttText}`);
    lines.push("");

    cueNumber++;
  }

  return lines.join("\n");
}

/**
 * Generate only VTT transcript using cached audio segments.
 * This is useful when audio already exists but VTT is missing.
 */
export async function generateVttOnly(
  scriptContent: string,
  episodeName: string,
  apiKeys: { elevenlabs?: string; inworld?: string },
  r2Cache: R2Bucket,
  provider: TTSProvider = "elevenlabs"
): Promise<string> {
  // Validate inputs
  const apiKey = validateApiKey(provider, apiKeys);
  const episodeId = deriveEpisodeId(episodeName);

  // Parse script
  const segments = parseScript(scriptContent);
  if (segments.length === 0) {
    throw new Error("No valid segments found in script");
  }

  // Generate audio segments (will use cached segments, no API calls)
  const { timingInfo } = await generateAudioSegments(
    segments,
    provider,
    apiKey,
    r2Cache
  );
  console.log(`generateVttOnly: retrieved timing info from cache for '${episodeId}'.`);

  // Generate VTT transcript
  const vttContent = generateWebVtt(timingInfo);
  console.log(`generateVttOnly: generated VTT file for '${episodeName}'.`);

  return vttContent;
}

/**
 * Generate a complete podcast episode.
 */
export async function generateEpisode(
  scriptContent: string,
  episodeName: string,
  apiKeys: { elevenlabs?: string; inworld?: string },
  r2Bucket: R2Bucket,
  r2Cache: R2Bucket,
  ffmpegContainer: DurableObjectNamespace,
  r2Credentials: R2Credentials,
  provider: TTSProvider = "elevenlabs"
): Promise<GenerateEpisodeResult> {
  // Validate inputs
  const apiKey = validateApiKey(provider, apiKeys);
  const episodeId = deriveEpisodeId(episodeName);

  // Parse script
  const segments = parseScript(scriptContent);
  if (segments.length === 0) {
    throw new Error("No valid segments found in script");
  }

  // Generate audio segments with caching
  const { timingInfo, cacheKeys, cacheHits, apiCalls } =
    await generateAudioSegments(segments, provider, apiKey, r2Cache);
  console.log(`generateEpisode: generated audio segments for '${episodeId}'.`);

  // Concatenate audio using FFmpeg container
  const { audioUrl, durationSeconds } = await concatenateWithFFmpeg(
    cacheKeys,
    episodeId,
    episodeName,
    r2Credentials,
    ffmpegContainer
  );
  console.log(`generateEpisode: concatenated prompt files for '${episodeId}'.`);

  // Generate VTT transcript
  const vttContent = generateWebVtt(timingInfo);
  console.log(`generateEpisode: generated VTT file for '${episodeName}'.`);

  const segmentCount = segments.filter((s) => s.speaker !== "PAUSE").length;

  return {
    audioUrl,
    vttContent,
    durationSeconds,
    segmentCount,
    cacheHits,
    apiCalls,
  };
}
