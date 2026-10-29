// Synthetic trees for tests. No real participant data (CLAUDE.md, rule 5).
import { jsonToTree, type DirNode, type TreeNode } from '../src';
import { parseMarkup } from '../src/parse/html';

export const watchHistory = jsonToTree('watch-history.json', [
  {
    title: 'Watched How to bake madeleines',
    titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    time: '2024-03-01T09:15:00.000Z',
    subtitles: [{ name: 'Aunt Leonie Bakes', url: 'https://www.youtube.com/channel/UC0000000000' }],
  },
  {
    title: 'Watched Lime blossom tea',
    titleUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    time: '2024-03-02T18:40:00.000Z',
    subtitles: [
      { name: 'Tisane Channel', url: 'https://www.youtube.com/channel/UC1111111111' },
      { name: 'Combray Kitchen', url: 'https://www.youtube.com/channel/UC2222222222' },
    ],
  },
  { title: 'Visited a page', time: '2024-03-03T07:00:00.000Z' },
]);

export const activityHtml = parseMarkup(
  'MyActivity.html',
  `<html><body>
    <div class="outer-cell mdl-cell"><div class="content-cell">Searched for <a href="https://www.google.com/search?q=hawthorn">hawthorn</a><br>Mar 4, 2024, 10:20:30 AM CET</div></div>
    <div class="outer-cell mdl-cell"><div class="content-cell">Searched for <a href="https://www.google.com/search?q=steeple">steeple</a><br>Mar 5, 2024, 11:00:00 AM CET</div></div>
    <script>var x = 1;</script>
  </body></html>`,
);

export const takeout: DirNode = {
  kind: 'dir',
  name: 'takeout-20240310T101010Z-001.zip',
  children: [
    {
      kind: 'dir',
      name: 'Takeout',
      children: [
        {
          kind: 'dir',
          name: 'YouTube and YouTube Music',
          children: [{ kind: 'dir', name: 'history', children: [watchHistory] }],
        },
        {
          kind: 'dir',
          name: 'My Activity',
          children: [{ kind: 'dir', name: 'Search', children: [activityHtml] }],
        },
      ],
    },
  ],
};

/** An Instagram-like inbox whose folder names are usernames: must collapse in shapes. */
export const inbox: TreeNode = {
  kind: 'dir',
  name: 'inbox',
  children: ['marcel_1871', 'gilberte_1234', 'swann_5678', 'odette_4321', 'albertine_9999', 'robert_2468'].map(
    (user) => ({
      kind: 'dir' as const,
      name: user,
      children: [
        jsonToTree('message_1.json', {
          participants: [{ name: user }],
          messages: [{ sender_name: user, timestamp_ms: 1700000000000, content: `hello from ${user}` }],
        }),
      ],
    }),
  ),
};
