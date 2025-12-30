import { generateTranscript } from "./transcript";
import { generateEpisode, uploadEpisode, uploadTranscript } from "./audio";

export interface Env {
  DB: D1Database;
  JOBS_QUEUE: Queue;
  R2: R2Bucket;        // strollcast-output: episodes, scripts, transcripts
  R2_CACHE: R2Bucket;  // strollcast-cache: segment cache
  // API keys
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  INWORLD_API_KEY: string;
  API_KEY: string; // For authenticating POST /jobs requests
}

// ---------- Episode Types ----------

interface Episode {
  id: string;
  title: string;
  authors: string;
  year: number;
  description: string;
  duration: string;
  duration_seconds: number | null;
  audio_url: string;
  transcript_url: string | null;
  paper_url: string | null;
  topics: string | null;
  created_at: string;
  updated_at: string;
  published: number;
}

function toApiResponse(episode: Episode) {
  return {
    id: episode.id,
    title: episode.title,
    authors: episode.authors,
    year: episode.year,
    description: episode.description,
    duration: episode.duration,
    durationSeconds: episode.duration_seconds,
    audioUrl: episode.audio_url,
    transcriptUrl: episode.transcript_url,
    paperUrl: episode.paper_url,
    topics: episode.topics ? JSON.parse(episode.topics) : [],
  };
}

// ---------- Job Types ----------

interface Job {
  id: string;
  arxiv_id: string;
  arxiv_url: string;
  status: string;
  error_message: string | null;
  title: string | null;
  authors: string | null;
  year: number | null;
  abstract: string | null;
  episode_id: string | null;
  script_url: string | null;
  submitted_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface QueueMessage {
  job_id: string;
  stage: "generate_transcript" | "generate_audio";
  attempt: number;
}

function toJobResponse(job: Job) {
  return {
    jobId: job.id,
    arxivId: job.arxiv_id,
    arxivUrl: job.arxiv_url,
    status: job.status,
    errorMessage: job.error_message,
    title: job.title,
    authors: job.authors,
    year: job.year,
    abstract: job.abstract,
    episodeId: job.episode_id,
    scriptUrl: job.script_url,
    submittedBy: job.submitted_by,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
  };
}

// ---------- Helpers ----------

function generateUUID(): string {
  return crypto.randomUUID();
}

function parseArxivUrl(url: string): string | null {
  // Match patterns like:
  // https://arxiv.org/abs/2309.06180
  // https://arxiv.org/pdf/2309.06180
  // http://arxiv.org/abs/2309.06180v1
  const match = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d+\.\d+)/);
  return match ? match[1] : null;
}

async function fetchArxivMetadata(
  arxivId: string
): Promise<{ title: string; authors: string; year: number; abstract: string }> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
  const response = await fetch(apiUrl);
  const xml = await response.text();

  // Extract from <entry> block
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) {
    throw new Error("Could not find entry in arXiv response");
  }
  const entry = entryMatch[1];

  // Extract title
  const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, " ").trim()
    : "Unknown Title";

  // Extract authors
  const authorMatches = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)];
  const authorNames = authorMatches.map((m) => m[1].trim());
  const authors =
    authorNames.length > 2
      ? `${authorNames[0]} et al.`
      : authorNames.join(" and ") || "Unknown";

  // Extract year from published date
  const publishedMatch = entry.match(/<published>(\d{4})/);
  const year = publishedMatch ? parseInt(publishedMatch[1]) : new Date().getFullYear();

  // Extract abstract
  const abstractMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
  const abstract = abstractMatch
    ? abstractMatch[1].replace(/\s+/g, " ").trim()
    : "";

  return { title, authors, year, abstract };
}

