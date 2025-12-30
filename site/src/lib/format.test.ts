import { describe, it, expect } from 'vitest';
import { formatRelativeDate, formatBytes, truncateTitle } from './format';

describe('formatRelativeDate', () => {
  const now = new Date('2024-12-30T12:00:00Z');

  describe('null/undefined handling', () => {
    it('returns "-" for null', () => {
      expect(formatRelativeDate(null, now)).toBe('-');
    });

    it('returns "-" for undefined', () => {
      expect(formatRelativeDate(undefined, now)).toBe('-');
    });

    it('returns "-" for invalid date string', () => {
      expect(formatRelativeDate('not a date', now)).toBe('-');
    });
  });

  describe('less than 24 hours ago', () => {
    it('returns "just now" for less than a minute ago', () => {
      const date = new Date('2024-12-30T11:59:30Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('just now');
    });

    it('returns "1 min ago" for 1 minute ago', () => {
      const date = new Date('2024-12-30T11:59:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('1 min ago');
    });

    it('returns "45 mins ago" for 45 minutes ago', () => {
      const date = new Date('2024-12-30T11:15:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('45 mins ago');
    });

    it('returns "1 hr ago" for 1 hour ago', () => {
      const date = new Date('2024-12-30T11:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('1 hr ago');
    });

    it('returns "6 hrs ago" for 6 hours ago', () => {
      const date = new Date('2024-12-30T06:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('6 hrs ago');
    });

    it('returns "23 hrs ago" for 23 hours ago', () => {
      const date = new Date('2024-12-29T13:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('23 hrs ago');
    });
  });

  describe('less than 30 days ago', () => {
    it('returns "Dec 29" for 1 day ago', () => {
      const date = new Date('2024-12-29T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('Dec 29');
    });

    it('returns "Dec 9" for 21 days ago', () => {
      const date = new Date('2024-12-09T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('Dec 9');
    });

    it('returns "Dec 1" for 29 days ago', () => {
      const date = new Date('2024-12-01T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('Dec 1');
    });
  });

  describe('30 days or older', () => {
    it('returns "2024-11-30" for 30 days ago', () => {
      const date = new Date('2024-11-30T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('2024-11-30');
    });

    it('returns "2024-01-15" for old dates', () => {
      const date = new Date('2024-01-15T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('2024-01-15');
    });

    it('returns "2023-06-01" for dates from previous year', () => {
      const date = new Date('2023-06-01T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('2023-06-01');
    });
  });

  describe('future dates', () => {
    it('returns full date for future dates', () => {
      const date = new Date('2025-01-15T12:00:00Z');
      expect(formatRelativeDate(date.toISOString(), now)).toBe('2025-01-15');
    });
  });
});

describe('formatBytes', () => {
  it('returns "-" for null', () => {
    expect(formatBytes(null)).toBe('-');
  });

  it('returns "-" for undefined', () => {
    expect(formatBytes(undefined)).toBe('-');
  });

  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes correctly', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes correctly', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5242880)).toBe('5 MB');
  });

  it('formats gigabytes correctly', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });
});

describe('truncateTitle', () => {
  it('returns short titles unchanged', () => {
    expect(truncateTitle('Short title')).toBe('Short title');
  });

  it('returns titles at exactly maxLen unchanged', () => {
    const title = 'a'.repeat(45);
    expect(truncateTitle(title)).toBe(title);
  });

  it('truncates long titles with ellipsis', () => {
    const title = 'a'.repeat(50);
    const result = truncateTitle(title);
    // 50 chars > 45, so: first 40 + "..." + last 5 = 48 chars
    expect(result).toBe('a'.repeat(40) + '...' + 'a'.repeat(5));
    expect(result.length).toBe(48);
  });

  it('respects custom maxLen', () => {
    const title = 'a'.repeat(50);
    expect(truncateTitle(title, 30)).toBe('a'.repeat(40) + '...' + 'a'.repeat(5));
  });

  it('handles real-world title', () => {
    const title = 'Efficient Memory Management for Large Language Model Serving with PagedAttention';
    const result = truncateTitle(title);
    // 80 chars > 45, so: first 40 + "..." + last 5 = 48 chars
    expect(result).toBe('Efficient Memory Management for Large La...ntion');
  });
});
