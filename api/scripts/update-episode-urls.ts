/**
 * Update episode URLs in database to point to new file paths
 *
 * After R2 files have been migrated, update the audio_url and transcript_url
 * in the episodes table to point to the new paths using new episode IDs.
 */

import type { EpisodeIdMapping } from './generate-episode-id-mapping';

export interface UrlUpdateStats {
  total: number;
  updated: number;
  skipped: number;
  errors: Array<{ episodeId: string; error: string }>;
}

/**
 * Determine the file extension from a URL
 *
 * @param url - URL to check
 * @returns File extension (mp3, m4a, vtt) or null
 */
function getFileExtension(url: string | null): string | null {
  if (!url) return null;

  if (url.endsWith('.mp3')) return 'mp3';
  if (url.endsWith('.m4a')) return 'm4a';
  if (url.endsWith('.vtt')) return 'vtt';

  return null;
}

/**
 * Update episode URLs in the database
 *
 * @param db - D1 database binding
 * @param mapping - Episode ID mapping (old_id → new_id)
 * @returns Update statistics
 */
export async function updateEpisodeUrls(
  db: D1Database,
  mapping: EpisodeIdMapping
): Promise<UrlUpdateStats> {
  const stats: UrlUpdateStats = {
    total: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  console.log('\n=== Episode URL Update ===');
  console.log('Updating episode URLs to point to new file paths...\n');

  // Get all episodes
  const result = await db.prepare(
    `SELECT id, audio_url, transcript_url FROM episodes`
  ).all();

  const episodes = result.results as Array<{
    id: string;
    audio_url: string;
    transcript_url: string | null;
  }>;

  stats.total = episodes.length;

  for (const episode of episodes) {
    const episodeId = episode.id;

    try {
      // Determine audio file extension
      const audioExt = getFileExtension(episode.audio_url) || 'mp3'; // Default to mp3

      // Build new URLs using current episode ID (which is already the new format after DB migration)
      const newAudioUrl = `https://released.strollcast.com/episodes/${episodeId}/${episodeId}.${audioExt}`;
      const newTranscriptUrl = episode.transcript_url
        ? `https://released.strollcast.com/episodes/${episodeId}/${episodeId}.vtt`
        : null;

      // Check if URLs need updating
      const audioNeedsUpdate = episode.audio_url !== newAudioUrl;
      const transcriptNeedsUpdate = episode.transcript_url !== newTranscriptUrl;

      if (!audioNeedsUpdate && !transcriptNeedsUpdate) {
        console.log(`  Skipped ${episodeId}: URLs already correct`);
        stats.skipped++;
        continue;
      }

      // Update the episode
      await db.prepare(`
        UPDATE episodes
        SET audio_url = ?,
            transcript_url = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(newAudioUrl, newTranscriptUrl, episodeId).run();

      console.log(`  Updated ${episodeId}:`);
      if (audioNeedsUpdate) {
        console.log(`    Audio: ${episode.audio_url} → ${newAudioUrl}`);
      }
      if (transcriptNeedsUpdate) {
        console.log(`    Transcript: ${episode.transcript_url || 'null'} → ${newTranscriptUrl || 'null'}`);
      }

      stats.updated++;
    } catch (error) {
      console.error(`  Error updating ${episodeId}:`, error);
      stats.errors.push({
        episodeId,
        error: String(error),
      });
    }
  }

  // Report summary
  console.log('\n=== URL Update Summary ===');
  console.log(`Total episodes: ${stats.total}`);
  console.log(`URLs updated: ${stats.updated}`);
  console.log(`URLs skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors encountered:');
    stats.errors.forEach(({ episodeId, error }) => {
      console.log(`  - ${episodeId}: ${error}`);
    });
  }

  return stats;
}
