/**
 * Unit tests — client/src/utils/formatters.js (pure functions: no DOM, no network).
 */
import {
  toTitleCase,
  truncateText,
  cleanValue,
  getCategoryColor,
  formatNumber,
  formatTimeAgo,
} from '../../client/src/utils/formatters.js';

describe('toTitleCase', () => {
  it('title-cases words and treats underscores/hyphens as spaces', () => {
    expect(toTitleCase('pick_and-place')).toBe('Pick And Place');
    expect(toTitleCase('HMI')).toBe('Hmi');
  });
  it('returns the placeholder for empty input', () => {
    expect(toTitleCase('')).toBe('---');
    expect(toTitleCase(null)).toBe('---');
  });
});

describe('truncateText', () => {
  it('leaves short text alone and truncates long text with an ellipsis', () => {
    expect(truncateText('short')).toBe('short');
    expect(truncateText('abcdefghij', 4)).toBe('abcd...');
    expect(truncateText(undefined)).toBe('---');
  });
});

describe('cleanValue', () => {
  it('maps null, undefined, empty string and "None" to the placeholder', () => {
    for (const v of [null, undefined, '', 'None']) expect(cleanValue(v)).toBe('---');
  });
  it('passes real values through untouched, including 0 and false', () => {
    expect(cleanValue('N Drive')).toBe('N Drive');
    expect(cleanValue(0)).toBe(0);
    expect(cleanValue(false)).toBe(false);
  });
});

describe('getCategoryColor', () => {
  it('matches keywords case-insensitively and falls back to slate', () => {
    expect(getCategoryColor('SDC Standard')).toBe('blue');
    expect(getCategoryColor('Job Custom')).toBe('amber');
    expect(getCategoryColor('Archive 2019')).toBe('rose');
    expect(getCategoryColor('conveyor')).toBe('slate');
    expect(getCategoryColor(null)).toBe('slate');
  });
});

describe('formatNumber', () => {
  it('coerces falsy input to 0 and formats with the locale', () => {
    expect(formatNumber(null)).toBe((0).toLocaleString());
    expect(formatNumber(1234)).toBe((1234).toLocaleString());
  });
});

describe('formatTimeAgo', () => {
  it('handles missing and invalid dates', () => {
    expect(formatTimeAgo(null)).toBe('Not available');
    expect(formatTimeAgo('not a date')).toBe('Invalid date');
  });
  it('produces relative labels for recent dates', () => {
    const now = Date.now();
    expect(formatTimeAgo(new Date(now - 5 * 1000))).toBe('Just now');
    expect(formatTimeAgo(new Date(now - 5 * 60 * 1000))).toBe('5m ago');
    expect(formatTimeAgo(new Date(now - 3 * 3600 * 1000))).toBe('3h ago');
    expect(formatTimeAgo(new Date(now - 24 * 3600 * 1000))).toBe('Yesterday');
    expect(formatTimeAgo(new Date(now - 3 * 24 * 3600 * 1000))).toBe('3d ago');
  });
});
