# プロジェクト一覧・ダッシュボードの接続契約

`ProjectDirectory` は日常のサイト選択、`ProjectDashboard` は選択した1 Project・1 Siteの運用状況を表示します。作成・参加者追加・解除は既存 `ProjectManager` に接続し、この2画面には再実装しません。React不要の型・parserは `@niho/web/project-read-model` から利用できます。

## 正本と責務

`Project` / `ProjectCatalog` の契約は変更しません。表示用の公開状態・更新日時・画像・解析・集計は、ホストの読み取りadapterから別のread modelとして受け取ります。ライブラリは認証、認可、Project参加資格、解析サービス、画像の利用権、永続化、本番APIを所有しません。

ホストは各呼び出しで現在の認証・対象Projectへの参加資格・唯一のSiteへの権限を検証します。ディレクトリは閲覧できるProjectだけを返します。Projectもsummaryも返せない場合は `forbidden` を返し、秘密や非公開原稿をエラー文に含めません。例外は画面上で一般的な取得失敗になります。権限喪失を取得失敗と区別するには明示的に `forbidden` を返してください。

画面から渡されるProjectやcallbackは認可の証明ではありません。Dashboard・Editor・設定を開くときにもホストが認可してください。Editorには既存 `createProjectEditorAdapter` を使用できます。

## ProjectDirectory

```tsx
import { ProjectDirectory, type ProjectDirectoryAdapter } from '@niho/web/project-directory';

const adapter: ProjectDirectoryAdapter = {
  loadDirectory: (signal) => authenticatedHost.readProjectDirectory(signal),
  isThumbnailUrlAllowed: (url) => publicOrAuthorizedAssetUrls.has(url),
};

<ProjectDirectory
  adapter={adapter}
  onCreateProject={openExistingProjectManager}
  onOpenDashboard={openProjectDashboard}
  onOpenEditor={openProjectEditor}
  initialFocusProjectId={returningProjectId}
/>;
```

`loadDirectory` は `unknown` を返し、runtime parserで検証します。

```ts
{
  status: 'ready',
  entries: [{
    project, // 既存Project。membersは別Projectにも重複参加できる
    summary: {
      projectId: project.id,
      siteId: project.site.id,
      publicationStatus: 'published', // published | unpublished | unknown
      publishedUrl: 'https://demo.example.test', // string | null
      thumbnail: { url: '/public-preview.svg', alt: '合成サイトのプレビュー' }, // またはnull
      updatedAt: '2026-10-20T09:00:00Z', // string | null
      lastAccessedAt: null, // string | null
    },
  }],
}
// 権限なし: { status: 'forbidden' }
```

- summaryの `projectId` / `siteId` は同じentryのProjectと一致必須です。Project・Siteの重複や未知フィールドも拒否します。
- 名前・サイト名・公開ドメインを検索し、既定では `updatedAt` の新しい順に並べます。日時未取得は末尾、同時刻は名前順です。未取得日時を合成しません。
- 画像は安全なHTTPS URLまたは `/` から始まる同一originの公開・素材URLで、さらに `isThumbnailUrlAllowed` が同期的に許可したものだけを描画します。任意URLへのアクセス確認・画像生成・スクリーンショット取得はしません。資格情報付きURL、data、javascript、protocol relative、fragmentは拒否し、許可外・画像失敗時はプレビューなし表示です。ホストは非公開原稿や閲覧不能な素材、内部サービスのURLを許可しないでください。
- 公開URLは `published` のときだけ設定でき、Projectの `site.domains` のHTTPS originに所属する必要があります。設定ドメイン自体は公開の証明として扱いません。
- 0件と検索結果0件を区別し、作成・検索解除の導線を提供します。作成・メンバー管理のフォームは日常一覧に置きません。
- プレビューカードの下に同じ検索結果・並び順のコンパクトな一覧を表示します。一覧はProject名・Site名、公開状態・設定ドメイン、メンバー数と名前、最終更新・最終アクセスを読み取り専用で表示し、DashboardとEditorを別々に開けます。プランや請求情報はProject契約に無いため表示しません。狭い画面では一覧行へ集約します。

## ProjectDashboard

```tsx
import { ProjectDashboard, type ProjectDashboardAdapter } from '@niho/web/project-dashboard';

const adapter: ProjectDashboardAdapter = {
  loadDashboard: ({ projectId, siteId }, signal) =>
    authenticatedHost.readProjectDashboard({ projectId, siteId }, signal),
};

<ProjectDashboard
  project={selectedProject}
  adapter={adapter}
  onBackToProjects={openProjectDirectory}
  onOpenEditor={openProjectEditor}
  onOpenSettings={(project, section) => openHostSettings(project, section)}
/>;
```

`onOpenSettings` の `section` は `site` または `analytics` です。設定ボタンと解析未接続のCTAは、ホストが実装した設定画面へ接続してください。概要とアクセス解析は実際の表示切替で、未実装のCMS・フォーム・課金タブは出しません。公開サイト確認は別タブで開き、元のDashboardを残します。