// ---------- CORS ----------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------- HTTP Handler ----------

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ===== Episode Endpoints =====

  // GET /episodes - List all published episodes
  if (path === "/episodes" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM episodes WHERE published = 1 ORDER BY year DESC, created_at DESC`
    ).all<Episode>();

    return Response.json(
      {
        version: "2.0",
        updated: new Date().toISOString(),
        episodes: results.map(toApiResponse),
      },
      { headers: corsHeaders }
    );
  }

  // GET /episodes/:id - Get single episode
  const episodeMatch = path.match(/^\/episodes\/([^/]+)$/);
  if (episodeMatch && request.method === "GET") {
    const id = episodeMatch[1];
    const episode = await env.DB.prepare(
      `SELECT * FROM episodes WHERE id = ? AND published = 1`
    )
      .bind(id)
      .first<Episode>();

    if (!episode) {
      return Response.json(
        { error: "Episode not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return Response.json(toApiResponse(episode), { headers: corsHeaders });
  }

  // ===== Job Endpoints =====

  // POST /jobs - Create a new job (requires authentication)
  if (path === "/jobs" && request.method === "POST") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    try {
      const body = (await request.json()) as { arxiv_url?: string; submitted_by?: string };
      const arxivUrl = body.arxiv_url;
      const submittedBy = body.submitted_by || null;

      if (!arxivUrl) {
        return Response.json(
          { error: "arxiv_url is required" },
          { status: 400, headers: corsHeaders }
        );
      }

      const arxivId = parseArxivUrl(arxivUrl);
      if (!arxivId) {
        return Response.json(
          { error: "Invalid arXiv URL format" },
          { status: 400, headers: corsHeaders }
        );
      }

      // Check if episode already exists for this arXiv paper
      const existingEpisode = await env.DB.prepare(
        `SELECT * FROM episodes WHERE paper_url LIKE ? AND published = 1 LIMIT 1`
      )
        .bind(`%${arxivId}%`)
        .first<Episode>();

      if (existingEpisode) {
        return Response.json(
          {
            message: "Episode already exists for this paper",
            episode: toApiResponse(existingEpisode),
          },
          { status: 200, headers: corsHeaders }
        );
      }

      // Check if job already exists for this arxiv_id (in progress)
      const existingJob = await env.DB.prepare(
        `SELECT * FROM jobs WHERE arxiv_id = ? AND status NOT IN ('failed', 'completed') LIMIT 1`
      )
        .bind(arxivId)
        .first<Job>();

      if (existingJob) {
        return Response.json(
          {
            message: "Job already in progress",
            job: toJobResponse(existingJob),
          },
          { status: 200, headers: corsHeaders }
        );
      }

      // Fetch arXiv metadata
      const metadata = await fetchArxivMetadata(arxivId);

      // Create job - unique constraint prevents duplicate active jobs
      const jobId = generateUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO jobs (id, arxiv_id, arxiv_url, status, title, authors, year, abstract, submitted_by)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
        )
          .bind(
            jobId,
            arxivId,
            arxivUrl,
            metadata.title,
            metadata.authors,
            metadata.year,
            metadata.abstract,
            submittedBy
          )
          .run();
      } catch (error) {
        // Race condition: another request created the job first
        if (String(error).includes("UNIQUE constraint failed")) {
          const racingJob = await env.DB.prepare(
            `SELECT * FROM jobs WHERE arxiv_id = ? AND status NOT IN ('failed', 'completed') LIMIT 1`
          )
            .bind(arxivId)
            .first<Job>();

          if (racingJob) {
            return Response.json(
              {
                message: "Job already in progress (concurrent request)",
                job: toJobResponse(racingJob),
              },
              { status: 200, headers: corsHeaders }
            );
          }
        }
        throw error;
      }

      // Send to queue
      await env.JOBS_QUEUE.send({
        job_id: jobId,
        stage: "generate_transcript",
        attempt: 1,
      } as QueueMessage);

      // Fetch the created job
      const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
        .bind(jobId)
        .first<Job>();

      return Response.json(toJobResponse(job!), {
        status: 201,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("Error creating job:", error);
      return Response.json(
        { error: "Failed to create job", details: String(error) },
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // GET /jobs - List recent jobs
  if (path === "/jobs" && request.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const status = url.searchParams.get("status");
    const submittedBy = url.searchParams.get("submitted_by");

    let query = `SELECT * FROM jobs`;
    const conditions: string[] = [];
    const params: string[] = [];

    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }

    if (submittedBy) {
      conditions.push(`submitted_by = ?`);
      params.push(submittedBy);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(String(limit));

    const stmt = env.DB.prepare(query);
    const { results } = await stmt.bind(...params).all<Job>();

    return Response.json(
      { jobs: results.map(toJobResponse) },
      { headers: corsHeaders }
    );
  }

  // GET /jobs/:id - Get single job
  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") {
    const id = jobMatch[1];
    const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
      .bind(id)
      .first<Job>();

    if (!job) {
      return Response.json(
        { error: "Job not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    return Response.json(toJobResponse(job), { headers: corsHeaders });
  }

  // ===== Admin Endpoints =====

  // GET /admin/episodes - List all episodes with file metadata
  if (path === "/admin/episodes" && request.method === "GET") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const { results } = await env.DB.prepare(
      `SELECT * FROM episodes ORDER BY year DESC, created_at DESC`
    ).all<Episode>();

    // Get file metadata from R2 for each episode
    const episodesWithMeta = await Promise.all(
      results.map(async (episode) => {
        const baseResponse = toApiResponse(episode);

        // Parse episode ID from audio URL to get R2 path
        // Audio URL: https://released.strollcast.com/episodes/{id}/{id}.mp3
        const audioPath = episode.audio_url.replace("https://released.strollcast.com/", "");
        const transcriptPath = episode.transcript_url?.replace("https://released.strollcast.com/", "");

        let audioSize: number | null = null;
        let audioUpdated: string | null = null;
        let transcriptSize: number | null = null;
        let transcriptUpdated: string | null = null;

        try {
          const audioHead = await env.R2.head(audioPath);
          if (audioHead) {
            audioSize = audioHead.size;
            audioUpdated = audioHead.uploaded.toISOString();
          }
        } catch {
          // File not found or error
        }

        if (transcriptPath) {
          try {
            const transcriptHead = await env.R2.head(transcriptPath);
            if (transcriptHead) {
              transcriptSize = transcriptHead.size;
              transcriptUpdated = transcriptHead.uploaded.toISOString();
            }
          } catch {
            // File not found or error
          }
        }

        return {
          ...baseResponse,
          audioSize,
          audioUpdated,
          transcriptSize,
          transcriptUpdated,
        };
      })
    );

    return Response.json(
      { episodes: episodesWithMeta },
      { headers: corsHeaders }
    );
  }

  // POST /admin/episodes/:id/regenerate-audio - Regenerate audio for an episode
  const regenerateMatch = path.match(/^\/admin\/episodes\/([^/]+)\/regenerate-audio$/);
  if (regenerateMatch && request.method === "POST") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const episodeId = regenerateMatch[1];

    // Get episode from database
    const episode = await env.DB.prepare(
      `SELECT * FROM episodes WHERE id = ?`
    )
      .bind(episodeId)
      .first<Episode>();

    if (!episode) {
      return Response.json(
        { error: "Episode not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Create a regeneration job
    const jobId = generateUUID();

    // Extract arXiv ID from paper URL
    const arxivMatch = episode.paper_url?.match(/arxiv\.org\/(?:abs|pdf)\/(\d+\.\d+)/);
    const arxivId = arxivMatch ? arxivMatch[1] : episodeId;

    await env.DB.prepare(
      `INSERT INTO jobs (id, arxiv_id, arxiv_url, status, title, authors, year, abstract, episode_id, submitted_by)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'admin-regenerate')`
    )
      .bind(
        jobId,
        arxivId,
        episode.paper_url || "",
        episode.title,
        episode.authors,
        episode.year,
        episode.description,
        episodeId
      )
      .run();

    // Check if script exists in episodes folder
    const scriptKey = `episodes/${episodeId}/script.md`;
    const existingScript = await env.R2.head(scriptKey);

    if (!existingScript) {
      // No existing script found - need to regenerate from transcript
      await env.DB.prepare(
        `UPDATE jobs SET status = 'failed', error_message = 'No script found for episode. Full regeneration required.', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(jobId)
        .run();

      return Response.json(
        { error: "No script found for episode. Full regeneration required." },
        { status: 400, headers: corsHeaders }
      );
    }

    // Update job with script URL
    const scriptUrl = `https://released.strollcast.com/${scriptKey}`;
    await env.DB.prepare(
      `UPDATE jobs SET script_url = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(scriptUrl, jobId)
      .run();

    // Queue directly to audio generation stage (skip transcript generation)
    await env.JOBS_QUEUE.send({
      job_id: jobId,
      stage: "generate_audio",
      attempt: 1,
    } as QueueMessage);

    return Response.json(
      {
        message: "Audio regeneration queued",
        jobId,
        episodeId,
      },
      { status: 202, headers: corsHeaders }
    );
  }

  return Response.json(
    { error: "Not found" },
    { status: 404, headers: corsHeaders }
  );
}

// ---------- Queue Handler ----------

async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { job_id, stage, attempt } = message.body;
    console.log(`Processing job ${job_id}, stage: ${stage}, attempt: ${attempt}`);

    try {
      if (stage === "generate_transcript") {
        await handleGenerateTranscript(job_id, env);
      } else if (stage === "generate_audio") {
        await handleGenerateAudio(job_id, env);
      }
      message.ack();
    } catch (error) {
      console.error(`Error processing job ${job_id}:`, error);

      // Update job with error
      await env.DB.prepare(
        `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(String(error), job_id)
        .run();

      // Let the queue retry
      message.retry();
    }
  }
}

