import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Bounds so a huge day / repo can't blow up the response.
const MAX_COMMITS = 200;
const MAX_BODY_CHARS = 4000;
const GIT_TIMEOUT_MS = 10_000;

export interface Commit {
  hash: string; // short hash
  subject: string; // first line
  body: string; // remaining message (trimmed)
  filesChanged: number | null;
}

// Field separator (US) between hash/subject/body; records are NUL-terminated by
// `git log -z`, so subjects/bodies can contain newlines without breaking parsing.
const FS = '\x1f';

/**
 * Parse the output of:
 *   git log --no-merges -z --shortstat --pretty=format:%h%x1f%s%x1f%b
 * Pure (no I/O) so it can be unit-tested against captured git output.
 */
export function parseCommits(raw: string): Commit[] {
  const blocks = raw.split('\0').filter((b) => b.trim() !== '');
  const commits: Commit[] = [];

  for (const block of blocks) {
    // The --shortstat line (" N files changed, ...") is appended after the
    // pretty body. Pull the file count out, then remove that line so it doesn't
    // pollute the commit body.
    const statMatch = block.match(/(\d+) files? changed/);
    const filesChanged = statMatch ? Number(statMatch[1]) : null;
    const meta = block.replace(/\n?[ \t]*\d+ files? changed[^\n]*\n?/, '');

    const parts = meta.split(FS);
    const hash = (parts[0] ?? '').trim();
    if (!hash) continue;
    const subject = (parts[1] ?? '').trim();
    const body = parts.slice(2).join(FS).trim().slice(0, MAX_BODY_CHARS);

    commits.push({ hash, subject, body, filesChanged });
    if (commits.length >= MAX_COMMITS) break;
  }

  return commits;
}

/**
 * Commits authored in [start, end) in the git repo at `projectPath`. Returns []
 * if the path isn't a git repo, git is missing, or anything fails — commits are
 * an enrichment, never fatal to compiling an EOD.
 */
export async function gitCommitsForDay(
  projectPath: string,
  start: Date,
  end: Date,
): Promise<Commit[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        projectPath,
        'log',
        '--no-merges',
        '-z',
        '--shortstat',
        `--since=${start.toISOString()}`,
        `--until=${end.toISOString()}`,
        `--pretty=format:%h${FS}%s${FS}%b`,
      ],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseCommits(stdout);
  } catch {
    return [];
  }
}

/** One-line-per-commit text for feeding the AI day summary. */
export function commitsToText(commits: Commit[]): string {
  return commits
    .map((c) => {
      const files = c.filesChanged != null ? ` [${c.filesChanged} file(s)]` : '';
      const body = c.body ? `\n    ${c.body.replace(/\n/g, '\n    ')}` : '';
      return `- ${c.subject}${files}${body}`;
    })
    .join('\n');
}
