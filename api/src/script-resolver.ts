/**
 * Script resolver module for finding episode scripts in GitHub or R2
 */

import { checkScriptExists, type GitHubConfig } from './github';

export interface ScriptLocation {
  found: boolean;
  url: string | null;
  source: 'github' | 'r2' | 'none';
}

/**
 * Resolve the location of a script for a given episode
 *
 * Checks GitHub first, then falls back to R2
 *
 * @param episodeId - Episode ID
 * @param githubToken - GitHub Personal Access Token
 * @param r2Bucket - R2 bucket binding (for checking existence)
 * @returns Script location info
 */
export async function resolveScriptLocation(
  episodeId: string,
  githubToken: string,
  r2Bucket: R2Bucket
): Promise<ScriptLocation> {
  // Check GitHub first
  const githubConfig: GitHubConfig = {
    token: githubToken,
    owner: 'strollcast',
    repo: 'scripts',
  };

  const existsInGithub = await checkScriptExists(episodeId, githubConfig);

  if (existsInGithub) {
    return {
      found: true,
      url: `https://raw.githubusercontent.com/strollcast/scripts/main/${episodeId}/script.md`,
      source: 'github',
    };
  }

  // Fall back to R2
  const scriptKey = `episodes/${episodeId}/script.md`;
  const existsInR2 = await r2Bucket.head(scriptKey);

  if (existsInR2) {
    return {
      found: true,
      url: `https://released.strollcast.com/${scriptKey}`,
      source: 'r2',
    };
  }

  // Not found in either location
  return {
    found: false,
    url: null,
    source: 'none',
  };
}
