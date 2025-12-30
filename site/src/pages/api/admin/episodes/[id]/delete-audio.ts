import type { APIRoute } from 'astro';
import { getSession, ADMIN_GITHUB_USERNAME } from '../../../../../lib/auth';

export const POST: APIRoute = async (context) => {
  // Check authentication
  const session = await getSession(context);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if user is admin
  const username = (session.user as any)?.username;
  if (username !== ADMIN_GITHUB_USERNAME) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const episodeId = context.params.id;
  if (!episodeId) {
    return new Response(JSON.stringify({ error: 'Episode ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get API key from runtime env
  const runtime = (context.locals as any).runtime;
  const env = runtime?.env || {};
  const apiKey = env.STROLLCAST_API_KEY || import.meta.env.STROLLCAST_API_KEY;
  const apiUrl = env.STROLLCAST_API_URL || import.meta.env.STROLLCAST_API_URL || 'https://api.strollcast.com';

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch(`${apiUrl}/admin/episodes/${episodeId}/delete-audio`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error deleting audio:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete audio' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
