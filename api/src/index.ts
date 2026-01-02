import { generateTranscript } from "./transcript";
import { uploadTranscript } from "./audio";
import { generateEpisode, type R2Credentials } from "./episode-generator";
import { Container } from "@cloudflare/containers";
import { checkScriptExists, pushScript, fetchScript, getScriptMetadata, type GitHubConfig } from "./github";
import { migrateScriptsToGitHub } from "../scripts/migrate-scripts-to-github";
import { generateEpisodeIdMapping } from "../scripts/generate-episode-id-mapping";
import { migrateEpisodeIdsR2 } from "../scripts/migrate-episode-ids-r2";
import { migrateEpisodeIdsGitHub } from "../scripts/migrate-episode-ids-github";
import { migrateEpisodeIdsDatabase } from "../scripts/migrate-episode-ids-database";
import { updateEpisodeUrls } from "../scripts/update-episode-urls";
import { resolveScriptLocation } from "./script-resolver";

/**
 * FFmpeg Container class for MP3 concatenation.
 * Runs an Alpine container with FFmpeg for proper audio processing.
 */
export class FFmpegContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m"; // Sleep after 5 minutes of inactivity

  onStart(): void {
    console.log("FFmpeg container started");
  }

  onStop(): void {
    console.log("FFmpeg container stopped");
  }

  onError(error: unknown): void {
    console.error("FFmpeg container error:", error);
  }

  async alarm(): Promise<void> {
    // Handle the sleep alarm - this is called when sleepAfter duration elapses
    console.log("FFmpeg container alarm triggered - sleep timeout reached");
  }
}

export interface Env {
  DB: D1Database;
  JOBS_QUEUE: Queue;
  R2: R2Bucket;        // strollcast-output: episodes, scripts, transcripts
  R2_CACHE: R2Bucket;  // strollcast-cache: segment cache
  FFMPEG_CONTAINER: DurableObjectNamespace;  // FFmpeg container for audio concatenation
  // API keys
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  INWORLD_API_KEY: string;
  API_KEY: string; // For authenticating POST /jobs requests
  GITHUB_TOKEN: string; // GitHub PAT for strollcast/scripts repo
  // R2 credentials for presigned URLs
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CF_ACCOUNT_ID: string;
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

    // Join with jobs to get submitted_by (only latest job per episode)
    const { results } = await env.DB.prepare(
      `SELECT e.*, j.submitted_by
       FROM episodes e
       LEFT JOIN jobs j ON j.episode_id = e.id
         AND j.created_at = (
           SELECT MAX(created_at) FROM jobs WHERE episode_id = e.id
         )
       ORDER BY e.year DESC, e.created_at DESC`
    ).all<Episode & { submitted_by: string | null }>();

