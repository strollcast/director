/**
 * GitHub API module for script.md storage
 * Uses vanilla fetch (no external dependencies) to interact with GitHub REST API v3
 */

export interface GitHubConfig {
  token: string;
  owner: string;  // e.g., 'strollcast'
  repo: string;   // e.g., 'scripts'
}

interface GitHubFileResponse {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;  // base64 encoded
  download_url: string;
}

interface GitHubCommitResponse {
  content: {
    name: string;
    path: string;
    sha: string;
    size: number;
  };
  commit: {
    sha: string;
    message: string;
  };
}

const API_TIMEOUT = 10000; // 10 seconds
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Make a GitHub API request with timeout
 */
async function githubFetch(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if a script.md file exists in GitHub for a given episode ID
 *
 * @param episodeId - Episode ID (e.g., 'vaswani-2017-attention_is_all_you')
 * @param config - GitHub configuration with token, owner, repo
 * @returns true if script exists, false otherwise
 */
export async function checkScriptExists(
  episodeId: string,
  config: GitHubConfig
): Promise<boolean> {
  const path = `${episodeId}/script.md`;
  const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`;

  try {
    const response = await githubFetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Strollcast-API',
      },
    });

    if (response.status === 200) {
      return true;
    } else if (response.status === 404) {
      return false;
    } else {
      const errorText = await response.text();
      console.warn(`GitHub API error checking script existence: ${response.status} - ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error(`Error checking script existence in GitHub for ${episodeId}:`, error);
    return false;
  }
}

/**
 * Push a script.md file to GitHub
 * Creates a new file only - fails if file already exists (idempotency)
 *
 * @param episodeId - Episode ID
 * @param content - Script content (plain text)
 * @param config - GitHub configuration
 * @returns Commit SHA
 * @throws Error if file already exists or GitHub API fails
 */
export async function pushScript(
  episodeId: string,
  content: string,
  config: GitHubConfig
): Promise<string> {
  const path = `${episodeId}/script.md`;
  const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`;

  // Base64 encode the content (required by GitHub API)
  const base64Content = btoa(unescape(encodeURIComponent(content)));

  const body = JSON.stringify({
    message: `Add script for ${episodeId}`,
    content: base64Content,
    committer: {
      name: 'Strollcast Bot',
      email: 'bot@strollcast.com',
    },
    author: {
      name: 'Strollcast Bot',
      email: 'bot@strollcast.com',
    },
  });

  try {
    const response = await githubFetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Strollcast-API',
      },
      body,
    });

    if (response.status === 201) {
      // File created successfully
      const data = await response.json() as GitHubCommitResponse;
      return data.commit.sha;
    } else if (response.status === 422) {
      // File already exists
      throw new Error(`Script already exists in GitHub for ${episodeId}`);
    } else {
      const errorText = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${errorText}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to push script to GitHub: ${String(error)}`);
  }
}

/**
 * Fetch script content from GitHub
 *
 * @param episodeId - Episode ID
 * @param config - GitHub configuration
 * @returns Script content as string, or null if not found
 */
export async function fetchScript(
  episodeId: string,
  config: GitHubConfig
): Promise<string | null> {
  const path = `${episodeId}/script.md`;

  // Use raw.githubusercontent.com for direct content access (faster, no API rate limits)
  const rawUrl = `https://raw.githubusercontent.com/${config.owner}/${config.repo}/main/${path}`;

  try {
    const response = await githubFetch(rawUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Strollcast-API',
      },
    });

    if (response.status === 200) {
      return await response.text();
    } else if (response.status === 404) {
      return null;
    } else {
      const errorText = await response.text();
      console.warn(`GitHub raw content error: ${response.status} - ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching script from GitHub for ${episodeId}:`, error);
    return null;
  }
}

/**
 * Get script metadata (size, last updated) from GitHub
 *
 * @param episodeId - Episode ID
 * @param config - GitHub configuration
 * @returns Metadata object with size and updated timestamp, or null if not found
 */
export async function getScriptMetadata(
  episodeId: string,
  config: GitHubConfig
): Promise<{ size: number; updated: string } | null> {
  const path = `${episodeId}/script.md`;
  const url = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${path}`;

  try {
    const response = await githubFetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Strollcast-API',
      },
    });

    if (response.status === 200) {
      const data = await response.json() as GitHubFileResponse;

      // Get commit info to get last updated time
      const commitsUrl = `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/commits?path=${path}&page=1&per_page=1`;
      const commitsResponse = await githubFetch(commitsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Strollcast-API',
        },
      });

      let updated = new Date().toISOString(); // fallback to now
      if (commitsResponse.status === 200) {
        const commits = await commitsResponse.json() as Array<{ commit: { author: { date: string } } }>;
        if (commits.length > 0 && commits[0].commit?.author?.date) {
          updated = commits[0].commit.author.date;
        }
      }

      return {
        size: data.size,
        updated,
      };
    } else if (response.status === 404) {
      return null;
    } else {
      const errorText = await response.text();
      console.warn(`GitHub API error getting metadata: ${response.status} - ${errorText}`);
      return null;
    }
  } catch (error) {
    console.error(`Error getting script metadata from GitHub for ${episodeId}:`, error);
    return null;
  }
}
