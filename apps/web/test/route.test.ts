import { describe, expect, it } from 'vitest';

import { parseRoute, projectPath } from '../src/route';

describe('parseRoute', () => {
  it('finds the project and the participant id or reset token in the fragment', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/p/willow/', '')).toEqual({ kind: 'project', projectId: 'willow' });
    expect(parseRoute('/p/willow', '#id=P1234')).toEqual({
      kind: 'project',
      projectId: 'willow',
      participantId: 'P1234',
    });
    const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    expect(parseRoute('/p/willow/', `#reset=${token}`)).toEqual({
      kind: 'project',
      projectId: 'willow',
      resetToken: token,
    });
  });

  it('finds the questions and answers page', () => {
    expect(parseRoute('/p/willow/faq', '')).toEqual({ kind: 'project', projectId: 'willow', page: 'faq' });
    expect(parseRoute('/p/willow/faq/', '#id=P1')).toEqual({
      kind: 'project',
      projectId: 'willow',
      page: 'faq',
      participantId: 'P1',
    });
  });

  it('finds the researcher workspace', () => {
    expect(parseRoute('/studio/', '')).toEqual({ kind: 'studio' });
    expect(parseRoute('/studio', '#id=P1')).toEqual({ kind: 'studio' });
  });

  it('ignores malformed paths, ids and tokens', () => {
    expect(parseRoute('/p/Willow/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/p/willow/extra', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/p/willow/', '#id=<script>')).toEqual({ kind: 'project', projectId: 'willow' });
    expect(parseRoute('/p/willow/', '#reset=short')).toEqual({ kind: 'project', projectId: 'willow' });
    expect(parseRoute('/p/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/studio/extra', '')).toEqual({ kind: 'home' });
  });

  it('only finds projects under /p/, so any id is free to use', () => {
    expect(parseRoute('/willow/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/p/studio/', '')).toEqual({ kind: 'project', projectId: 'studio' });
    expect(projectPath('willow')).toBe('/p/willow/');
    expect(projectPath('willow', 'faq')).toBe('/p/willow/faq');
  });
});
