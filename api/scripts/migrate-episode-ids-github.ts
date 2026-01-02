/**
 * Migrate GitHub scripts to new episode ID format
 *
 * Copies script.md files from old folder paths to new folder paths.
 * Keeps old scripts for backward compatibility.
 */

import { fetchScript, pushScript, type GitHubConfig } from '../src/github';
import type { EpisodeIdMapping } from './generate-episode-id-mapping';

export interface GitHubMigrationStats {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: Array<{ episodeId: string; error: string }>;
}

/**
 * Migrate all GitHub scripts for mapped episodes
 *
 * @param githubToken - GitHub Personal Access Token
 * @param mapping - Episode ID mapping (old_id → new_id)
 * @returns Migration statistics
 */
export async function migrateEpisodeIdsGitHub(
  githubToken: string,
  mapping: EpisodeIdMapping
): Promise<GitHubMigrationStats> {
  const stats: GitHubMigrationStats = {
    total: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const githubConfig: GitHubConfig = {
    token: githubToken,
    owner: 'strollcast',
    repo: 'scripts',
  };

  const episodes = Object.entries(mapping);
  console.log(`\n=== GitHub Script Migration ===`);
  console.log(`Processing ${episodes.length} episodes...\n`);

  for (const [oldId, newId] of episodes) {
    console.log(`Migrating script: ${oldId} → ${newId}`);
    stats.total++;

    // Skip if already using new format
    if (oldId === newId) {
      console.log(`  Skipped: already using new format`);
      stats.skipped++;
      continue;
    }

    try {
      // Fetch script from old location
      const scriptContent = await fetchScript(oldId, githubConfig);

      if (!scriptContent) {
        console.log(`  Skipped: script not found at old location`);
        stats.skipped++;
        continue;
      }

      // Push script to new location
      try {
        await pushScript(newId, scriptContent, githubConfig);
        console.log(`  Copied: ${oldId}/script.md → ${newId}/script.md`);
        stats.copied++;

        // Rate limiting: sleep 1 second between pushes
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // Check if error is because file already exists
        const errorMsg = String(error);
        if (errorMsg.includes('already exists')) {
          console.log(`  Skipped: script already exists at new location`);
          stats.skipped++;
        } else {
          throw error; // Re-throw if it's a different error
        }
      }
    } catch (error) {
      console.error(`  Error:`, error);
      stats.failed++;
      stats.errors.push({
        episodeId: oldId,
        error: String(error),
      });
    }
  }

  // Report summary
  console.log('\n=== GitHub Migration Summary ===');
  console.log(`Total episodes processed: ${stats.total}`);
  console.log(`Scripts copied: ${stats.copied}`);
  console.log(`Scripts skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.failed}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors encountered:');
    stats.errors.forEach(({ episodeId, error }) => {
      console.log(`  - ${episodeId}: ${error}`);
    });
  }

  return stats;
}
