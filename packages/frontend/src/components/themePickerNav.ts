// Pure keyboard-navigation logic for the ThemePicker menu, split out of the
// component so it can be unit-tested without a DOM (this package's vitest runs in
// the node env with no jsdom — see vitest.config.ts). The component owns the DOM
// side effects (focus(), setOpen); this decides *what* should happen for a key.

export type MenuKeyAction =
  // Move focus to the item at `index`.
  | { type: 'focus'; index: number; preventDefault: true }
  // Close the menu. `returnFocus` sends focus back to the toggle (Escape) vs.
  // leaving it to move naturally (Tab, which must NOT preventDefault).
  | { type: 'close'; returnFocus: boolean; preventDefault: boolean }
  // Key the menu doesn't handle — let it fall through untouched.
  | { type: 'none' };

/**
 * ARIA menu keyboard pattern, as a pure reducer.
 *
 * @param key     the KeyboardEvent.key value.
 * @param current index of the currently-focused item, or -1 if focus is outside
 *                the item list (Arrow keys still wrap sensibly from -1).
 * @param count   number of menu items.
 */
export function themeMenuKey(key: string, current: number, count: number): MenuKeyAction {
  if (count <= 0) return { type: 'none' };
  switch (key) {
    case 'ArrowDown':
      return { type: 'focus', index: (current + 1 + count) % count, preventDefault: true };
    case 'ArrowUp':
      return { type: 'focus', index: (current - 1 + count) % count, preventDefault: true };
    case 'Home':
      return { type: 'focus', index: 0, preventDefault: true };
    case 'End':
      return { type: 'focus', index: count - 1, preventDefault: true };
    case 'Escape':
      return { type: 'close', returnFocus: true, preventDefault: true };
    case 'Tab':
      // Leave the menu by keyboard: close it but let Tab reach its real target.
      return { type: 'close', returnFocus: false, preventDefault: false };
    default:
      return { type: 'none' };
  }
}
