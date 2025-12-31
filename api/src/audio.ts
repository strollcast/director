/**
 * Audio generation for Strollcast.
 *
 * Generates podcast audio from scripts using ElevenLabs or Inworld TTS.
 * Uses Cloudflare Container with FFmpeg for proper MP3 concatenation.
 */

import { AwsClient } from "aws4fetch";

// MP3 bitrate lookup tables (kbps)
const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0];
const SAMPLE_RATES_V2 = [22050, 24000, 16000, 0];
const SAMPLE_RATES_V25 = [11025, 12000, 8000, 0];

/**
 * Parse MP3 frame header to get bitrate and sample rate.
 * Returns null if not a valid MP3 frame.
 */
function parseMp3FrameHeader(data: Uint8Array, offset: number): { bitrate: number; sampleRate: number } | null {
  if (offset + 4 > data.length) return null;

  // Check frame sync (11 bits set)
  if (data[offset] !== 0xFF || (data[offset + 1] & 0xE0) !== 0xE0) return null;

  const b1 = data[offset + 1];
  const b2 = data[offset + 2];

  // Version: 00 = 2.5, 01 = reserved, 10 = 2, 11 = 1
  const version = (b1 >> 3) & 0x03;
  if (version === 1) return null; // Reserved

  // Layer: 00 = reserved, 01 = III, 10 = II, 11 = I
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 1) return null; // We only handle Layer III (MP3)

  const bitrateIndex = (b2 >> 4) & 0x0F;
  const sampleRateIndex = (b2 >> 2) & 0x03;

  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  if (sampleRateIndex === 3) return null;

  const isV1 = version === 3;
  const bitrate = (isV1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex] * 1000;
  const sampleRates = version === 3 ? SAMPLE_RATES_V1 : version === 2 ? SAMPLE_RATES_V2 : SAMPLE_RATES_V25;
  const sampleRate = sampleRates[sampleRateIndex];

  return { bitrate, sampleRate };
}

/**
 * Get duration of MP3 audio data by parsing headers.
 * Scans for first valid frame to get bitrate, then calculates duration from file size.
 */
export function getMp3Duration(audioData: Uint8Array): number {
  // Skip ID3v2 tag if present
  let offset = 0;
  if (audioData.length > 10 &&
    audioData[0] === 0x49 && audioData[1] === 0x44 && audioData[2] === 0x33) { // "ID3"
    const size = ((audioData[6] & 0x7F) << 21) |
      ((audioData[7] & 0x7F) << 14) |
      ((audioData[8] & 0x7F) << 7) |
      (audioData[9] & 0x7F);
    offset = 10 + size;
  }

  // Find first valid MP3 frame
  let frameInfo = null;
  for (let i = offset; i < Math.min(offset + 4096, audioData.length - 4); i++) {
    frameInfo = parseMp3FrameHeader(audioData, i);
    if (frameInfo) break;
  }

  if (!frameInfo || frameInfo.bitrate === 0) {
    // Fallback: assume 128kbps
    return audioData.length / 16000;
  }

  // Duration = file size in bits / bitrate
  const audioBytesEstimate = audioData.length - offset;
  return (audioBytesEstimate * 8) / frameInfo.bitrate;
}

// TTS Provider types
export type TTSProvider = "elevenlabs" | "inworld";

// ElevenLabs voice configuration
const ELEVENLABS_VOICES: Record<string, string> = {
  ERIC: "gP8LZQ3GGokV0MP5JYjg", // ElevenLabs Eric voice
  MAYA: "21m00Tcm4TlvDq8ikWAM", // ElevenLabs Rachel voice
};

const ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

// Inworld voice configuration
const INWORLD_VOICES: Record<string, string> = {
  ERIC: "Dennis",
  MAYA: "Sarah",
};

const INWORLD_API_URL = "https://api.inworld.ai/tts/v1/voice";
const INWORLD_MODEL_ID = "inworld-tts-1"

interface Segment {
  speaker: string;
  text: string | null;
}

interface TimingInfo {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

interface ElevenLabsResponse {
  audio_base64: string;
  alignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  };
}

interface GenerateEpisodeResult {
  audioUrl: string;  // URL where audio was uploaded by container
  vttContent: string;
  durationSeconds: number;
  segmentCount: number;
  cacheHits: number;
  apiCalls: number;
}

/**
 * Parse podcast script and extract speaker segments.
 */