async function handleGenerateTranscript(jobId: string, env: Env): Promise<void> {
  // Get job details
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<Job>();

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Generate episode ID from title (same logic used in audio generation)
  const episodeId = generateEpisodeId(job.title || "untitled", job.year || 2024);
  const scriptKey = `episodes/${episodeId}/script.md`;

  // Check if script already exists in R2 (idempotency)
  const existingScript = await env.R2.head(scriptKey);
  if (existingScript) {
    console.log(`Script already exists for episode ${episodeId}, skipping transcript generation`);
    // Update job with episode_id if not set
    await env.DB.prepare(
      `UPDATE jobs SET episode_id = ?, updated_at = datetime('now') WHERE id = ? AND episode_id IS NULL`
    )
      .bind(episodeId, jobId)
      .run();
    // Proceed directly to audio stage
    await env.JOBS_QUEUE.send({
      job_id: jobId,
      stage: "generate_audio",
      attempt: 1,
    } as QueueMessage);
    return;
  }

  // Update status
  await env.DB.prepare(
    `UPDATE jobs SET status = 'generating_transcript', episode_id = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(episodeId, jobId)
    .run();

  // Generate transcript directly in the Worker
  const result = await generateTranscript(job.arxiv_id, env.ANTHROPIC_API_KEY);
  const scriptContent = result.script;

  console.log(`Transcript generated for ${job.arxiv_id}, source: ${result.contentSource}`);

  // Save script to R2 in episodes folder
  await env.R2.put(scriptKey, scriptContent);

  // Update job with script URL
  const scriptUrl = `https://released.strollcast.com/${scriptKey}`;
  await env.DB.prepare(
    `UPDATE jobs SET script_url = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(scriptUrl, jobId)
    .run();

  // Send next stage to queue
  await env.JOBS_QUEUE.send({
    job_id: jobId,
    stage: "generate_audio",
    attempt: 1,
  } as QueueMessage);
}

async function handleGenerateAudio(jobId: string, env: Env): Promise<void> {
  // Get job details
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<Job>();

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Generate episode ID from title
  const episodeId = generateEpisodeId(job.title || "untitled", job.year || 2024);

  // Check if episode already exists in database (idempotency)
  const existingEpisode = await env.DB.prepare(
    `SELECT * FROM episodes WHERE id = ? AND published = 1`
  )
    .bind(episodeId)
    .first<Episode>();

  if (existingEpisode) {
    console.log(`Episode ${episodeId} already exists, marking job as completed`);
    // Mark job as completed
    await env.DB.prepare(
      `UPDATE jobs
       SET status = 'completed',
           episode_id = ?,
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(episodeId, jobId)
      .run();
    return;
  }

  // Update status
  await env.DB.prepare(
    `UPDATE jobs SET status = 'generating_audio', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(jobId)
    .run();

  // Read script from R2 (stored in episodes folder)
  const scriptKey = `episodes/${episodeId}/script.md`;
  const scriptObject = await env.R2.get(scriptKey);
  if (!scriptObject) {
    throw new Error(`Script not found at ${scriptKey}`);
  }
  const scriptContent = await scriptObject.text();

  // Derive episode name
  const firstAuthor = (job.authors || "unknown").split(",")[0].split(" and ")[0].trim();
  const lastName = firstAuthor.split(" ").pop()?.toLowerCase() || "unknown";
  const episodeName = `${lastName}-${job.year || 2024}-${episodeId.split("-")[0]}`;

  // Generate audio directly in the Worker (defaults to Inworld TTS)
  console.log(`Generating audio for ${episodeName}...`);
  const result = await generateEpisode(
    scriptContent,
    episodeName,
    {
      elevenlabs: env.ELEVENLABS_API_KEY,
      inworld: env.INWORLD_API_KEY,
    },
    env.R2,
    env.R2_CACHE
  );

  console.log(
    `Audio generated: ${result.segmentCount} segments, ` +
    `${result.cacheHits} cache hits, ${result.apiCalls} API calls`
  );

  // Upload audio and transcript to R2
  const audioUrl = await uploadEpisode(env.R2, episodeName, result.audioData);
  const vttUrl = await uploadTranscript(env.R2, episodeId, result.vttContent);

  // Format duration string
  const durationMins = Math.round(result.durationSeconds / 60);
  const durationStr = `${durationMins} min`;

  // Upsert episode to database
  await env.DB.prepare(
    `INSERT INTO episodes (id, title, authors, year, description, duration, duration_seconds, audio_url, transcript_url, paper_url, topics, published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       authors = excluded.authors,
       year = excluded.year,
       description = excluded.description,
       duration = excluded.duration,
       duration_seconds = excluded.duration_seconds,
       audio_url = excluded.audio_url,
       transcript_url = excluded.transcript_url,
       paper_url = excluded.paper_url,
       topics = excluded.topics,
       updated_at = datetime('now')`
  )
    .bind(
      episodeId,
      job.title,
      job.authors,
      job.year,
      job.abstract,
      durationStr,
      Math.round(result.durationSeconds),
      audioUrl,
      vttUrl,
      job.arxiv_url,
      JSON.stringify([])
    )
    .run();

  // Update job as completed
  await env.DB.prepare(
    `UPDATE jobs
     SET status = 'completed',
         episode_id = ?,
         completed_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(episodeId, jobId)
    .run();

  console.log(`Episode ${episodeId} completed: ${audioUrl}`);
}

function generateEpisodeId(title: string, year: number): string {
  // Convert title to slug: "PagedAttention: Memory Management..." -> "pagedattention"
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")[0]; // Take first word
  return `${slug}-${year}`;
}

// ---------- Export ----------

export default {
  fetch: handleRequest,
  queue: handleQueue,
};
