import { describe, expect, it } from 'vitest';

import {
  defaultLabel,
  deriveTables,
  extractShape,
  freeName,
  isName,
  jsonToTree,
  keepNames,
  nameGroup,
  nameKind,
  nameProblem,
  renameNode,
  setDecision,
  setName,
  toName,
  typingName,
} from '../src';
import { at, nodeAt, rebuild, treeOf } from './trees';

const tweets = jsonToTree('tweets.json', {
  user: { name: 'Leonie' },
  tweets: [{ text: 'Madeleines', author: 'L', comments: [{ author: 'M', text: 'Lovely' }] }],
  posts: [{ text: 'Rain', comments: [{ author: 'S', text: 'Brr' }] }],
});
const shape = extractShape(tweets);

describe('names', () => {
  it('are lowercase words joined by underscores', () => {
    expect(toName('Video title')).toBe('video_title');
    expect(toName('titleText')).toBe('title_text');
    expect(toName('URLList')).toBe('url_list');
    expect(toName('Café  crème!')).toBe('cafe_creme');
    expect(toName('2fa codes')).toBe('x2fa_codes');
    expect(toName('…')).toBe('');
    expect(typingName('video ')).toBe('video_');
    expect(isName('video_title')).toBe(true);
    expect(isName('Video')).toBe(false);
    expect(isName('video_')).toBe(false);
    expect(defaultLabel('watch_history')).toBe('Watch history');
    expect(freeName('title', new Set(['title', 'title_2']))).toBe('title_3');
  });
});

describe('naming parts of a tree', () => {
  it('names tables on the node they are named after, and fields on their leaves', () => {
    const tree = treeOf(shape);
    expect(nameKind(tree, at(tree, 'tweets'))).toBe('table');
    expect(nameKind(tree, at(tree, 'tweets', '[*]'))).toBeUndefined();
    expect(nameKind(tree, at(tree, 'tweets', '[*]', 'text'))).toBe('field');
    expect(nameKind(tree, at(tree, 'user'))).toBeUndefined();
  });

  it('lets tables share a name only where they are nested in the same table', () => {
    let tree = treeOf(shape);
    tree = setName(tree, [at(tree, 'tweets', '[*]', 'comments')], 'replies');
    expect(nameProblem(tree, at(tree, 'posts', '[*]', 'comments'), 'replies')).toBe('replies is already used in the tweets table');
    expect(nameProblem(tree, at(tree, 'posts'), 'tweets')).toBeUndefined();
    expect(nameProblem(tree, at(tree, 'posts'), 'Tweets')).toMatch(/lowercase/);
    // A field may not be called like a table nested next to it.
    expect(nameProblem(tree, at(tree, 'tweets', '[*]', 'text'), 'replies')).toBe('a table in this table is called replies');
    expect(nameProblem(tree, at(tree, 'user'), 'user')).toBe('only tables and fields have names');
  });

  it('renames a name for all that share it, with the filters that use it, or splits one off', () => {
    let tree = treeOf(shape);
    tree = setName(tree, [at(tree, 'tweets', '[*]', 'text'), at(tree, 'tweets', '[*]', 'author')], 'body');
    tree = rebuild(tree, shape);
    nodeAt(tree, 'tweets', '[*]').filter = [{ column: 'body', test: { empty: true }, not: true }];
    expect(nameGroup(tree, at(tree, 'tweets', '[*]', 'author'))).toHaveLength(2);

    const all = renameNode(tree, at(tree, 'tweets', '[*]', 'text'), 'message');
    expect(all).toMatchObject({ kind: 'field', from: 'body', table: 'tweets' });
    expect(nodeAt(all.tree, 'tweets', '[*]', 'author').named).toBe('message');
    expect(nodeAt(all.tree, 'tweets', '[*]').filter).toEqual([{ column: 'message', test: { empty: true }, not: true }]);

    const one = renameNode(tree, at(tree, 'tweets', '[*]', 'author'), 'by', { all: false });
    expect(nodeAt(one.tree, 'tweets', '[*]', 'text').named).toBe('body');
    expect(nodeAt(one.tree, 'tweets', '[*]').filter![0]!.column).toBe('body');
  });

  it('keeps the names of what is shown or donated, and of their tables', () => {
    let tree = treeOf(shape);
    tree = setDecision(tree, at(tree, 'tweets', '[*]', 'comments', '[*]', 'text'), 'donate');
    const kept = keepNames(tree);
    expect(nodeAt(kept, 'tweets', '[*]', 'comments', '[*]', 'text').named).toBe('text');
    // Keys sort, so the comments of posts came first and are `comments`.
    expect(nodeAt(kept, 'tweets', '[*]', 'comments').named).toBe('comments_2');
    expect(nodeAt(kept, 'tweets').named).toBe('tweets');
    // Nothing that was not real is made real.
    expect(nodeAt(kept, 'posts').named).toBeUndefined();
    // So a name another part gets later does not move it.
    const withoutPosts = extractShape(jsonToTree('tweets.json', { tweets: [{ text: 'x', comments: [{ author: 'M', text: 'y' }] }] }));
    expect(deriveTables(rebuild(tree, withoutPosts)).map((t) => t.id)).toEqual(['tweets', 'comments']);
    expect(deriveTables(rebuild(kept, withoutPosts)).map((t) => t.id)).toEqual(['tweets', 'comments_2']);
  });
});
