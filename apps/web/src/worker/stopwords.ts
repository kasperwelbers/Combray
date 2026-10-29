/** Very common words left out of word counts. English and Dutch, the first-class languages. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be by for from how i in is it me my of on or so that the this to was what when where who why with you your ' +
    'de het een en van in is op te dat die voor met zijn niet aan er maar om ook als dan bij of wat hoe waar wie je jij mijn ik naar'
  ).split(' '),
);
