import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type GitHubConfig,
  checkScriptExists,
  pushScript,
  fetchScript,
  getScriptMetadata,
} from './github';

// Mock fetch using vitest's stubGlobal
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const testConfig: GitHubConfig = {
  token: 'test-token',
  owner: 'strollcast',
  repo: 'scripts',
};

describe('GitHub API Module', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('checkScriptExists', () => {
    it('returns true when script exists (200 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ name: 'script.md', size: 1000 }),
      });

      const exists = await checkScriptExists('vaswani-2017-attention_is_all_you', testConfig);

      expect(exists).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/strollcast/scripts/contents/vaswani-2017-attention_is_all_you/script.md',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        })
      );
    });

    it('returns false when script does not exist (404 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 404,
        text: async () => 'Not Found',
      });

      const exists = await checkScriptExists('nonexistent-2024-test', testConfig);

      expect(exists).toBe(false);
    });

    it('returns false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const exists = await checkScriptExists('vaswani-2017-test', testConfig);

      expect(exists).toBe(false);
    });

    it('returns false on non-200/404 status codes', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const exists = await checkScriptExists('test-2024-episode', testConfig);

      expect(exists).toBe(false);
    });
  });

  describe('pushScript', () => {
    it('successfully creates a new script file', async () => {
      const scriptContent = '**ERIC:** Hello!\n\n**MAYA:** World!';
      mockFetch.mockResolvedValueOnce({
        status: 201,
        json: async () => ({
          content: {
            name: 'script.md',
            path: 'vaswani-2017-attention/script.md',
            sha: 'abc123',
            size: 100,
          },
          commit: {
            sha: 'commit-sha-123',
            message: 'Add script for vaswani-2017-attention',
          },
        }),
      });

      const commitSha = await pushScript('vaswani-2017-attention', scriptContent, testConfig);

      expect(commitSha).toBe('commit-sha-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/strollcast/scripts/contents/vaswani-2017-attention/script.md',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('Add script for vaswani-2017-attention'),
        })
      );
    });

    it('throws error when file already exists (422 response)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 422,
        text: async () => 'Unprocessable Entity',
      });

      await expect(
        pushScript('existing-2024-episode', 'content', testConfig)
      ).rejects.toThrow('Script already exists in GitHub for existing-2024-episode');
    });

    it('throws error on GitHub API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(
        pushScript('test-2024-episode', 'content', testConfig)
      ).rejects.toThrow('GitHub API error (500)');
    });

    it('throws error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(
        pushScript('test-2024-episode', 'content', testConfig)
      ).rejects.toThrow('Network timeout');
    });

    it('encodes content as base64', async () => {
      const scriptContent = 'Test content with special chars: é, ñ, 中文';
      mockFetch.mockResolvedValueOnce({
        status: 201,
        json: async () => ({
          content: { name: 'script.md', path: 'test/script.md', sha: 'abc', size: 100 },
          commit: { sha: 'commit-sha', message: 'Add script' },
        }),
      });

      await pushScript('test-2024-special', scriptContent, testConfig);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.content).toBeDefined();
      // Verify it's base64 encoded
      expect(callBody.content).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  describe('fetchScript', () => {
    it('returns script content when it exists', async () => {
      const scriptContent = '**ERIC:** Test content\n\n**MAYA:** More content';
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: async () => scriptContent,
      });

      const content = await fetchScript('vaswani-2017-attention', testConfig);

      expect(content).toBe(scriptContent);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/strollcast/scripts/main/vaswani-2017-attention/script.md',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('returns null when script does not exist (404)', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 404,
        text: async () => 'Not Found',
      });

      const content = await fetchScript('nonexistent-2024-test', testConfig);

      expect(content).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const content = await fetchScript('test-2024-episode', testConfig);

      expect(content).toBeNull();
    });

    it('returns null on non-200/404 status codes', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        text: async () => 'Server error',
      });

      const content = await fetchScript('test-2024-episode', testConfig);

      expect(content).toBeNull();
    });
  });

  describe('getScriptMetadata', () => {
    it('returns metadata when script exists', async () => {
      // Mock file contents response
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          name: 'script.md',
          path: 'vaswani-2017-attention/script.md',
          sha: 'abc123',
          size: 5000,
        }),
      });

      // Mock commits response
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => [
          {
            commit: {
              author: {
                date: '2024-01-15T10:30:00Z',
              },
            },
          },
        ],
      });

      const metadata = await getScriptMetadata('vaswani-2017-attention', testConfig);

      expect(metadata).toEqual({
        size: 5000,
        updated: '2024-01-15T10:30:00Z',
      });
    });

    it('returns null when script does not exist', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 404,
        text: async () => 'Not Found',
      });

      const metadata = await getScriptMetadata('nonexistent-2024-test', testConfig);

      expect(metadata).toBeNull();
    });

    it('uses fallback date when commits API fails', async () => {
      // Mock file contents response
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          name: 'script.md',
          size: 3000,
        }),
      });

      // Mock commits response failure
      mockFetch.mockResolvedValueOnce({
        status: 500,
        text: async () => 'Server error',
      });

      const metadata = await getScriptMetadata('test-2024-episode', testConfig);

      expect(metadata).not.toBeNull();
      expect(metadata?.size).toBe(3000);
      expect(metadata?.updated).toBeDefined();
      // Should be recent ISO date
      expect(new Date(metadata!.updated).getFullYear()).toBeGreaterThanOrEqual(2024);
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const metadata = await getScriptMetadata('test-2024-episode', testConfig);

      expect(metadata).toBeNull();
    });
  });
});