```ts
{
  status: 'ready', projectId: project.id, siteId: project.site.id,
  fetchedAt: '2026-10-20T09:00:00Z',
  overview: { status: 'ready', data: {
    publicationStatus: 'published', publishedUrl: 'https://demo.example.test',
    lastPublishedAt: '2026-10-20T09:00:00Z',
    publishedPageCount: 4, assetBytes: null,
    recentChanges: [{ id: 'change_one', label: '合成ページの見出しを更新', changedAt: '2026-10-20T09:00:00Z' }],
  } },
  analytics: { status: 'ready', data: {
    period: { start: '2026-10-01T00:00:00Z', end: '2026-10-20T09:00:00Z' },
    fetchedAt: '2026-10-20T09:00:00Z', uniqueVisitors: 0, pageViews: null,
  } },
}
// overview取得失敗: overview: { status: 'unavailable' }
// 解析取得失敗: analytics: { status: 'unavailable' }
// 解析未接続: analytics: { status: 'disconnected' }
// 権限なし: { status: 'forbidden', projectId: project.id, siteId: project.site.id }
```

- 要求と応答のProject・Site IDは両方一致必須です。`forbidden` 応答も照合します。公開URLも選択Siteの公開ドメインと照合します。
- 数値は非負のsafe integerまたは `null` です。`null` を0へ変換せず「未取得」と表示します。0はホストが確認した実際の0件です。公開状態が不明なら「公開状態未取得」を表示します。
- 日時はtimezone付きISO timestampです。解析対象期間の開始・終了、解析取得日時、Dashboard取得日時を表示します。表示は日本時間です。期間の逆転を拒否します。
- 公開情報と解析の部分失敗を別々に表示します。未公開サイトに公開リンクを出しません。直近変更0件と取得失敗も別の状態です。変更はホストが返した順に最大20件表示します。
- 概要には解析の要約（訪問者数、ページ表示数、対象期間、解析取得日時）とアクセス解析画面への導線を表示します。解析が未接続・取得失敗の場合はそれぞれの状態を表示し、公開情報の成否とは独立させます。`null` は未取得、`0` は実数値として表示します。
- メンバー画面は選択Projectの `members` の表示名と人数を読み取り専用で表示します。0名は空状態として表示し、追加・解除の操作は既存 `ProjectManager` が担います。
- DashboardはSTUDIOを参考に、サイト名・公開ドメイン、上部のホーム／アナリティクス／設定／デザインエディタ、ホーム配下のダッシュボード／プロジェクト設定／メンバーという階層で表示します。CMS・フォーム・課金などホストに機能がない導線は表示しません。ホーム本文は公開状態・ドメイン・ページ数・直近の変更と解析概要を表示し、メンバーは専用画面で読み取り専用表示します。デスクトップではホームメニューを左に、本文列を最大992px（内側の余白を除く本文は最大920px）で中央に配置し、幅900px以下ではメニューを横並びにして本文の上に置きます。

## 非同期・接続切替・画面遷移

ホストは通常の再描画で `adapter` と選択 `project` の参照を維持してください。ディレクトリはadapter参照、DashboardはadapterまたはProject参照の変更で画面stateをリセットします。アカウント切替・権限喪失通知・接続先切替では参照を差し替えるかunmountし、以前の表示を持ち越さないでください。

再読込を始めると直前のデータとEditor・設定・公開サイトの操作を隠します。adapter交換・Project切替・unmountは進行中のsignalをabortし、世代照合によってabortを無視したadapterの遅延応答も捨てます。取得失敗・ID不一致・権限なしの場合は以前の値を残しません。ホストのpush通知や認証監視自体は実装しません。

ホストは一覧・Dashboard・Editorを別の画面として切り替え、スマホで一覧の下にDashboardや作成フォームを積まないでください。遷移後の見出しへのfocus・scroll復元、Editorの未保存内容の保持または確認もホストの責務です。一覧へ戻るときは任意の `initialFocusProjectId` を指定すると、読込後に対象の一覧行のボタンへ一度だけfocusを戻し、行を表示範囲へ入れます。未指定・該当Projectなしの場合はfocusを移しません。各操作はnative button/link、検索はlabel、focus-visibleを持ちます。320pxでは表を縦の一覧行に変え、カードを隠して名前とURLを折り返します。

CSSはpackage内にscopeし、既存packageと同じfont・余白・緑系surfaceの慣習を使います。ホストが定義している場合は `--niho-text` / `--niho-text-sub` / `--niho-border` / `--niho-surface` / `--niho-surface-subtle` / `--niho-primary-bg` / `--niho-primary-ink` を使い、未定義ならpackage内のfallbackで描画します。NIHOappへのimportはありません。

## デモと検証

`npm run demo:projects` は日常一覧 → 選択ProjectのDashboard → Editor / 既存ProjectManagerの導線を提供します。解析値・画像・日時・参加者はすべて合成値で、公開URLも `.example.test` です。画像はローカルサーバーが生成するSVGで、実サイトや外部画像サービスへ接続しません。設定画面はホスト接続先を示す合成画面です。デモで開いたEditorは画面切替時にunmountせず、Projectごとの入力を保持します。

`test/project-read-model.test.mjs` は正本との分離、ID・URL・画像許可・数値・日時のruntime検証を確認します。`test/project-views-ui.test.mjs` は複数Project、検索・順序・各導線、空状態・画像失敗・未接続・部分失敗・権限喪失、adapter交換・Project切替・unmount後の遅延応答破棄を確認します。
