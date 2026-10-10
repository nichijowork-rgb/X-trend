const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

export function stripExcluded(text, excludeTerms = []) {
  let t = norm(text);
  for (const term of excludeTerms) {
    const x = norm(term).trim();
    if (x) t = t.split(x).join(' ');
  }
  return t;
}

function hits(text, words) {
  return words.some((w) => {
    const x = norm(w).trim();
    return x && text.includes(x);
  });
}

export function containsExcluded(text, excludeTerms = []) {
  const t = norm(text);
  return excludeTerms.some((w) => {
    const x = norm(w).trim();
    return x && t.includes(x);
  });
}

// 除外ワードを取り除いた本文でキーワード判定。どれにも当たらなければヒントを使う。
export function classify({ text, hint = null }, settings) {
  const stripped = stripExcluded(text, settings.excludeTerms);
  const night = hits(stripped, settings.keywords.nightlife);
  const general = hits(stripped, settings.keywords.general);
  let genre = 'unknown';
  if (night) genre = 'nightlife';
  else if (general) genre = 'general';
  else if (hint === 'nightlife' || hint === 'general') genre = hint;
  const excluded = containsExcluded(text, settings.excludeTerms) && !night && !general;
  return { genre, excluded };
}

export function matchedKeywordsOf(text, settings) {
  const stripped = stripExcluded(text, settings.excludeTerms);
  return [...settings.keywords.nightlife, ...settings.keywords.general].filter((w) => {
    const x = norm(w).trim();
    return x && stripped.includes(x);
  });
}
