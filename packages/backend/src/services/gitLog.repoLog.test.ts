import { describe, expect, it } from 'vitest';
import { parseLog } from './gitLog';

const FS = '\x1f';

// Build one NUL-terminated `git log -z --shortstat` record in the changelog
// format: %aI<FS>%an<FS>%h<FS>%s<FS>%b (+ optional shortstat line).
function record(
  date: string,
  author: string,
  hash: string,
  subject: string,
  body = '',
  stat?: string,
): string {
  return `${date}${FS}${author}${FS}${hash}${FS}${subject}${FS}${body}${stat ? `\n ${stat}` : ''}\0`;
}

describe('parseLog', () => {
  it('parses date, author, hash, subject, body and shortstat file count', () => {
    const raw = record(
      '2026-07-14T08:00:00+08:00',
      'Dan',
      'abc1234',
      'feat: add the thing',
      'longer description\nsecond line',
      '3 files changed, 10 insertions(+), 2 deletions(-)',
    );
    const commits = parseLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      date: '2026-07-14T08:00:00+08:00',
      author: 'Dan',
      hash: 'abc1234',
      subject: 'feat: add the thing',
      body: 'longer description\nsecond line',
      filesChanged: 3,
    });
  });

  it('handles a record with no shortstat (filesChanged null) and no body', () => {
    const commits = parseLog(record('2026-07-13T10:00:00Z', 'Dan', 'def5678', 'chore: tidy'));
    expect(commits).toHaveLength(1);
    expect(commits[0].filesChanged).toBeNull();
    expect(commits[0].body).toBe('');
  });

  it('parses multiple NUL-separated records in order and skips empty blocks', () => {
    const raw =
      record('2026-07-14T09:00:00Z', 'A', 'aaa1111', 'newest') +
      '\0' + // stray empty block
      record('2026-07-13T09:00:00Z', 'B', 'bbb2222', 'older', '', '1 file changed, 1 insertion(+)');
    const commits = parseLog(raw);
    expect(commits.map((c) => c.hash)).toEqual(['aaa1111', 'bbb2222']);
    expect(commits[1].filesChanged).toBe(1);
  });

  it('drops a record with no hash', () => {
    expect(parseLog(`2026-07-14T09:00:00Z${FS}A${FS}${FS}subject\0`)).toHaveLength(0);
  });

  it('keeps newlines inside bodies (the -z framing protects them)', () => {
    const commits = parseLog(
      record('2026-07-14T09:00:00Z', 'A', 'ccc3333', 'multi', 'line one\nline two\n\nline four'),
    );
    expect(commits[0].body).toBe('line one\nline two\n\nline four');
  });
});
