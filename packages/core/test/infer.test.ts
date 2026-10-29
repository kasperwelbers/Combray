import { describe, expect, it } from 'vitest';

import { inferType } from '../src';
import cases from './infer-cases.json';

describe('inferType', () => {
  it.each(cases)('$raw is $type', ({ raw, type }) => {
    expect(inferType(raw)).toBe(type);
  });
});
