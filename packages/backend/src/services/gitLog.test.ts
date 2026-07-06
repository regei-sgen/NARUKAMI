import { describe, it, expect } from 'vitest';
import { parseCommits, commitsToText } from './gitLog';

const FS = '\x1f';

// Build a chunk shaped like `git log -z --shortstat --pretty=format:%h%x1f%s%x1f%b`.
function block(hash: string, subject: string, body: string, shortstat?: string): string {
  const pretty = `${hash}${FS}${subject}${FS}${body}`;
  return shortstat ? `${pretty}\n${shortstat}\n` : pretty;
}

describe('parseCommits', () => {
  it('parses hash, subject, multi-line body, and file count', () => {
    const raw =
      block(
        'abc123',
        'Add feature X',
        'Detailed body line1\nline2',
        ' 3 files changed, 10 insertions(+), 2 deletions(-)',
      ) + '\0';
    const [c] = parseCommits(raw);
    expect(c).toEqual({
      hash: 'abc123',
      subject: 'Add feature X',
      body: 'Detailed body line1\nline2',
      filesChanged: 3,
    });
  });

  it('parses multiple NUL-separated commits', () => {
    const raw =
      block('a1', 'First', 'b1', ' 2 files changed, 5 insertions(+)') +
      '\0' +
      block('b2', 'Second', '', ' 1 file changed, 1 insertion(+)') +
      '\0';
    const cs = parseCommits(raw);
    expect(cs.map((c) => c.subject)).toEqual(['First', 'Second']);
    expect(cs[0].filesChanged).toBe(2);
    expect(cs[1].filesChanged).toBe(1);
    expect(cs[1].body).toBe('');
  });

  it('handles a commit with no shortstat (filesChanged null)', () => {
    const raw = block('c3', 'Docs only', 'tweak wording') + '\0';
    const [c] = parseCommits(raw);
    expect(c.filesChanged).toBeNull();
    expect(c.body).toBe('tweak wording');
  });

  it('does not let the shortstat line leak into the body', () => {
    const raw = block('d4', 'Sub', 'real body', ' 9 files changed, 1 deletion(-)') + '\0';
    const [c] = parseCommits(raw);
    expect(c.body).toBe('real body');
    expect(c.body).not.toContain('files changed');
  });

  it('returns [] for empty input', () => {
    expect(parseCommits('')).toEqual([]);
    expect(parseCommits('\0\0')).toEqual([]);
  });
});

describe('commitsToText', () => {
  it('renders one bulleted line per commit with body indented', () => {
    const text = commitsToText([
      { hash: 'a', subject: 'Add X', body: 'why: because', filesChanged: 2 },
      { hash: 'b', subject: 'Fix Y', body: '', filesChanged: null },
    ]);
    expect(text).toContain('- Add X [2 file(s)]');
    expect(text).toContain('    why: because');
    expect(text).toContain('- Fix Y');
  });
});
