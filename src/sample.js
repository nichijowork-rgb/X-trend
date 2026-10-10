const H = 3600000;

// [handle, 本文, 何時間前, likes, views, reposts, genreHint, 補足(topic|postId|metrics)]
const N = (handle, text, ago, likes, views, reposts, extra = {}) => ({ handle, text, ago, likes, views, reposts, hint: 'nightlife', ...extra });
const G = (handle, text, ago, likes, views, reposts, topic, extra = {}) => ({ handle, text, ago, likes, views, reposts, hint: 'general', topic, ...extra });

const T1 = '【サンプル】架空の新作ゲーム「ダミークエスト」';
const T2 = '【サンプル】架空の猛暑ニュース';
const T3 = '【サンプル】架空のAIガジェット発表';

const ROWS = [
  N('sample_host_taro', '【サンプル】架空のホストクラブ「クラブ・ダミー」で初回の流れを聞いてきた話。全部フィクションです #サンプル初回体験談', 3, 1250, 48000, 210),
  N('sample_host_jiro', '【サンプル】これは架空の投稿です。ホストの接客で大事なのは聞き上手だという、よくある話 #サンプル接客論', 5, 830, 31000, 95),
  N('sample_cabaret_hana', '【サンプル】架空キャバ嬢の1日ルーティン。出勤前の準備だけで2時間（フィクション） #サンプル出勤前', 7, 2100, 96000, 340),
  N('sample_cabaret_mika', '【サンプル】キャバクラの指名の取り方、という架空のまとめスレッド #サンプル指名', 9, 640, 22000, 60),
  N('sample_kabuki_ken', '【サンプル】歌舞伎町の夜景を撮ってみた（架空の写真付き投稿のつもり） #サンプル歌舞伎町散歩', 11, 3400, 150000, 520),
  N('sample_kabuki_rin', '【サンプル】歌舞伎町 終電後の街の様子を実況する架空アカウント #サンプル歌舞伎町散歩', 12, 410, 15000, 38),
  N('sample_lounge_yui', '【サンプル】ラウンジ勤務の架空の1日。服装ルールの話 #サンプルラウンジ勤務', 14, 270, 9000, 21),
  N('sample_yoru_sakura', '【サンプル】夜職あるある（架空）：昼夜逆転で生活リズムが崩れる #サンプル夜職あるある', 16, 1800, 72000, 290),
  N('sample_yoru_mei', '【サンプル】夜職あるある（架空）：お酒の強さより体力が大事 #サンプル夜職あるある', 18, 990, 41000, 130),
  N('sample_host_ryu', '【サンプル】ホストクラブの料金システムを架空の例で解説。実在の店とは無関係です', 20, 560, 19000, 70),
  N('sample_host_ren', '【サンプル】ホスト業界の求人は未経験歓迎が多い、という架空の調査メモ', 22, null, null, null),
  N('sample_cabaret_aya', '【サンプル】キャバクラ面接の持ち物リスト（架空）', 26, 120, null, 8),
  N('sample_kabuki_sora', '【サンプル】歌舞伎町の新しいカフェ（架空）がオープンしたらしい', 30, null, 8800, null),
  N('sample_host_kai', '【サンプル】ホストの売れっ子を目指す架空の日記 第12話', 33, 75, 2300, 4),
  N('sample_lounge_nana', '【サンプル】ラウンジの接客マナー、新人向けの架空マニュアル', 36, 310, 11000, 25),
  N('sample_yoru_kou', '【サンプル】夜職の確定申告はどうする？ 架空の税理士アカウントより', 40, 1500, 60000, 240),
  N('sample_host_sho', '【サンプル】架空のホストクラブの周年イベント告知 #サンプル周年', 44, 90, 3000, 12),
  N('sample_cabaret_rio', '【サンプル】キャバクラのドレス選び（架空）。予算の目安 #サンプルドレス', 48, 430, 16000, 33),
  N('sample_cabaret_emi', '【サンプル】キャバ嬢のSNS運用、毎日投稿するコツ（架空） #サンプルSNS運用', 60, 700, 27000, 88),
  N('sample_host_yuto', '【サンプル】ホストのSNS運用、毎日投稿するコツ（架空） #サンプルSNS運用', 62, 520, 20000, 51),
  N('sample_kabuki_mao', '【サンプル】歌舞伎町の治安についての架空の座談会メモ', 80, 260, 9500, 17),
  N('sample_royal_fan', '【サンプル】ロイヤルホストのパフェが好き。夜勤明けに食べる（架空・業界とは無関係）', 4, 340, 12000, 20, { tag: 'other_meaning' }),
  N('sample_vtuber_host', '【サンプル】ホスト系VTuberの配信まとめ（架空）。リアルのホストクラブとは別の話です', 6, 900, 35000, 100, { tag: 'vtuber' }),
  N('sample_vtuber_cabaret', '【サンプル】キャバクラ配信をするバーチャル配信者（架空）の切り抜き', 13, 150, 5200, 9, { tag: 'vtuber' }),
  N('sample_spam_pr', '【サンプル】【拡散希望】絶対稼げる！夜職で月収300万保証（架空のやらせ風投稿）。DMください', 8, 4, 600, 1, { tag: 'staged' }),
  N('sample_spam_pr2', '【サンプル】ホストで人生逆転！誰でも100%成功（架空の低品質な煽り投稿）', 15, 2, 300, 0, { tag: 'low_quality' }),
  N('sample_dup_a', '【サンプル】重複テスト用の架空投稿。ホストの1日', 10, 100, 4000, 5, { id: '99000000000000901' }),
  N('sample_dup_a', '【サンプル】重複テスト用の架空投稿。ホストの1日（本文更新版）', 10, 140, 5200, 7, { id: '99000000000000901' }),
  N('sample_dup_b', '【サンプル】重複テスト用の架空投稿 その2。指標なしで取り込まれた例', 9, null, null, null, { id: '99000000000000902' }),
  N('sample_dup_b', '【サンプル】重複テスト用の架空投稿 その2。指標なしで取り込まれた例', 9, 33, null, null, { id: '99000000000000902' }),

  G('sample_news_a', `${T1}の発売日が発表された、という架空の話題 #サンプルダミークエスト`, 2, 5200, 240000, 900, T1),
  G('sample_news_b', `${T1}、予約開始で架空のサイトが重いらしい #サンプルダミークエスト`, 3, 3100, 130000, 410, T1),
  G('sample_news_c', `${T1}の体験版をやってみた感想（フィクション） #サンプルダミークエスト`, 5, 1900, 80000, 220, T1),
  G('sample_news_d', `${T1}のBGMが良いと架空の界隈で話題`, 8, 800, 33000, 90, T1),
  G('sample_news_e', `${T1}の攻略メモ（架空）`, 12, null, 5000, null, T1),
  G('sample_heat_a', `${T2}：今日の最高気温が架空の記録を更新 #サンプル猛暑`, 4, 7200, 380000, 1500, T2),
  G('sample_heat_b', `${T2}、熱中症対策の豆知識（架空） #サンプル猛暑`, 6, 2600, 110000, 700, T2),
  G('sample_heat_c', `${T2}で架空の電力需給ひっ迫注意報 #サンプル猛暑`, 7, 1500, 70000, 300, T2),
  G('sample_heat_d', `${T2}、夜の外出は控えめに（架空の呼びかけ）`, 9, 400, 14000, 40, T2),
  G('sample_heat_e', `${T2}の影響で架空のアイスが売り切れ`, 14, 210, null, 12, T2),
  G('sample_ai_a', `${T3}。手のひらサイズの架空デバイス #サンプルAIガジェット`, 5, 4300, 200000, 800, T3),
  G('sample_ai_b', `${T3}の価格は架空の2万円台 #サンプルAIガジェット`, 6, 1700, 76000, 260, T3),
  G('sample_ai_c', `${T3}を触ってみた第一印象（フィクション） #サンプルAIガジェット`, 10, 950, 41000, 120, T3),
  G('sample_ai_d', `${T3}への批判的な意見まとめ（架空）`, 17, 330, 12000, 36, T3),
  G('sample_ai_e', `${T3}の発表会ライブ配信の切り抜き（架空）`, 19, 120, 4800, 10, T3),
];

export function buildSamplePosts(now = new Date()) {
  const base = now.getTime();
  return ROWS.map((r, i) => {
    const postId = r.id ?? `990000000000${String(1000 + i).padStart(5, '0')}`;
    const at = new Date(base - r.ago * H).toISOString();
    return {
      postId,
      url: null,
      authorHandle: r.handle,
      authorName: `サンプル ${r.handle.replace(/^sample_/, '')}`,
      text: r.text,
      postedAt: at,
      metrics: { views: r.views, likes: r.likes, reposts: r.reposts, replies: null, bookmarks: null },
      metricsFetchedAt: r.likes === null && r.views === null && r.reposts === null ? null : at,
      source: { type: 'sample', detail: r.topic ? `トピック: ${r.topic}` : 'サンプルデータ' },
      genreHint: r.hint,
      matchedKeywords: [],
      lang: 'ja',
      raw: null,
    };
  });
}

export function loadSample(store, now = new Date()) {
  return store.upsertPosts(buildSamplePosts(now), { isSample: true });
}
