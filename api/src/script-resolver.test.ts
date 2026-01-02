import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveScriptLocation } from './script-resolver';
import * as github from './github';

// Mock the github module
vi.mock('./github', () => ({
  checkScriptExists: vi.fn(),
}));

describe('Script Resolver', () => {
  const mockR2Bucket = {
    head: vi.fn(),
  } as unknown as R2Bucket;

  const testEpisodeId = 'chen-2023-punica_multi_tenant';
  const testGithubToken = 'test-token';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveScriptLocation', () => {
    it('returns GitHub location when script exists in GitHub', async () => {
      // Mock GitHub check to return true
      vi.mocked(github.checkScriptExists).mockResolvedValue(true);

      const result = await resolveScriptLocation(
        testEpisodeId,
        testGithubToken,
        mockR2Bucket
      );

      expect(result).toEqual({
        found: true,
        url: `https://raw.githubusercontent.com/strollcast/scripts/main/${testEpisodeId}/script.md`,
        source: 'github',
      });

      // Should not check R2 if found in GitHub
      expect(mockR2Bucket.head).not.toHaveBeenCalled();
    });

    it('returns R2 location when script not in GitHub but exists in R2', async () => {
      // Mock GitHub check to return false
      vi.mocked(github.checkScriptExists).mockResolvedValue(false);

      // Mock R2 head to return an object (exists)
      vi.mocked(mockR2Bucket.head).mockResolvedValue({
        size: 1000,
        uploaded: new Date(),
      } as R2Object);

      const result = await resolveScriptLocation(
        testEpisodeId,
        testGithubToken,
        mockR2Bucket
      );

      expect(result).toEqual({
        found: true,
        url: `https://released.strollcast.com/episodes/${testEpisodeId}/script.md`,
        source: 'r2',
      });

      expect(github.checkScriptExists).toHaveBeenCalledWith(
        testEpisodeId,
        expect.objectContaining({
          token: testGithubToken,
          owner: 'strollcast',
          repo: 'scripts',
        })
      );

      expect(mockR2Bucket.head).toHaveBeenCalledWith(
        `episodes/${testEpisodeId}/script.md`
      );
    });

    it('returns not found when script exists in neither GitHub nor R2', async () => {
      // Mock GitHub check to return false
      vi.mocked(github.checkScriptExists).mockResolvedValue(false);

      // Mock R2 head to return null (doesn't exist)
      vi.mocked(mockR2Bucket.head).mockResolvedValue(null);

      const result = await resolveScriptLocation(
        testEpisodeId,
        testGithubToken,
        mockR2Bucket
      );

      expect(result).toEqual({
        found: false,
        url: null,
        source: 'none',
      });

      expect(github.checkScriptExists).toHaveBeenCalled();
      expect(mockR2Bucket.head).toHaveBeenCalled();
    });

    it('constructs correct GitHub URL with episode ID', async () => {
      vi.mocked(github.checkScriptExists).mockResolvedValue(true);

      const episodeId = 'dettmers-2023-qlora_efficient_fin';

      const result = await resolveScriptLocation(
        episodeId,
        testGithubToken,
        mockR2Bucket
      );

      expect(result.url).toBe(
        `https://raw.githubusercontent.com/strollcast/scripts/main/${episodeId}/script.md`
      );
    });

    it('constructs correct R2 URL with episode ID', async () => {
      vi.mocked(github.checkScriptExists).mockResolvedValue(false);
      vi.mocked(mockR2Bucket.head).mockResolvedValue({
        size: 500,
        uploaded: new Date(),
      } as R2Object);

      const episodeId = 'qiu-2025-gated_attention_for';

      const result = await resolveScriptLocation(
        episodeId,
        testGithubToken,
        mockR2Bucket
      );

      expect(result.url).toBe(
        `https://released.strollcast.com/episodes/${episodeId}/script.md`
      );
    });

    it('handles GitHub check errors gracefully', async () => {
      // Mock GitHub check to throw error
      vi.mocked(github.checkScriptExists).mockRejectedValue(
        new Error('GitHub API error')
      );

      await expect(
        resolveScriptLocation(testEpisodeId, testGithubToken, mockR2Bucket)
      ).rejects.toThrow('GitHub API error');
    });

    it('handles R2 errors gracefully', async () => {
      vi.mocked(github.checkScriptExists).mockResolvedValue(false);

      // Mock R2 head to throw error
      vi.mocked(mockR2Bucket.head).mockRejectedValue(new Error('R2 error'));

      await expect(
        resolveScriptLocation(testEpisodeId, testGithubToken, mockR2Bucket)
      ).rejects.toThrow('R2 error');
    });
  });
});
