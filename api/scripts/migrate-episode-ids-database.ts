/**
 * Migrate episode IDs in D1 database
 *
 * Since SQLite doesn't support easy primary key updates, we:
 * 1. Create a new episodes table with new IDs
 * 2. Copy all data from old table to new table
 * 3. Update jobs table to reference new episode IDs
 * 4. Drop old episodes table and rename new table
 * 5. Recreate indexes
 */

import type { EpisodeIdMapping } from './generate-episode-id-mapping';

export interface DatabaseMigrationStats {
  episodesMigrated: number;
  jobsUpdated: number;
  errors: Array<{ step: string; error: string }>;
}

/**
 * Migrate episode IDs in the database
 *
 * @param db - D1 database binding
 * @param mapping - Episode ID mapping (old_id → new_id)
 * @returns Migration statistics
 */
export async function migrateEpisodeIdsDatabase(
  db: D1Database,
  mapping: EpisodeIdMapping
): Promise<DatabaseMigrationStats> {
  const stats: DatabaseMigrationStats = {
    episodesMigrated: 0,
    jobsUpdated: 0,
    errors: [],
  };

  console.log('\n=== Database Migration ===');
  console.log('Starting database migration...\n');

  try {
    // Step 1: Create new episodes table
    console.log('Step 1: Creating new episodes table...');
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS episodes_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        authors TEXT NOT NULL,
        year INTEGER NOT NULL,
        duration TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        description TEXT NOT NULL,
        audio_url TEXT NOT NULL,
        transcript_url TEXT,
        paper_url TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        published INTEGER DEFAULT 1,
        topics TEXT
      )
    `).run();
    console.log('  Created episodes_new table');

    // Step 2: Copy all episodes with new IDs
    console.log('\nStep 2: Copying episodes with new IDs...');
    const episodes = await db.prepare(
      `SELECT * FROM episodes ORDER BY created_at ASC`
    ).all();

    for (const episode of episodes.results) {
      const oldId = (episode as any).id;
      const newId = mapping[oldId];

      if (!newId) {
        console.warn(`  Warning: No mapping found for ${oldId}, skipping`);
        continue;
      }

      await db.prepare(`
        INSERT INTO episodes_new (
          id, title, authors, year, duration, duration_seconds,
          description, audio_url, transcript_url, paper_url,
          created_at, updated_at, published, topics
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newId,
        (episode as any).title,
        (episode as any).authors,
        (episode as any).year,
        (episode as any).duration,
        (episode as any).duration_seconds,
        (episode as any).description,
        (episode as any).audio_url,
        (episode as any).transcript_url,
        (episode as any).paper_url,
        (episode as any).created_at,
        (episode as any).updated_at,
        (episode as any).published,
        (episode as any).topics
      ).run();

      stats.episodesMigrated++;
      console.log(`  Copied: ${oldId} → ${newId}`);
    }

    // Step 3: Update jobs table to reference new episode IDs
    console.log('\nStep 3: Updating jobs table...');
    for (const [oldId, newId] of Object.entries(mapping)) {
      if (oldId === newId) continue; // Skip if already using new format

      const result = await db.prepare(
        `UPDATE jobs SET episode_id = ? WHERE episode_id = ?`
      ).bind(newId, oldId).run();

      if (result.meta.changes > 0) {
        stats.jobsUpdated += result.meta.changes;
        console.log(`  Updated ${result.meta.changes} job(s): ${oldId} → ${newId}`);
      }
    }

    // Step 4: Drop old table and rename new table
    console.log('\nStep 4: Replacing old episodes table...');
    await db.prepare(`DROP TABLE episodes`).run();
    console.log('  Dropped old episodes table');

    await db.prepare(`ALTER TABLE episodes_new RENAME TO episodes`).run();
    console.log('  Renamed episodes_new to episodes');

    // Step 5: Recreate indexes
    console.log('\nStep 5: Recreating indexes...');
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_episodes_year ON episodes(year DESC)
    `).run();
    console.log('  Created idx_episodes_year');

    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_episodes_published ON episodes(published, created_at DESC)
    `).run();
    console.log('  Created idx_episodes_published');

    console.log('\n=== Database Migration Complete ===');
    console.log(`Episodes migrated: ${stats.episodesMigrated}`);
    console.log(`Jobs updated: ${stats.jobsUpdated}`);

  } catch (error) {
    console.error('Database migration failed:', error);
    stats.errors.push({
      step: 'migration',
      error: String(error),
    });
    throw error; // Re-throw to allow caller to handle
  }

  return stats;
}
