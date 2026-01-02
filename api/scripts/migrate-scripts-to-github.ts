/**
 * One-time migration script to migrate all script.md files from R2 to GitHub
 *
 * This script:
 * 1. Queries the database for all jobs with script_url
 * 2. For each job, fetches the script from R2 and pushes to GitHub
 * 3. Updates the database script_url to point to GitHub
 * 4. Reports migration statistics
 *
 * Usage:
 * - Deploy as a temporary admin endpoint and call via authenticated HTTP request
 * - Or run via wrangler CLI with custom command
 *
 * IMPORTANT: Run on staging environment first to test!
 */

import { checkScriptExists, pushScript, type GitHubConfig } from '../src/github';

interface Job {
  id: string;
  episode_id: string | null;
  script_url: string | null;
  title: string | null;
  year: number | null;
  authors: string | null;
}

interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ episodeId: string; error: string }>;
}

/**
 * Migrate all scripts from R2 to GitHub
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns Migration statistics
 */
export async function migrateScriptsToGitHub(env: {
  DB: D1Database;
  R2: R2Bucket;
  GITHUB_TOKEN: string;
}): Promise<MigrationStats> {
  const stats: MigrationStats = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // GitHub configuration
  const githubConfig: GitHubConfig = {
    token: env.GITHUB_TOKEN,
    owner: 'strollcast',
    repo: 'scripts',
  };

  // Query all jobs with script URLs
  const result = await env.DB.prepare(
    `SELECT id, episode_id, script_url, title, year, authors
     FROM jobs
     WHERE script_url IS NOT NULL
     ORDER BY created_at ASC`
  ).all();

  const jobs = result.results as Job[];
  stats.total = jobs.length;

  console.log(`Found ${jobs.length} jobs with script URLs to migrate`);

  for (const job of jobs) {
    // Skip if no episode_id
    if (!job.episode_id) {
      console.warn(`Skipping job ${job.id}: no episode_id`);
      stats.skipped++;
      continue;
    }

    const episodeId = job.episode_id;

    try {
      // Check if script already exists in GitHub
      const existsInGithub = await checkScriptExists(episodeId, githubConfig);

      if (existsInGithub) {
        console.log(`Script already exists in GitHub for ${episodeId}, skipping`);

        // Update database URL to point to GitHub if it's still pointing to R2
        if (job.script_url?.includes('released.strollcast.com')) {
          const githubUrl = `https://raw.githubusercontent.com/strollcast/scripts/main/${episodeId}/script.md`;
          await env.DB.prepare(
            `UPDATE jobs SET script_url = ? WHERE id = ?`
          ).bind(githubUrl, job.id).run();
          console.log(`Updated database URL to GitHub for ${episodeId}`);
        }

        stats.skipped++;
        continue;
      }

      // Fetch script from R2
      const scriptKey = `episodes/${episodeId}/script.md`;
      const scriptObject = await env.R2.get(scriptKey);

      if (!scriptObject) {
        console.error(`Script not found in R2 for ${episodeId} at ${scriptKey}`);
        stats.failed++;
        stats.errors.push({
          episodeId,
          error: 'Script not found in R2',
        });
        continue;
      }

      const scriptContent = await scriptObject.text();

      // Push to GitHub
      try {
        await pushScript(episodeId, scriptContent, githubConfig);
        console.log(`Successfully pushed script to GitHub for ${episodeId}`);

        // Update database URL to point to GitHub
        const githubUrl = `https://raw.githubusercontent.com/strollcast/scripts/main/${episodeId}/script.md`;
        await env.DB.prepare(
          `UPDATE jobs SET script_url = ? WHERE id = ?`
        ).bind(githubUrl, job.id).run();

        stats.migrated++;

        // Rate limiting: sleep 1 second between pushes
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Failed to push script to GitHub for ${episodeId}:`, error);
        stats.failed++;
        stats.errors.push({
          episodeId,
          error: String(error),
        });
      }
    } catch (error) {
      console.error(`Error processing job ${job.id} (${episodeId}):`, error);
      stats.failed++;
      stats.errors.push({
        episodeId: episodeId || job.id,
        error: String(error),
      });
    }
  }

  return stats;
}

/**
 * Admin endpoint handler for running the migration
 * Add this to your admin routes in index.ts:
 *
 * app.post('/admin/migrate-scripts', async (c) => {
 *   const env = c.env;
 *   const stats = await migrateScriptsToGitHub(env);
 *   return c.json({
 *     success: true,
 *     stats,
 *   });
 * });
 */
export async function handleMigrationRequest(env: {
  DB: D1Database;
  R2: R2Bucket;
  GITHUB_TOKEN: string;
}): Promise<Response> {
  console.log('Starting script migration from R2 to GitHub...');

  const stats = await migrateScriptsToGitHub(env);

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
  });
}
