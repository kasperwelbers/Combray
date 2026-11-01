import { describe, expect, it } from 'vitest';

import { parseRoute } from '../src/route';

describe('parseRoute', () => {
  it('finds the project and the participant id or reset token in the fragment', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/willow/', '')).toEqual({ kind: 'project', projectId: 'willow' });
    expect(parseRoute('/willow', '#id=P1234')).toEqual({
      kind: 'project',
      projectId: 'willow',
      participantId: 'P1234',
    });
    const token = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    expect(parseRoute('/willow/', `#reset=${token}`)).toEqual({
      kind: 'project',
      projectId: 'willow',
      resetToken: token,
    });
  });

  it('finds the questions and answers page', () => {
    expect(parseRoute('/willow/faq', '')).toEqual({ kind: 'project', projectId: 'willow', page: 'faq' });
    expect(parseRoute('/willow/faq/', '#id=P1')).toEqual({
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
    expect(parseRoute('/Willow/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/willow/extra', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/willow/', '#id=<script>')).toEqual({ kind: 'project', projectId: 'willow' });
    expect(parseRoute('/willow/', '#reset=short')).toEqual({ kind: 'project', projectId: 'willow' });
  });
});
