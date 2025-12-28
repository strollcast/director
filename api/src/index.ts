export interface Env {
  DB: D1Database;
}

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

// Transform DB row to API response (camelCase)
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

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

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
};
