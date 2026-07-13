import { describe, it, expect } from 'vitest';
import { themeMenuKey } from './themePickerNav';

// The ThemePicker menu ships 5 items; use that as the realistic count.
const COUNT = 5;

describe('themeMenuKey', () => {
  it('ArrowDown moves to the next item and wraps at the end', () => {
    expect(themeMenuKey('ArrowDown', 0, COUNT)).toEqual({ type: 'focus', index: 1, preventDefault: true });
    expect(themeMenuKey('ArrowDown', 2, COUNT)).toEqual({ type: 'focus', index: 3, preventDefault: true });
    // last → first
    expect(themeMenuKey('ArrowDown', COUNT - 1, COUNT)).toEqual({ type: 'focus', index: 0, preventDefault: true });
  });

  it('ArrowUp moves to the previous item and wraps at the start', () => {
    expect(themeMenuKey('ArrowUp', 3, COUNT)).toEqual({ type: 'focus', index: 2, preventDefault: true });
    // first → last
    expect(themeMenuKey('ArrowUp', 0, COUNT)).toEqual({ type: 'focus', index: COUNT - 1, preventDefault: true });
  });

  it('wraps sensibly when focus starts outside the list (current = -1)', () => {
    // ArrowDown from nowhere lands on the first item: (-1 + 1 + 5) % 5 = 0.
    expect(themeMenuKey('ArrowDown', -1, COUNT)).toEqual({ type: 'focus', index: 0, preventDefault: true });
    // ArrowUp from nowhere lands on the second-to-last: (-1 - 1 + 5) % 5 = 3.
    // (Matches the original component's modulo — worth pinning so a refactor can't drift.)
    expect(themeMenuKey('ArrowUp', -1, COUNT)).toEqual({ type: 'focus', index: COUNT - 2, preventDefault: true });
  });

  it('Home focuses the first item, End focuses the last', () => {
    expect(themeMenuKey('Home', 3, COUNT)).toEqual({ type: 'focus', index: 0, preventDefault: true });
    expect(themeMenuKey('End', 1, COUNT)).toEqual({ type: 'focus', index: COUNT - 1, preventDefault: true });
  });

  it('Escape closes and returns focus to the toggle', () => {
    expect(themeMenuKey('Escape', 2, COUNT)).toEqual({ type: 'close', returnFocus: true, preventDefault: true });
  });

  it('Tab closes WITHOUT returning focus and WITHOUT preventing default', () => {
    // Tab must reach its natural target, so preventDefault stays false.
    expect(themeMenuKey('Tab', 2, COUNT)).toEqual({ type: 'close', returnFocus: false, preventDefault: false });
  });

  it('ignores unhandled keys', () => {
    for (const key of ['a', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'PageUp']) {
      expect(themeMenuKey(key, 0, COUNT)).toEqual({ type: 'none' });
    }
  });

  it('does nothing when there are no items (guards the modulo by zero)', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) {
      expect(themeMenuKey(key, -1, 0)).toEqual({ type: 'none' });
    }
  });

  it('every focus index is in range for a single-item menu', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const action = themeMenuKey(key, 0, 1);
      expect(action.type).toBe('focus');
      if (action.type === 'focus') {
        expect(action.index).toBeGreaterThanOrEqual(0);
        expect(action.index).toBeLessThan(1);
      }
    }
  });
});
