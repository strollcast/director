/**
 * Migrate R2 files to new episode ID format
 *
 * Copies audio, transcript, and script files from old paths to new paths.
 * Keeps old files for backward compatibility.
 */

import type { EpisodeIdMapping } from './generate-episode-id-mapping';

export interface R2MigrationStats {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: Array<{ episodeId: string; file: string; error: string }>;
}

/**
 * Copy a file in R2 from old path to new path
 *
 * @param r2 - R2 bucket binding
 * @param oldPath - Source path
 * @param newPath - Destination path
 * @returns true if copied, false if skipped (doesn't exist or already exists)
 */
async function copyR2File(
  r2: R2Bucket,
  oldPath: string,
  newPath: string
): Promise<boolean> {
  // Check if new file already exists
  const existingNew = await r2.head(newPath);
  if (existingNew) {
    console.log(`  Skipping ${newPath}: already exists`);
    return false;
  }

  // Get old file
  const oldObject = await r2.get(oldPath);
  if (!oldObject) {
    console.log(`  Skipping ${oldPath}: doesn't exist`);
    return false;
  }

  // Copy to new path
  const arrayBuffer = await oldObject.arrayBuffer();
  await r2.put(newPath, arrayBuffer, {
    httpMetadata: oldObject.httpMetadata,
    customMetadata: oldObject.customMetadata,
  });

  console.log(`  Copied: ${oldPath} → ${newPath}`);
  return true;
}

/**
 * Migrate all R2 files for mapped episodes
 *
 * @param r2 - R2 bucket binding (strollcast-output)
 * @param mapping - Episode ID mapping (old_id → new_id)
 * @returns Migration statistics
 */
export async function migrateEpisodeIdsR2(
  r2: R2Bucket,
  mapping: EpisodeIdMapping
): Promise<R2MigrationStats> {
  const stats: R2MigrationStats = {
    total: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const episodes = Object.entries(mapping);
  console.log(`\n=== R2 File Migration ===`);
  console.log(`Processing ${episodes.length} episodes...\n`);

  for (const [oldId, newId] of episodes) {
    console.log(`Migrating ${oldId} → ${newId}:`);

    // Skip if already using new format
    if (oldId === newId) {
      console.log(`  Skipped: already using new format`);
      stats.skipped++;
      continue;
    }

    const filesToCopy = [
      { ext: 'mp3', name: 'Audio (MP3)' },
      { ext: 'm4a', name: 'Audio (M4A)' },
      { ext: 'vtt', name: 'Transcript (VTT)' },
    ];

    let episodeCopied = false;

    // Copy each file type
    for (const { ext, name } of filesToCopy) {
      const oldPath = `episodes/${oldId}/${oldId}.${ext}`;
      const newPath = `episodes/${newId}/${newId}.${ext}`;

      try {
        stats.total++;
        const copied = await copyR2File(r2, oldPath, newPath);

        if (copied) {
          stats.copied++;
          episodeCopied = true;
        } else {
          stats.skipped++;
        }
      } catch (error) {
        console.error(`  Error copying ${name}:`, error);
        stats.failed++;
        stats.errors.push({
          episodeId: oldId,
          file: oldPath,
          error: String(error),
        });
      }
    }

    // Copy script.md if it exists
    const oldScriptPath = `episodes/${oldId}/script.md`;
    const newScriptPath = `episodes/${newId}/script.md`;

    try {
      stats.total++;
      const copied = await copyR2File(r2, oldScriptPath, newScriptPath);

      if (copied) {
        stats.copied++;
        episodeCopied = true;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      console.error(`  Error copying script:`, error);
      stats.failed++;
      stats.errors.push({
        episodeId: oldId,
        file: oldScriptPath,
        error: String(error),
      });
    }

    console.log(''); // Empty line between episodes
  }

  // Report summary
  console.log('\n=== R2 Migration Summary ===');
  console.log(`Total files processed: ${stats.total}`);
  console.log(`Files copied: ${stats.copied}`);
  console.log(`Files skipped: ${stats.skipped}`);
  console.log(`Errors: ${stats.failed}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors encountered:');
    stats.errors.forEach(({ episodeId, file, error }) => {
      console.log(`  - ${episodeId} (${file}): ${error}`);
    });
  }

  return stats;
}
