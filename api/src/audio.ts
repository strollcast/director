/**
 * Audio generation for Strollcast.
 *
 * Generates podcast audio from scripts using ElevenLabs or Inworld TTS.
 * Runs directly in Cloudflare Worker without Modal/ffmpeg dependency.
 */

// TTS Provider types
export type TTSProvider = "elevenlabs" | "inworld";

// ElevenLabs voice configuration
const ELEVENLABS_VOICES: Record<string, string> = {
  ERIC: "gP8LZQ3GGokV0MP5JYjg", // ElevenLabs Eric voice
  MAYA: "21m00Tcm4TlvDq8ikWAM", // ElevenLabs Rachel voice
};

const ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

// Inworld voice configuration (via AIML API)
const INWORLD_VOICES: Record<string, string> = {
  ERIC: "Dennis",
  MAYA: "Sarah",
};

const INWORLD_API_URL = "https://api.aimlapi.com/v1/tts";
const INWORLD_MODEL = "inworld/tts-1";

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

interface InworldResponse {
  audio: {
    url: string;
    duration: number;
    channels: number;
  };
}

interface GenerateEpisodeResult {
  audioData: Uint8Array;
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
      text = text.replace(/\*\*/g, "").replace(/\*/g, "").trim();

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
 * ElevenLabs uses the original format (version 2) for backwards compatibility.
 * Inworld uses version 3 with provider in the key.
 */
function computeCacheKey(text: string, voiceId: string, provider: TTSProvider): string {
  const modelId = provider === "elevenlabs" ? ELEVENLABS_MODEL_ID : INWORLD_MODEL;

  // ElevenLabs: maintain backwards compatibility with existing cache
  if (provider === "elevenlabs") {
    const cacheData = JSON.stringify(
      {
        text,
        voice_id: voiceId,
        model_id: modelId,
        version: "2",
      },
      Object.keys({
        text,
        voice_id: voiceId,
        model_id: modelId,
        version: "2",
      }).sort()
    );

    let hash = 0;
    for (let i = 0; i < cacheData.length; i++) {
      const char = cacheData.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, "0") + "_" + text.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "");
  }

  // Inworld: new format with provider
  const cacheData = JSON.stringify(
    {
      text,
      voice_id: voiceId,
      model_id: modelId,
      provider,
      version: "1",
    },
    Object.keys({
      text,
      voice_id: voiceId,
      model_id: modelId,
      provider,
      version: "1",
    }).sort()
  );

  let hash = 0;
  for (let i = 0; i < cacheData.length; i++) {
    const char = cacheData.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, "0") + "_" + provider + "_" + text.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "");
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
  const endTimes = data.alignment.character_end_times_seconds;
  const duration = endTimes.length > 0 ? endTimes[endTimes.length - 1] : 0;

  return { audio: bytes, duration };
}

/**
 * Generate audio for a single segment using Inworld TTS (via AIML API).
 * Returns audio bytes and duration.
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
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: INWORLD_MODEL,
      text,
      voice,
      format: "mp3",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Inworld API error: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as InworldResponse;

  // Fetch the audio from the URL
  const audioResponse = await fetch(data.audio.url);
  if (!audioResponse.ok) {
    throw new Error(`Failed to fetch Inworld audio: ${audioResponse.status}`);
  }

  const audioBuffer = await audioResponse.arrayBuffer();
  const bytes = new Uint8Array(audioBuffer);

  return { audio: bytes, duration: data.audio.duration };
}

/**
 * Generate a short silence (just empty time in VTT, no actual audio needed for MP3 concat).
 */
function generateSilenceDuration(durationMs: number): number {
  return durationMs / 1000;
}

/**
 * Format seconds as VTT timestamp (HH:MM:SS.mmm).
 */
function formatVttTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
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
 * Check R2 cache for a segment.
 */
async function getCachedSegment(
  r2Cache: R2Bucket,
  cacheKey: string
): Promise<Uint8Array | null> {
  try {
    const object = await r2Cache.get(`segments/${cacheKey}.mp3`);
    if (object) {
      const arrayBuffer = await object.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }
  } catch {
    // Cache miss or error
  }
  return null;
}

/**
 * Save segment to R2 cache.
 */
async function saveCachedSegment(
  r2Cache: R2Bucket,
  cacheKey: string,
  audio: Uint8Array
): Promise<void> {
  try {
    await r2Cache.put(`segments/${cacheKey}.mp3`, audio, {
      httpMetadata: { contentType: "audio/mpeg" },
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

  // Generate all segments
  const audioChunks: Uint8Array[] = [];
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
      let audio = await getCachedSegment(r2Cache, cacheKey);
      let duration: number;

      if (audio) {
        cacheHits++;
        // Estimate duration from file size (rough: ~16kbps for speech MP3)
        // More accurate would be to store duration in cache metadata
        duration = audio.length / 2000; // Rough estimate
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

        // Cache the segment
        await saveCachedSegment(r2Cache, cacheKey, audio);
      }

      audioChunks.push(audio);

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

  // Concatenate all audio chunks (MP3 files can be concatenated directly)
  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const concatenatedAudio = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    concatenatedAudio.set(chunk, offset);
    offset += chunk.length;
  }

  // Generate VTT
  const vttContent = generateWebVtt(timingInfo);

  return {
    audioData: concatenatedAudio,
    vttContent,
    durationSeconds: currentTime,
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
