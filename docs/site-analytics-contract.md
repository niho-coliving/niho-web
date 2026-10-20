# サイト分析・Google接続契約

`@niho/web/site-analytics` は、制作プロジェクトの唯一のサイトに限ってGA4 / Search Consoleの接続状態、変更計画、検証結果と集計の境界を扱う公開契約です。接続画面は #29 が利用します。読取専用の分析画面と集計adapterは `@niho/web/analytics`（#26）です。

## 所有境界と認可

- 対象は `{ projectId, siteId, siteOrigin }` の組です。ホストは現在のセッション、project membership、運営承認、サイトID、公開originを**すべての呼び出しで**照合します。クライアントから渡るID・ドメイン・接続状態は認可根拠にしません。
- 1つのプロジェクトは1サイトを持ちます。別project/site/originの応答は `assertSiteAnalyticsTarget` / parserで拒否し、プロジェクト切替後の遅い応答を採用しません。
- 拠点所有の `SpotWebAnalytics*` と制作プロジェクトの分析データは別の所有物です。GA4プロパティの共有権限だけを根拠に既存の拠点データを返してはいけません。同じ計測先を共有する場合も、運営が承認したサイトoriginとプロジェクトの組を別途確認します。
- ブラウザーへ返してよいのは、画面表示に必要な公開ID、状態、集計値、サイト確認手順だけです。サービスアカウント秘密鍵、OAuth token、個人単位のイベント、自由入力の検索語は返しません。

## GA4接続（#27）

| 項目 | 意味 |
|---|---|
| `measurementId` | 公開サイトの計測タグID。計測タグの状態と一緒に扱い、タグがあるだけで分析API接続済みと表示しない |
| `propertyId` | レポート用GA4プロパティID。測定IDから推測・置換しない |
| `reportingState` | API権限・対象不一致・同期・quota・部分失敗を区別 |
| `propertyTimeZone` | GA4の日付境界。集計日の表示に使う |
| `lastSyncedAt` | 最後に集計を更新したUTC時刻 |

測定タグの設定・削除はプロパティ読取接続と別操作です。タグは対象の公開originだけへ設定し、同じサイトにすでにあるタグを二重に設置しません。下書き・認証付きプレビューへは出さず、既存 `kamakura.niho.life` の設定も置換しません。

`prepareGa4TrackingTag`、`prepareGa4ReportingConnection`、および対応する解除prepare methodは、変更対象と現在値・変更後を含む短時間の `SiteAnalyticsChangePlan` を返します。UIは対象originと影響を利用者に確認してからapply / disconnect methodへ進みます。`disconnectGa4Reporting` はGA4 API接続と集計cacheだけを解除し、計測タグは変更しません。タグの削除も別の確認操作です。

ホストはAPIから対象プロパティとWebデータストリームを読み取り専用で検証し、ストリームのURLが承認済みoriginに合うことを確認します。403 / 404 / 権限失効 / quota / 同期遅延は区別し、既存接続やデータを失敗時に消しません。

## Search Console接続（#28）

所有権確認とAPI読取権限は別状態です。所有確認が済んでAPI未接続の状態、API接続済みで所有確認待ちの状態を表現できます。

`SearchConsoleProperty` はGoogleから返された値を変更せず保持します。

- URL-prefix propertyは `https://www.example.org/` のように `www` と末尾 `/` を含めてそのまま保存・表示します。パス付きURL-prefixは別の範囲です。
- `sc-domain:example.org` は別種のdomain propertyとして完全な値を保持して表示します。URL-prefixや対象originと同一視しません。
- `connected` は対象originのルートURL-prefix property（`https://www.example.org/`）だけを受け入れます。別origin、`sc-domain:`、パス付きURL-prefixは `property-mismatch` などの状態で示し、接続済みとして扱いません。
- Domain propertyの所有権確認はDNS方式だけを受け入れます。meta tag方式はURL-prefix propertyに限ります（[Google公式ヘルプ](https://support.google.com/webmasters/answer/34592?hl=en)）。
- ホストは運営承認済みサイトに対して完全一致するpropertyだけを接続します。広いdomain propertyや狭いパスpropertyを対象サイトの代わりに使いません。
- Search Console APIでは現在の閲覧権限をサーバー側で確認し、サイト・propertyの組が承認と異なる場合や権限が失効した場合は集計を返しません。

確認方式は許可されたサイトのmeta tagまたはDNS TXTです。meta tagはURL-prefix property用、DNS TXTはURL-prefix / Domain property用です。`prepareSearchConsoleVerification` が返す一回・短時間・対象site/origin/property/method束縛のconfirmation planを画面に示し、利用者が確認した後に適用します。meta tagは公開ページだけに反映し、認証付きプレビューや別originへ出しません。APIの接続・解除は確認タグを暗黙に追加・削除しません。

Search ConsoleのAPI読取はSearch Analyticsのread-only queryだけを使います。自由入力の検索語は取得しません。URL-prefixの `/`、`www`、パスをAPI・保存・表示の往復で正規化しません。

## 集計値

- GA4: 日別のsessions、active users、page views、上位ページ。Visitorと読み替えず、指標名とproperty timezoneを表示します。
- Search Console: 日別clicks、impressions、CTR比率（0〜1）、average position、上位ページ。日付はPacific Time（`America/Los_Angeles`）です。
- 2つの系列は別々に集計し、日付を同一timezoneとして加算・比較しません。応答には要求期間と各sourceの `dataEndDate` を含めます。
- `available` は値が取得済み、`empty` は取得成功で対象行が無い状態です。`pending` / `partial` / `sync-delayed` / `permission-required` 等は0として描画しません。未取得値は `null`、取得できた0は数値 `0` です。
- ページ行は同一originのpathだけ、最大50件です。個人別eventとSearch Console query文字列はありません。
- 接続解除・プロパティ差替えの後、ホストはそのプロジェクトの以前の集計cacheを返さないよう無効化します。別サイトや拠点のcacheを共有しません。

## Adapter運用

`SiteAnalyticsConnectionAdapter` の全methodに `AbortSignal` と完全な対象組を渡します。旧名 `SiteAnalyticsAdapter` は互換aliasとして残しています。ホストは認証・認可、site/property照合、Google API呼出し、永続化、cache invalidationを実装します。ライブラリはGoogle APIやNIHO APIへ直接接続せず、認証情報も保存しません。

状態変更前は対象プロジェクト名、公開origin、変更対象（タグ、property、確認方式、解除対象cache）を確認画面に示します。接続チェックやretryはread-onlyで実行できます。失敗時はホストが最新の状態を返し、別プロジェクトの値や古い集計を一時表示しません。

今回の契約は公開ライブラリ側の範囲です。NIHOホストでの権限検証、運営承認台帳、サービスアカウントのSecret Manager設定、API・集計保存、および実サイトでの所有確認はホスト側の別実装と受入が必要です。