export function parseScript(scriptContent: string): Segment[] {
  const segments: Segment[] = [];

  for (const line of scriptContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match speaker lines: **ERIC:** or **MAYA:**
    const speakerMatch = trimmed.match(/\*\*([A-Z]+):\*\*\s*(.*)/);
    if (speakerMatch) {
      const speaker = speakerMatch[1];
      let text = speakerMatch[2];

      // Clean up markdown and source annotations
      text = text.replace(/\{\{[^}]+\}\}/g, ""); // Remove {{...}}
      text = text.replace(/\*\*\[[^\]]*\]\*\*/g, ""); // Remove **[...]**
      text = text.replace(/\[[^\]]*\]/g, ""); // Remove [...]
      text = text.replace(/\*\*/g, "").replace(/\*/g, "");
      text = text.replace(/\s+/g, " ").trim(); // Collapse multiple spaces

      if (text && (speaker === "ERIC" || speaker === "MAYA")) {
        segments.push({ speaker, text });
      }
    }
    // Add pause for section headers
    else if (trimmed.startsWith("## [")) {
      segments.push({ speaker: "PAUSE", text: null });
    }
  }

  return segments;
}

/**
 * Compute cache key for a segment.
 */
export function computeCacheKey(text: string, voiceId: string, provider: TTSProvider): string {
  const modelId = provider === "elevenlabs" ? ELEVENLABS_MODEL_ID : INWORLD_MODEL_ID;
  const version = 3

  const cacheData = JSON.stringify(
    {
      text,
      voice_id: voiceId,
      model_id: modelId,
      provider,
      version,
    },
    Object.keys({
      text,
      voice_id: voiceId,
      model_id: modelId,
      provider,
      version,
    }).sort()
  );

  let hash = 0;
  for (let i = 0; i < cacheData.length; i++) {
    const char = cacheData.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  var truncated = text.slice(0, 20) + "_" + text.slice(-10)
  return String(version) + "/" + truncated.slice(2) + "/" + Math.abs(hash).toString(16).padStart(8, "0") + "_" + provider + "_" + truncated.replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Generate audio for a single segment using ElevenLabs API.
 * Returns audio bytes and duration.
 *
 * Uses continuity parameters (previous_text, next_text) to maintain
 * consistent voice characteristics across segments.
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
): Promise<{ audio: Uint8Array; duration: number }> {
  const voiceId = ELEVENLABS_VOICES[speaker];

  const requestBody: Record<string, unknown> = {
    text,
    model_id: ELEVENLABS_MODEL_ID,
    output_format: "mp3_44100_128", // High quality MP3
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  // Add continuity parameters for consistent voice across segments
  if (options?.previousText) {
    requestBody.previous_text = options.previousText;
  }
  if (options?.nextText) {
    requestBody.next_text = options.nextText;
  }
  // Use a consistent seed per speaker for more deterministic output
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
 * Inworld API response with word-level timestamps.
 */
export interface InworldApiResponse {
  audioContent?: string;  // Base64-encoded audio
  audio?: { url?: string };  // Alternative: audio URL (AIML API)
  timestampInfo?: {
    wordAlignment?: {
      words: string[];
      wordStartTimeSeconds: number[];
      wordEndTimeSeconds: number[];
    };
  };
}

/**
 * Extract duration from Inworld API response word timestamps.
 * Returns the end time of the last word.
 */
export function getInworldDuration(response: InworldApiResponse): number {
  const wordEndTimes = response.timestampInfo?.wordAlignment?.wordEndTimeSeconds;
  if (!wordEndTimes || wordEndTimes.length === 0) {
    throw new Error(`Response missing word timestamps`);
  }
  return wordEndTimes[wordEndTimes.length - 1];
}

/**
 * Generate audio for a single segment using Inworld TTS (via AIML API).
 * Returns audio bytes and duration from word-level timestamps.
 */
async function generateSegmentAudioInworld(
  text: string,
  speaker: string,
  apiKey: string
): Promise<{ audio: Uint8Array; duration: number }> {
  const voice = INWORLD_VOICES[speaker];

  const response = await fetch(INWORLD_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${btoa(apiKey)}`,
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

  const data = await response.json() as InworldApiResponse;

  // Get duration from word-level timestamps
  let duration: number;
  try {
    duration = getInworldDuration(data);
  } catch {
    throw new Error(`Inworld API response missing word timestamps: ${JSON.stringify(data)}`);
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration from timestamps: ${duration}`);
  }

  // Get audio bytes - handle both base64 audioContent and audio URL
  let bytes: Uint8Array;

  if (data.audioContent) {
    // Base64-encoded audio
    const binaryString = atob(data.audioContent);
    bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
  } else if (data.audio?.url) {
    // Fetch from URL
    const audioResponse = await fetch(data.audio.url);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch Inworld audio: ${audioResponse.status}`);
    }
    const audioBuffer = await audioResponse.arrayBuffer();
    bytes = new Uint8Array(audioBuffer);
  } else {
    throw new Error(`Inworld API response missing audio: ${JSON.stringify(data)}`);
  }

  return { audio: bytes, duration };
}

/**
 * Generate a short silence (just empty time in VTT, no actual audio needed for MP3 concat).
 */
function generateSilenceDuration(durationMs: number): number {
  return durationMs / 1000;
}

/**
 * Format seconds as VTT timestamp (HH:MM:SS.mmm).
 * Throws if the value is NaN or negative.
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
 * R2 credentials for generating presigned URLs.
 * Must be set via wrangler secrets.
 */
export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
}

/**
 * Generate a presigned URL for R2 object access.
 * Uses AWS Signature V4 via aws4fetch.
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
 * Request body for FFmpeg container /concat endpoint.
 */
interface ConcatRequest {
  segments: string[];  // Presigned URLs for input MP3 files
  output_url: string;  // Presigned URL for uploading result
  metadata: {
    title: string;
    artist: string;
    album: string;
    genre: string;
  };
}

/**
 * Response from FFmpeg container /concat endpoint.
 */
interface ConcatResponse {
  success: boolean;
  duration_seconds: number;
  file_size: number;
  error?: string;
}

/**
 * Generate WebVTT transcript content.
 */
function generateWebVtt(segments: TimingInfo[]): string {
  const lines = ["WEBVTT", ""];

  let cueNumber = 1;
  for (const segment of segments) {
    if (segment.speaker === "PAUSE") continue;

    const start = formatVttTimestamp(segment.start);
    const end = formatVttTimestamp(segment.end);
    const speaker = segment.speaker.charAt(0) + segment.speaker.slice(1).toLowerCase();

    lines.push(String(cueNumber));
    lines.push(`${start} --> ${end}`);
    lines.push(`<v ${speaker}>${segment.text}`);
    lines.push("");

    cueNumber++;
  }

  return lines.join("\n");
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
    const object = await r2Cache.get(`segments/${cacheKey}.mp3`);
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
    await r2Cache.put(`segments/${cacheKey}.mp3`, audio, {
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { duration: duration.toString() },
    });
  } catch (error) {
    console.error("Failed to cache segment:", error);
  }
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
  provider: TTSProvider = "inworld" // Default to Inworld for new podcasts
): Promise<GenerateEpisodeResult> {
  // Validate API key for provider
  const apiKey = provider === "elevenlabs" ? apiKeys.elevenlabs : apiKeys.inworld;
  if (!apiKey) {
    throw new Error(`API key not provided for ${provider}`);
  }

  // Parse script
  const segments = parseScript(scriptContent);
  if (segments.length === 0) {
    throw new Error("No valid segments found in script");
  }

  // Filter to only speech segments for continuity context
  const speechSegments = segments.filter(
    (s): s is Segment & { text: string } => s.speaker !== "PAUSE" && s.text !== null
  );

  // Use consistent seeds per speaker for deterministic output (ElevenLabs only)
  const speakerSeeds: Record<string, number> = {
    ERIC: 12345,
    MAYA: 67890,
  };

  // Get voice ID based on provider
  const getVoiceId = (speaker: string) =>
    provider === "elevenlabs" ? ELEVENLABS_VOICES[speaker] : INWORLD_VOICES[speaker];

  // Generate all segments and collect cache keys
  const segmentCacheKeys: string[] = [];
  const timingInfo: TimingInfo[] = [];
  let currentTime = 0;
  let cacheHits = 0;
  let apiCalls = 0;
  let speechIndex = 0;

  for (const segment of segments) {
    if (segment.speaker === "PAUSE") {
      // Add 800ms pause (just track time, no audio needed for silence in MP3 concat)
      currentTime += 0.8;
    } else if (segment.text) {
      const voiceId = getVoiceId(segment.speaker);
      const cacheKey = computeCacheKey(segment.text, voiceId, provider);

      // Find previous and next segments for continuity (same speaker preferred)
      const prevSegment = speechIndex > 0 ? speechSegments[speechIndex - 1] : null;
      const nextSegment = speechIndex < speechSegments.length - 1 ? speechSegments[speechIndex + 1] : null;

      // Check cache
      const cached = await getCachedSegment(r2Cache, cacheKey);
      let audio: Uint8Array;
      let duration: number;

      if (cached) {
        cacheHits++;
        audio = cached.audio;
        duration = cached.duration;
      } else {
        // Generate via selected provider
        let result: { audio: Uint8Array; duration: number };

        if (provider === "elevenlabs") {
          result = await generateSegmentAudioElevenLabs(
            segment.text,
            segment.speaker,
            apiKey,
            {
              previousText: prevSegment?.text,
              nextText: nextSegment?.text,
              seed: speakerSeeds[segment.speaker],
            }
          );
        } else {
          result = await generateSegmentAudioInworld(
            segment.text,
            segment.speaker,
            apiKey
          );
        }

        audio = result.audio;
        duration = result.duration;
        apiCalls++;

        // Cache the segment with duration in metadata
        await saveCachedSegment(r2Cache, cacheKey, audio, duration);
      }

      // Track cache key for container
      segmentCacheKeys.push(cacheKey);

      // Track timing for VTT
      timingInfo.push({
        speaker: segment.speaker,
        text: segment.text,
        start: currentTime,
        end: currentTime + duration,
      });

      currentTime += duration;

      // Add 300ms pause between segments
      currentTime += 0.3;
      speechIndex++;
    }
  }

  // Generate presigned URLs for all cached segments
  console.log(`Generating presigned URLs for ${segmentCacheKeys.length} segments...`);
  const segmentUrls = await Promise.all(
    segmentCacheKeys.map((key) =>
      generatePresignedUrl(r2Credentials, "strollcast-cache", `segments/${key}.mp3`, "GET")
    )
  );

  // Derive episode ID from name
  const parts = episodeName.split("-");
  let episodeId: string;
  if (parts.length >= 3) {
    const name = parts.slice(2).join("-");
    const year = parts[1];
    episodeId = `${name}-${year}`;
  } else {
    episodeId = episodeName;
  }

  // Generate presigned URL for output
  const outputKey = `episodes/${episodeId}/${episodeId}.mp3`;
  const outputUrl = await generatePresignedUrl(
    r2Credentials,
    "strollcast-output",
    outputKey,
    "PUT"
  );

  // Call FFmpeg container to concatenate and upload
  console.log("Calling FFmpeg container for concatenation...");
  const containerId = ffmpegContainer.idFromName("audio-processor");
  const container = ffmpegContainer.get(containerId);

  const concatRequest: ConcatRequest = {
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
    throw new Error(`FFmpeg container error: ${containerResponse.status} ${errorText}`);
  }

  const concatResult = (await containerResponse.json()) as ConcatResponse;
  if (!concatResult.success) {
    throw new Error(`FFmpeg concatenation failed: ${concatResult.error}`);
  }

  console.log(`FFmpeg: Concatenated ${segmentCacheKeys.length} segments, duration: ${concatResult.duration_seconds}s`);

  // Use container's duration (accurate from ffprobe)
  const finalDuration = concatResult.duration_seconds;

  // Generate VTT
  const vttContent = generateWebVtt(timingInfo);

  // Audio URL (container uploaded to R2 via presigned URL)
  const audioUrl = `https://released.strollcast.com/${outputKey}`;

  return {
    audioUrl,
    vttContent,
    durationSeconds: finalDuration,
    segmentCount: segments.filter((s) => s.speaker !== "PAUSE").length,
    cacheHits,
    apiCalls,
  };
}

/**
 * Upload episode audio to R2.
 */
export async function uploadEpisode(
  r2Bucket: R2Bucket,
  episodeName: string,
  audioData: Uint8Array
): Promise<string> {
  // Derive episode ID from name (author-year-title -> title-year)
  const parts = episodeName.split("-");
  let episodeId: string;
  if (parts.length >= 3) {
    const name = parts.slice(2).join("-");
    const year = parts[1];
    episodeId = `${name}-${year}`;
  } else {
    episodeId = episodeName;
  }

  const key = `episodes/${episodeId}/${episodeId}.mp3`;
  await r2Bucket.put(key, audioData, {
    httpMetadata: { contentType: "audio/mpeg" },
  });

  // Return public URL via custom domain
  return `https://released.strollcast.com/${key}`;
}

/**
 * Upload VTT transcript to R2.
 */
export async function uploadTranscript(
  r2Bucket: R2Bucket,
  episodeId: string,
  vttContent: string
): Promise<string> {
  const key = `episodes/${episodeId}/${episodeId}.vtt`;
  await r2Bucket.put(key, vttContent, {
    httpMetadata: { contentType: "text/vtt" },
  });

  return `https://released.strollcast.com/${key}`;
}