    // Get file metadata from R2 for each episode
    const episodesWithMeta = await Promise.all(
      results.map(async (episode) => {
        const baseResponse = toApiResponse(episode);
        const submittedBy = episode.submitted_by;

        // Build R2 paths
        const audioPath = episode.audio_url.replace("https://released.strollcast.com/", "");
        const vttPath = episode.transcript_url?.replace("https://released.strollcast.com/", "");
        const scriptPath = `episodes/${episode.id}/script.md`;

        let scriptSize: number | null = null;
        let scriptUpdated: string | null = null;
        let audioSize: number | null = null;
        let audioUpdated: string | null = null;
        let vttSize: number | null = null;
        let vttUpdated: string | null = null;

        // Check script (GitHub first, R2 fallback)
        try {
          const githubConfig: GitHubConfig = {
            token: env.GITHUB_TOKEN,
            owner: 'strollcast',
            repo: 'scripts',
          };
          const metadata = await getScriptMetadata(episode.id, githubConfig);
          if (metadata) {
            scriptSize = metadata.size;
            scriptUpdated = metadata.updated;
          } else {
            // Fall back to R2 for episodes not yet migrated
            const scriptHead = await env.R2.head(scriptPath);
            if (scriptHead) {
              scriptSize = scriptHead.size;
              scriptUpdated = scriptHead.uploaded.toISOString();
            }
          }
        } catch {
          // File not found or error
        }

        // Check audio
        try {
          const audioHead = await env.R2.head(audioPath);
          if (audioHead) {
            audioSize = audioHead.size;
            audioUpdated = audioHead.uploaded.toISOString();
          }
        } catch {
          // File not found or error
        }

        // Check VTT
        if (vttPath) {
          try {
            const vttHead = await env.R2.head(vttPath);
            if (vttHead) {
              vttSize = vttHead.size;
              vttUpdated = vttHead.uploaded.toISOString();
            }
          } catch {
            // File not found or error
          }
        }

        return {
          ...baseResponse,
          scriptSize,
          scriptUpdated,
          audioSize,
          audioUpdated,
          vttSize,
          vttUpdated,
          submittedBy,
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

    // Check if script exists (GitHub first, R2 fallback)
    const scriptLocation = await resolveScriptLocation(episodeId, env.GITHUB_TOKEN, env.R2);

    if (!scriptLocation.found) {
      // No existing script found in GitHub or R2 - need to regenerate from transcript
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
    await env.DB.prepare(
      `UPDATE jobs SET script_url = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(scriptLocation.url, jobId)
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

  // POST /admin/episodes/:id/delete-audio - Delete audio file for an episode
  const deleteAudioMatch = path.match(/^\/admin\/episodes\/([^/]+)\/delete-audio$/);
  if (deleteAudioMatch && request.method === "POST") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    const episodeId = deleteAudioMatch[1];

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

    // Delete audio file from R2
    const audioPath = episode.audio_url.replace("https://released.strollcast.com/", "");
    try {
      await env.R2.delete(audioPath);
      console.log(`Deleted audio: ${audioPath}`);
    } catch (error) {
      console.error(`Failed to delete audio ${audioPath}:`, error);
    }

    // Delete VTT file from R2
    if (episode.transcript_url) {
      const vttPath = episode.transcript_url.replace("https://released.strollcast.com/", "");
      try {
        await env.R2.delete(vttPath);
        console.log(`Deleted transcript: ${vttPath}`);
      } catch (error) {
        console.error(`Failed to delete transcript ${vttPath}:`, error);
      }
    }

    return Response.json(
      {
        message: "Audio deleted",
        episodeId,
      },
      { headers: corsHeaders }
    );
  }

  // POST /admin/migrate-scripts - Migrate all scripts from R2 to GitHub
  if (path === "/admin/migrate-scripts" && request.method === "POST") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    console.log('Starting script migration from R2 to GitHub...');

    try {
      const stats = await migrateScriptsToGitHub({
        DB: env.DB,
        R2: env.R2,
        GITHUB_TOKEN: env.GITHUB_TOKEN,
      });

      console.log('Migration complete!');
      console.log(`Total: ${stats.total}`);
      console.log(`Migrated: ${stats.migrated}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Failed: ${stats.failed}`);

      if (stats.errors.length > 0) {
        console.log('Errors:');
        stats.errors.forEach(({ episodeId, error }) => {
          console.log(`  - ${episodeId}: ${error}`);
        });
      }

      return Response.json({
        success: stats.failed === 0,
        message: `Migration completed: ${stats.migrated} migrated, ${stats.skipped} skipped, ${stats.failed} failed`,
        stats,
      }, { headers: corsHeaders });
    } catch (error) {
      console.error('Migration failed:', error);
      return Response.json({
        success: false,
        error: String(error),
      }, { status: 500, headers: corsHeaders });
    }
  }

  // POST /admin/migrate-episode-ids - Migrate episode IDs to new format
  if (path === "/admin/migrate-episode-ids" && request.method === "POST") {
    // Verify API key
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace("Bearer ", "");

    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    console.log('Starting episode ID migration...');
    console.log('WARNING: This will update primary keys in the database and copy files in R2/GitHub');

    try {
      // Step 1: Generate mapping
      console.log('\n=== Step 1/5: Generate Mapping ===');
      const mapping = await generateEpisodeIdMapping(env.DB);
      const mappingCount = Object.keys(mapping).length;

      if (mappingCount === 0) {
        return Response.json({
          success: false,
          error: 'No episodes found to migrate',
        }, { status: 400, headers: corsHeaders });
      }

      console.log(`Generated mapping for ${mappingCount} episodes`);

      // Step 2: Migrate R2 files (must happen before database update)
      console.log('\n=== Step 2/5: Migrate R2 Files ===');
      const r2Stats = await migrateEpisodeIdsR2(env.R2, mapping);

      // Step 3: Migrate GitHub scripts
      console.log('\n=== Step 3/5: Migrate GitHub Scripts ===');
      const githubStats = await migrateEpisodeIdsGitHub(env.GITHUB_TOKEN, mapping);

      // Step 4: Migrate database (updates primary keys)
      console.log('\n=== Step 4/5: Migrate Database ===');
      const dbStats = await migrateEpisodeIdsDatabase(env.DB, mapping);

      // Step 5: Update URLs to point to new paths
      console.log('\n=== Step 5/5: Update URLs ===');
      const urlStats = await updateEpisodeUrls(env.DB, mapping);

      console.log('\n=== Episode ID Migration Complete ===');

      return Response.json({
        success: true,
        message: `Episode ID migration completed successfully`,
        stats: {
          mapping: {
            total: mappingCount,
            sample: Object.entries(mapping).slice(0, 5),
          },
          r2: r2Stats,
          github: githubStats,
          database: dbStats,
          urls: urlStats,
        },
      }, { headers: corsHeaders });
    } catch (error) {
      console.error('Episode ID migration failed:', error);
      return Response.json({
        success: false,
        error: String(error),
        message: 'Migration failed. Check logs for details. Database may be in inconsistent state.',
      }, { status: 500, headers: corsHeaders });
    }
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

      // Acknowledge the message - don't retry failed jobs
      message.ack();
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

  // Skip processing if job is already failed or completed
  if (job.status === 'failed' || job.status === 'completed') {
    console.log(`Job ${jobId} already in terminal state: ${job.status}, skipping`);
    return;
  }

  if (!job.title || !job.year || !job.authors) {
    console.log(`Cannot generate transcript for job with missing tile: ${jobId}.`)
    return
  }

  // Generate episode ID from title (same logic used in audio generation)
  const episodeId = generateEpisodeId(
    job.title,
    job.year,
    job.authors,
  );
  const scriptKey = `episodes/${episodeId}/script.md`;

  // GitHub configuration
  const githubConfig: GitHubConfig = {
    token: env.GITHUB_TOKEN,
    owner: 'strollcast',
    repo: 'scripts',
  };

  // Check if script already exists in GitHub (idempotency)
  const existsInGithub = await checkScriptExists(episodeId, githubConfig);
  if (existsInGithub) {
    console.log(`Script already exists in GitHub for episode ${episodeId}, skipping transcript generation`);
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

  // Try to push script to GitHub first, fall back to R2 if it fails
  let scriptUrl: string;
  try {
    await pushScript(episodeId, scriptContent, githubConfig);
    scriptUrl = `https://raw.githubusercontent.com/strollcast/scripts/main/${episodeId}/script.md`;
    console.log(`Script pushed to GitHub for ${episodeId}`);
  } catch (error) {
    // Fall back to R2 storage if GitHub push fails
    console.warn(`GitHub push failed for ${episodeId}, using R2 fallback:`, error);
    await env.R2.put(scriptKey, scriptContent);
    scriptUrl = `https://released.strollcast.com/${scriptKey}`;
  }

  // Update job with script URL (GitHub or R2)
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

  // Skip processing if job is already failed or completed
  if (job.status === 'failed' || job.status === 'completed') {
    console.log(`Job ${jobId} already in terminal state: ${job.status}, skipping`);
    return;
  }

  // Generate episode ID from title
  const episodeId = generateEpisodeId(
    job.title || "untitled",
    job.year || 2024,
    job.authors || "unknown"
  );

  // Check if audio file already exists in R2 (idempotency)
  const mp3Path = `episodes/${episodeId}/${episodeId}.mp3`;
  const m4aPath = `episodes/${episodeId}/${episodeId}.m4a`;
  const existingMp3 = await env.R2.head(mp3Path);
  const existingM4a = await env.R2.head(m4aPath);

  if (existingMp3 || existingM4a) {
    const audioPath = existingMp3 ? mp3Path : m4aPath;
    console.log(`Audio file already exists at ${audioPath}, skipping generation`);
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

  // Read script from GitHub (with R2 fallback for episodes not yet migrated)
  const githubConfig: GitHubConfig = {
    token: env.GITHUB_TOKEN,
    owner: 'strollcast',
    repo: 'scripts',
  };

  let scriptContent = await fetchScript(episodeId, githubConfig);

  if (!scriptContent) {
    // Fall back to R2 for episodes not yet migrated
    console.log(`Script not in GitHub for ${episodeId}, trying R2...`);
    const scriptKey = `episodes/${episodeId}/script.md`;
    const scriptObject = await env.R2.get(scriptKey);
    if (!scriptObject) {
      throw new Error(`Script not found in GitHub or R2 for ${episodeId}`);
    }
    scriptContent = await scriptObject.text();
  }

  // Episode name is now the same as episode ID
  const episodeName = episodeId;

  // R2 credentials for presigned URLs
  const r2Credentials: R2Credentials = {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    accountId: env.CF_ACCOUNT_ID,
  };

  // Generate audio using FFmpeg container (defaults to Inworld TTS)
  console.log(`Generating audio for ${episodeName}...`);
  const result = await generateEpisode(
    scriptContent,
    episodeName,
    {
      elevenlabs: env.ELEVENLABS_API_KEY,
      inworld: env.INWORLD_API_KEY,
    },
    env.R2,
    env.R2_CACHE,
    env.FFMPEG_CONTAINER,
    r2Credentials
  );

  console.log(
    `Audio generated: ${result.segmentCount} segments, ` +
    `${result.cacheHits} cache hits, ${result.apiCalls} API calls`
  );

  // Audio already uploaded by container, just upload transcript
  const audioUrl = result.audioUrl;
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

export function generateEpisodeId(title: string, year: number, authors: string): string {
  // Validate required parameters
  if (!title || title.trim() === "") {
    throw new Error("Title is required for episode ID generation");
  }
  if (!year || year < 1900 || year > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!authors || authors.trim() === "") {
    throw new Error("Authors is required for episode ID generation");
  }

  // Extract last name from first author
  // Remove "et al." suffix before parsing
  authors = authors.replace(" et al.", "");
  const firstAuthor = authors.split(",")[0].split(" and ")[0].trim();
  const lastName = firstAuthor.split(" ").pop()?.toLowerCase() || "unknown";

  // Get first 20 chars of title, replace special chars with _
  const titleSlug = title
    .slice(0, 20)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores

  return `${lastName}-${year}-${titleSlug}`;
}

// ---------- Export ----------

export default {
  fetch: handleRequest,
  queue: handleQueue,
};
