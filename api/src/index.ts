import { generateTranscript } from "./transcript";

export interface Env {
  DB: D1Database;
  JOBS_QUEUE: Queue;
  R2: R2Bucket;
  // Anthropic API key for transcript generation
  ANTHROPIC_API_KEY: string;
  // Modal web endpoint URL for audio generation
  MODAL_EPISODE_URL: string;
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

  // POST /jobs - Create a new job
  if (path === "/jobs" && request.method === "POST") {
    try {
      const body = (await request.json()) as { arxiv_url?: string };
      const arxivUrl = body.arxiv_url;

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

      // Check if job already exists for this arxiv_id
      const existingJob = await env.DB.prepare(
        `SELECT * FROM jobs WHERE arxiv_id = ? AND status NOT IN ('failed', 'completed') LIMIT 1`
      )
        .bind(arxivId)
        .first<Job>();

      if (existingJob) {
        return Response.json(toJobResponse(existingJob), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // Fetch arXiv metadata
      const metadata = await fetchArxivMetadata(arxivId);

      // Create job
      const jobId = generateUUID();
      await env.DB.prepare(
        `INSERT INTO jobs (id, arxiv_id, arxiv_url, status, title, authors, year, abstract)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
      )
        .bind(
          jobId,
          arxivId,
          arxivUrl,
          metadata.title,
          metadata.authors,
          metadata.year,
          metadata.abstract
        )
        .run();

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

    let query = `SELECT * FROM jobs`;
    const params: string[] = [];

    if (status) {
      query += ` WHERE status = ?`;
      params.push(status);
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
  // Update status
  await env.DB.prepare(
    `UPDATE jobs SET status = 'generating_transcript', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(jobId)
    .run();

  // Get job details
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<Job>();

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Generate transcript directly in the Worker
  const result = await generateTranscript(job.arxiv_id, env.ANTHROPIC_API_KEY);
  const scriptContent = result.script;

  console.log(`Transcript generated for ${job.arxiv_id}, source: ${result.contentSource}`);

  // Save script to R2
  const scriptKey = `active/${jobId}/script.md`;
  await env.R2.put(scriptKey, scriptContent);

  // Update job with script URL
  const scriptUrl = `https://pub-strollcast.r2.dev/${scriptKey}`;
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
  // Update status
  await env.DB.prepare(
    `UPDATE jobs SET status = 'generating_audio', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(jobId)
    .run();

  // Get job details
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<Job>();

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Read script from R2
  const scriptKey = `active/${jobId}/script.md`;
  const scriptObject = await env.R2.get(scriptKey);
  if (!scriptObject) {
    throw new Error(`Script not found at ${scriptKey}`);
  }
  const scriptContent = await scriptObject.text();

  // Generate episode ID from title
  const episodeId = generateEpisodeId(job.title || "untitled", job.year || 2024);

  // Call Modal web endpoint to generate audio
  const response = await fetch(env.MODAL_EPISODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script_content: scriptContent,
      metadata: {
        id: episodeId,
        title: job.title,
        authors: job.authors,
        year: job.year,
        description: job.abstract,
        paper_url: job.arxiv_url,
        topics: [],
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal episode generation failed: ${response.status} ${text}`);
  }

  const modalResponse = (await response.json()) as { episode_id: string; error?: string };

  if (modalResponse.error) {
    throw new Error(`Modal error: ${modalResponse.error}`);
  }

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

  // Clean up active folder
  await env.R2.delete(scriptKey);
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
