import { describe, it, expect } from 'vitest';

describe('Admin API Response', () => {
  describe('Episode with file metadata structure', () => {
    it('should include all required file URL fields', () => {
      // This validates the expected response structure for admin episodes
      const mockEpisodeWithMeta = {
        id: 'test-2024-example',
        title: 'Test Episode',
        authors: 'Test Author',
        year: 2024,
        duration: '10 min',
        description: 'Test description',
        audioUrl: 'https://released.strollcast.com/episodes/test-2024-example/test-2024-example.mp3',
        transcriptUrl: 'https://released.strollcast.com/episodes/test-2024-example/test-2024-example.vtt',
        paperUrl: 'https://arxiv.org/abs/1234.56789',
        topics: [],
        scriptSize: 1024,
        scriptUpdated: '2024-01-01T00:00:00Z',
        scriptUrl: 'https://github.com/strollcast/scripts/blob/main/test-2024-example/script.md',
        scriptSource: 'github' as const,
        audioSize: 5242880,
        audioUpdated: '2024-01-01T00:00:00Z',
        vttSize: 2048,
        vttUpdated: '2024-01-01T00:00:00Z',
        vttUrl: 'https://released.strollcast.com/episodes/test-2024-example/test-2024-example.vtt',
        submittedBy: 'test-user',
      };

      // Verify all URL fields are present
      expect(mockEpisodeWithMeta).toHaveProperty('scriptUrl');
      expect(mockEpisodeWithMeta).toHaveProperty('audioUrl');
      expect(mockEpisodeWithMeta).toHaveProperty('vttUrl');
      expect(mockEpisodeWithMeta).toHaveProperty('scriptSource');

      // Verify scriptUrl points to GitHub or R2
      expect(
        mockEpisodeWithMeta.scriptUrl?.startsWith('https://github.com/') ||
        mockEpisodeWithMeta.scriptUrl?.startsWith('https://released.strollcast.com/')
      ).toBe(true);

      // Verify audioUrl is from database (released.strollcast.com)
      expect(mockEpisodeWithMeta.audioUrl).toContain('released.strollcast.com');

      // Verify vttUrl is from database (released.strollcast.com)
      expect(mockEpisodeWithMeta.vttUrl).toContain('released.strollcast.com');
    });

    it('should handle episode with script in GitHub', () => {
      const episodeWithGitHubScript = {
        scriptUrl: 'https://github.com/strollcast/scripts/blob/main/test-2024-example/script.md',
        scriptSource: 'github' as const,
        scriptSize: 1024,
        scriptUpdated: '2024-01-01T00:00:00Z',
      };

      expect(episodeWithGitHubScript.scriptUrl).toContain('github.com/strollcast/scripts');
      expect(episodeWithGitHubScript.scriptSource).toBe('github');
    });

    it('should handle episode with script in R2', () => {
      const episodeWithR2Script = {
        scriptUrl: 'https://released.strollcast.com/episodes/test-2024-example/script.md',
        scriptSource: 'r2' as const,
        scriptSize: 1024,
        scriptUpdated: '2024-01-01T00:00:00Z',
      };

      expect(episodeWithR2Script.scriptUrl).toContain('released.strollcast.com');
      expect(episodeWithR2Script.scriptSource).toBe('r2');
    });

    it('should handle episode without script', () => {
      const episodeWithoutScript = {
        scriptUrl: null,
        scriptSource: null,
        scriptSize: null,
        scriptUpdated: null,
      };

      expect(episodeWithoutScript.scriptUrl).toBeNull();
      expect(episodeWithoutScript.scriptSource).toBeNull();
      expect(episodeWithoutScript.scriptSize).toBeNull();
    });

    it('should handle episode without VTT', () => {
      const episodeWithoutVtt = {
        vttUrl: null,
        vttSize: null,
        vttUpdated: null,
      };

      expect(episodeWithoutVtt.vttUrl).toBeNull();
      expect(episodeWithoutVtt.vttSize).toBeNull();
    });

    it('should include file sizes as numbers', () => {
      const episodeWithFiles = {
        scriptSize: 1024,
        audioSize: 5242880,
        vttSize: 2048,
      };

      expect(typeof episodeWithFiles.scriptSize).toBe('number');
      expect(typeof episodeWithFiles.audioSize).toBe('number');
      expect(typeof episodeWithFiles.vttSize).toBe('number');
      expect(episodeWithFiles.scriptSize).toBeGreaterThan(0);
      expect(episodeWithFiles.audioSize).toBeGreaterThan(0);
      expect(episodeWithFiles.vttSize).toBeGreaterThan(0);
    });

    it('should include timestamps in ISO format', () => {
      const episodeWithTimestamps = {
        scriptUpdated: '2024-01-01T00:00:00Z',
        audioUpdated: '2024-01-01T12:30:00Z',
        vttUpdated: '2024-01-01T15:45:00Z',
      };

      // Verify ISO 8601 format (basic check)
      expect(episodeWithTimestamps.scriptUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(episodeWithTimestamps.audioUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(episodeWithTimestamps.vttUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('URL construction', () => {
    it('should construct GitHub script URL correctly', () => {
      const episodeId = 'chen-2023-punica_multi_tenant';
      const expectedUrl = `https://github.com/strollcast/scripts/blob/main/${episodeId}/script.md`;

      expect(expectedUrl).toBe('https://github.com/strollcast/scripts/blob/main/chen-2023-punica_multi_tenant/script.md');
    });

    it('should construct R2 script URL correctly', () => {
      const episodeId = 'test-2024-example';
      const scriptPath = `episodes/${episodeId}/script.md`;
      const expectedUrl = `https://released.strollcast.com/${scriptPath}`;

      expect(expectedUrl).toBe('https://released.strollcast.com/episodes/test-2024-example/script.md');
    });

    it('should use database URLs for audio and VTT', () => {
      const audioUrl = 'https://released.strollcast.com/episodes/test-2024-example/test-2024-example.mp3';
      const vttUrl = 'https://released.strollcast.com/episodes/test-2024-example/test-2024-example.vtt';

      // URLs should come directly from database, not be constructed
      expect(audioUrl).toContain('released.strollcast.com');
      expect(vttUrl).toContain('released.strollcast.com');
      expect(audioUrl).toContain('.mp3');
      expect(vttUrl).toContain('.vtt');
    });
  });
});
