# サイト分析の読取契約

`@niho/web/analytics` は認証済みホスト向けの React 画面、`SiteAnalyticsAdapter`、応答パーサーを提供します。データ取得・認証・認可・OAuth・永続化はホストが所有します。このパッケージは GA4 / Search Console へ通信しません。

## スコープと読取

```ts
interface SiteAnalyticsAdapter {
  loadAnalytics(
    scope: { projectId: string; siteId: string; period: "7d" | "28d" | "3m" | "12m" },
    signal: AbortSignal
  ): Promise<unknown>;
}
```

ホストは**現在の利用者が projectId と siteId の組にアクセスできること**を、すべての呼出しで確認してください。`siteId` 単独を信頼してはいけません。画面は応答の `projectId`、`siteId`、`period` が要求と完全一致するか検証し、不一致なら描画を拒否します。`unknown` の応答は `parseSiteAnalyticsSnapshot(input, scope)` を通してから使います。接続先やスコープの変更時、進行中の `AbortSignal` は中断されます。

既定期間は28日で、選択肢は7日・28日・3か月・12か月です。比較対象は直前の同じ長さの期間です。各 `report` は当期と直前期の**ローカル日付範囲**とIANA時間帯を持ち、結果は別に最終更新時刻と取得済み日 `dataThrough` を持ちます。`empty` はこれらをまとめた `metadata` を持ちます。両範囲は同じ時間帯で連続し、日数が等しくなければ拒否します。Search Console は `America/Los_Angeles`、GA4 はプロパティの時間帯です。

## ソースと数値

`ga4` と `searchConsole` は独立した結果です。それぞれ `available`、`delayed`、`empty`、`not-connected`、`permission-expired`、`failed` を返します。`available` / `delayed` は `report`、`lastUpdatedAt`、`dataThrough`、`empty` は `metadata` を持ちます。遅延時にも取得済みの report を表示し、`dataThrough` と最終更新を別々に示します。片方が失敗しても、もう片方の結果は表示します。

GA4 の report は `sessions`、`activeUsers`、`pageViews` の当期・直前期、日別セッション、流入元別セッション、上位ページの表示回数を持ちます。Search Console は `clicks`、`impressions`、`ctr`（0〜1の比率）、`averagePosition`、日別クリック・表示回数、上位ページのクリック・表示回数を持ちます。各比較値は `{ current, previous }` です。**0 は実測値**、`null` はその指標の未取得値で、画面では「—」と表示します。日別系列の欠測 `null` は折れ線を途切れさせます。GA4 と Search Console の日付境界が違うため、日別行の結合や指標の合算はしません。

上位ページは公開タイトルがあればタイトルとパス、なければパスを表示します。流入元名はホストが利用者向けの日本語表示名を返してください。パスは安全な `/` 始まりに限定し、`//`、制御文字、query、fragment、percent encoding、`.` / `..` セグメントを拒否します。画面はページリンクを生成しません。検索語・個人単位の行は契約に含めません。

## 合成デモ

```sh
npm run demo:analytics
```

`http://127.0.0.1:4175` で架空の集計とソース別の状態を切り替えられます。固定の合成値だけをブラウザ内で返し、認証情報・外部 API・永続化は使いません。
