/**
 * Formats a date as a relative time string.
 * - Less than 24 hours: "6 hrs ago", "45 mins ago"
 * - Less than a month: "Dec 9"
 * - Otherwise: "2024-12-09"
 */
export function formatRelativeDate(
  dateString: string | null | undefined,
  now: Date = new Date()
): string {
  if (!dateString) return '-';

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '-';

  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Less than 24 hours: relative time
  if (diffMs >= 0 && diffHours < 24) {
    if (diffMins < 1) {
      return 'just now';
    } else if (diffMins < 60) {
      return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`;
    } else {
      return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
    }
  }

  // Less than 30 days: "Dec 9"
  if (diffDays >= 0 && diffDays < 30) {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }

  // Otherwise: "2024-12-09"
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats bytes into human-readable size.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Truncates a title with ellipsis in the middle.
 * Shows first 50 chars + "..." + last 10 chars if over maxLen.
 */
export function truncateTitle(title: string, maxLen: number = 60): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, 50) + '...' + title.slice(-10);
}
