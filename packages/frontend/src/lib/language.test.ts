import { describe, expect, it } from 'vitest';
import { LANG_BY_EXT, languageFor } from './language';

describe('languageFor', () => {
  it('maps common extensions to Monaco languages', () => {
    expect(languageFor('src/App.tsx')).toBe('typescript');
    expect(languageFor('a/b/main.py')).toBe('python');
    expect(languageFor('styles.css')).toBe('css');
    expect(languageFor('data.json')).toBe('json');
    expect(languageFor('script.ps1')).toBe('powershell');
  });

  it('uses only the basename, ignoring the directory path', () => {
    expect(languageFor('deep/nested/dir/index.ts')).toBe('typescript');
    // a dot in a directory name must not be read as the file extension
    expect(languageFor('some.dir/Makefile.txt')).toBe('plaintext');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageFor('README.MD')).toBe('markdown');
    expect(languageFor('Component.TSX')).toBe('typescript');
  });

  it('special-cases Dockerfiles (with and without a suffix)', () => {
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('docker/Dockerfile.prod')).toBe('dockerfile');
  });

  it('treats every .env variant as ini', () => {
    expect(languageFor('.env')).toBe('ini');
    expect(languageFor('config/.env.local')).toBe('ini');
    expect(languageFor('.env.production')).toBe('ini');
  });

  it('renders ignore files as plaintext, not by a bogus extension', () => {
    expect(languageFor('.gitignore')).toBe('plaintext');
    expect(languageFor('.dockerignore')).toBe('plaintext');
    expect(languageFor('.npmignore')).toBe('plaintext');
  });

  it('falls back to plaintext for unknown or extension-less files', () => {
    expect(languageFor('LICENSE')).toBe('plaintext');
    expect(languageFor('notes.xyz')).toBe('plaintext');
    expect(languageFor('')).toBe('plaintext');
  });

  it('classifies a dotfile with no extension as plaintext', () => {
    // ".bashrc" → base includes a dot, ext = "bashrc" (unknown) → plaintext
    expect(languageFor('.bashrc')).toBe('plaintext');
  });

  it('keeps the LANG_BY_EXT table and languageFor in agreement', () => {
    for (const [ext, lang] of Object.entries(LANG_BY_EXT)) {
      expect(languageFor(`file.${ext}`)).toBe(lang);
    }
  });
});
