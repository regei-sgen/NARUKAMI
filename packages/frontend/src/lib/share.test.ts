import { describe, it, expect } from 'vitest';
import { mobileUrl } from './share';

describe('mobileUrl', () => {
  it('builds the /m URL with the project id and token', () => {
    expect(mobileUrl('192.168.68.119', 4790, 'proj1', 'abc123')).toBe(
      'http://192.168.68.119:4790/m?project=proj1&token=abc123',
    );
  });

  it('url-encodes the project id and token', () => {
    expect(mobileUrl('10.0.0.5', 4000, 'a/b c', 't ok&x=1')).toBe(
      'http://10.0.0.5:4000/m?project=a%2Fb%20c&token=t%20ok%26x%3D1',
    );
  });
});
