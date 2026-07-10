/**
 * Tempered Glass v2 iconography — drawn, never typed. No emoji anywhere.
 * One inline sprite (16-grid, 1.5px stroke, round caps, currentColor, em-sized),
 * referenced via <Ic name="…"/>. The spark is the official Claude sunburst.
 */
import React from 'react';

export type IconName =
  | 'shell'
  | 'shield'
  | 'spark'
  | 'play'
  | 'stop'
  | 'check'
  | 'warn'
  | 'err'
  | 'info'
  | 'search'
  | 'refresh'
  | 'branch'
  | 'bolt'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'hex'
  | 'grid'
  | 'eye'
  | 'pen'
  | 'plus'
  | 'dock'
  | 'external'
  | 'chevron';

/** Mount once at the app root; symbols are then addressable document-wide. */
export function IconDefs() {
  return (
    <svg style={{ display: 'none' }} aria-hidden="true">
      <symbol id="i-shell" viewBox="0 0 16 16">
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
        <path d="M4.6 6l2.2 2-2.2 2M8.8 10.2h2.6" />
      </symbol>
      <symbol id="i-shield" viewBox="0 0 16 16">
        <path d="M8 1.8l5.2 1.9v3.7c0 3.3-2.2 5.7-5.2 6.8-3-1.1-5.2-3.5-5.2-6.8V3.7z" />
      </symbol>
      <symbol id="i-spark" viewBox="0 0 16 16">
        <path d="M9.6 8h4.8M9.4 7.2l3.1-1.8M8.8 6.6l2.5-4.3M8 6.4V2.6M7.2 6.6L4.9 2.6M6.6 7.2L3.7 5.5M6.4 8H1.5M6.6 8.8l-3.4 2M7.2 9.4l-2.3 4.1M8 9.6v3.6M8.8 9.4l2.2 3.8M9.4 8.8l2.9 1.7" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 16 16">
        <path d="M5.2 3.4v9.2L13 8z" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-stop" viewBox="0 0 16 16">
        <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 16 16">
        <path d="M3 8.6l3.2 3L13 4.6" />
      </symbol>
      <symbol id="i-warn" viewBox="0 0 16 16">
        <path d="M8 2.4l6.6 10.8H1.4z" />
        <path d="M8 6.8v2.6M8 11.6v.1" />
      </symbol>
      <symbol id="i-err" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" />
      </symbol>
      <symbol id="i-info" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.4v3.4M8 4.9v.1" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16">
        <circle cx="7" cy="7" r="4.4" />
        <path d="M10.4 10.4L14 14" />
      </symbol>
      <symbol id="i-refresh" viewBox="0 0 16 16">
        <path d="M13.4 8A5.4 5.4 0 1 1 11.6 4.2" />
        <path d="M13.6 1.8v2.8h-2.8" />
      </symbol>
      <symbol id="i-external" viewBox="0 0 16 16">
        <path d="M12.6 8.7v4.2a1 1 0 0 1-1 1H3.1a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1h4.2" />
        <path d="M9.8 2.2h4v4" />
        <path d="M13.6 2.4 7.9 8.1" />
      </symbol>
      <symbol id="i-chevron" viewBox="0 0 16 16">
        <path d="m4 6 4 4 4-4" />
      </symbol>
      <symbol id="i-branch" viewBox="0 0 16 16">
        <circle cx="4.5" cy="3.6" r="1.7" />
        <circle cx="4.5" cy="12.4" r="1.7" />
        <circle cx="11.5" cy="5.4" r="1.7" />
        <path d="M4.5 5.3v5.4M11.5 7.1c0 2.6-2.8 3.1-5.2 3.3" />
      </symbol>
      <symbol id="i-bolt" viewBox="0 0 16 16">
        <path d="M8.9 1.2L3.2 9h3.4l-.7 5.8L12.8 7H9.4z" fill="currentColor" stroke="none" />
      </symbol>
      <symbol id="i-folder" viewBox="0 0 16 16">
        <path d="M1.8 4.2c0-.7.6-1.3 1.3-1.3h2.8l1.6 1.7h5.4c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z" />
      </symbol>
      <symbol id="i-folder-open" viewBox="0 0 16 16">
        <path d="M1.8 11.6V4.2c0-.7.6-1.3 1.3-1.3h2.8l1.6 1.7h4.8c.7 0 1.3.6 1.3 1.3v.8" />
        <path d="M3.5 7.1h11l-1.7 5.1c-.2.5-.7.9-1.2.9H1.8z" />
      </symbol>
      <symbol id="i-file" viewBox="0 0 16 16">
        <path d="M4 1.8h5.4l3.4 3.4v9H4z" />
        <path d="M9.2 1.8v3.6h3.6" />
      </symbol>
      <symbol id="i-hex" viewBox="0 0 16 16">
        <path d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
      </symbol>
      <symbol id="i-grid" viewBox="0 0 16 16">
        <rect x="2.2" y="2.2" width="4.9" height="4.9" rx="1" />
        <rect x="8.9" y="2.2" width="4.9" height="4.9" rx="1" />
        <rect x="2.2" y="8.9" width="4.9" height="4.9" rx="1" />
        <rect x="8.9" y="8.9" width="4.9" height="4.9" rx="1" />
      </symbol>
      <symbol id="i-eye" viewBox="0 0 16 16">
        <path d="M1.4 8S3.9 3.8 8 3.8 14.6 8 14.6 8 12.1 12.2 8 12.2 1.4 8 1.4 8z" />
        <circle cx="8" cy="8" r="2.1" />
      </symbol>
      <symbol id="i-pen" viewBox="0 0 16 16">
        <path d="M2.8 13.2l.7-2.9 7.6-7.6 2.2 2.2-7.6 7.6z" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 16 16">
        <path d="M8 2.8v10.4M2.8 8h10.4" />
      </symbol>
      <symbol id="i-dock" viewBox="0 0 16 16">
        <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
        <path d="M9.6 2.6v10.8" />
      </symbol>
    </svg>
  );
}

/** Inline icon. Rides the surrounding font-size (1em) unless `size` is given. */
export function Ic({
  name,
  size,
  className,
  style,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const s: React.CSSProperties | undefined = size
    ? { width: size, height: size, ...style }
    : style;
  return (
    <svg className={className ? `ic ${className}` : 'ic'} style={s} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
