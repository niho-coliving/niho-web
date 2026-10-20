# ページ管理・公開情報の契約

`@niho/web/pages` は、ページのURLパス、ページ一覧のツリー、内部リンクの影響、公開メタ情報（title / description / OG画像 / favicon / robots / canonical）を扱う React 不要の入口です。`@niho/web/editor` の `PageEditor` は同じ関数を使い、左のページパネルと右の「ページ／サイト」設定を表示します。

ページの作成・URL変更・公開状態の切替、redirect、sitemap、robots.txt、配信キャッシュの更新は各サイトのホストが所有します。パッケージは操作の要求・影響の表示・確認 token の受け渡しを型で固定し、サイト固有の公開方式を持ち込みません。

## ページ一覧の項目

`listPages` が返す `EditorPage` に、次の任意項目を追加できます。省略した既存ホストは従来どおり動作し、パスを持たないページはツリーの最上位に並びます。

| 項目 | 内容 |
| --- | --- |
| `path` | 公開URLのパス。`/` または `/a/b`。テンプレートは `/experiences/[slug]` のように動的部分を `[name]` で表す |
| `kind` | `page`（通常ページ）／`template`（一覧・詳細などのテンプレート）／`shared`（ヘッダー・フッター等の共通枠） |
| `visibility` | `public` または `private`。private は公開サイトで表示しない |
| `published` | 公開版があるか。`false` は一度も公開していないページ |

`title` はページ一覧に出す名前（STUDIO の「ページ名」）です。検索結果やタブに出る `<title>` は文書の `title`（ページタイトル）で、別に編集します。

テンプレートと共通枠はホストが正本を管理します。エディターはこれらの複製・URL変更・公開状態の切替を提供しません。体験詳細のようなテンプレートを、体験ごとの通常ページとして作成させないためです。通常ページのパスがテンプレートの動的パスと一致する場合も作成・変更できません。

## パスの規則

- `/` か、`/` で区切った半角英小文字・数字のセグメント。セグメント内は `-` / `_` で区切れます（例 `/circles/kamakura-go`）。
- 最大160文字、最大8階層。末尾 `/`、連続 `/`、大文字、`.`、空白、query、fragment は使えません。
- 同じサイト・locale の中で重複できません。テンプレートの動的パスに一致するパスも使えません。
- 管理画面・API・CMS が使う予約パスはホストごとに異なるため、`preparePageChange` でホストが拒否します。

`validatePagePath(path)` は問題を日本語の文で返し、正しい場合は `null` を返します。`findPathConflict(pages, request)` は重複するページまたは一致するテンプレートを返します。どちらも UI の補助で、ホストは保存時に同じ規則と予約パスを検査してください。

## ページ操作の二段階確認

ページ操作は `EditorAdapter` の任意メソッドで接続します。両方を実装したホストでだけ、ページパネルに追加・複製・URL変更・公開切替が表示されます。

```ts
type EditorPageChange =
  | { action: 'create'; siteId: string; locale: string; title: string; path: string }
  | { action: 'duplicate'; source: EditorTarget; title: string; path: string }
  | { action: 'update'; target: EditorTarget; title: string; path: string }
  | { action: 'visibility'; target: EditorTarget; visibility: 'public' | 'private' };

preparePageChange(change, signal): Promise<EditorPageChangePlan>;
applyPageChange(plan, signal): Promise<{ status: 'applied'; page: EditorPage } | { status: 'conflict' }>;
```

`preparePageChange` は変更を実行せず、影響を計算して確認 token を発行します。plan は次の形です。

```ts
type EditorPageChangePlan = {
  change: EditorPageChange;          // 要求と完全に一致させる
  confirmationToken: string;
  domain: string;                    // listSites の許可済み HTTPS origin
  impact: {
    before?: string;                 // 変更前の公開URL（完全なURL）
    after?: string;                  // 変更後の公開URL
    redirect?: { from: string; to: string };
    linkedFrom: { pageId: string; locale: string; title: string; count: number }[];
    navigation: string[];            // 影響する共通枠・ナビゲーションの名前
    notes: string[];                 // sitemap から外れる、canonical が変わる等
  };
};
```

エディターは plan の `change`・`domain`・URL・件数の形を検証してから確認画面を開きます。対象ドメイン、変更前後のURL、redirect、内部リンク元のページと件数、ナビゲーション、注意事項を表示し、明示チェック後だけ実行できます。非公開にする操作は、公開中のURLが表示されなくなることと、リンク元を先に示します。

ホストは token を対象サイト・ページ・要求内容・現在のページ一覧の版に結び付け、短い有効期限と一回限りの利用を実装してください。`applyPageChange` でも認可・パス重複・予約パスを原子的に再検証し、状態が変わっていれば HTTP 409 を `{ status: 'conflict' }` として返します。UI から渡された `domain` や `impact` を権限の根拠にしません。

ページ操作は、開いている文書に未保存の変更や入力途中の値がない間だけ実行できます。ホストがリンクの書換えやパス変更に合わせて文書を更新することがあるためです。成功後、エディターはページ一覧を取り直し、作成・複製したページ、または変更したページの最新の文書を読み込みます。409 と通信失敗では入力を保持します。通信失敗は「反映されたか不明」として扱い、一覧の再読込を促します。

### パス変更・非公開化でホストが行うこと

- 公開済みページのパスを変える場合、旧URLから新URLへの恒久 redirect を追加し、`impact.redirect` に示します。
- 内部リンクの書換えは、`rewriteInternalLinks(document, from, to, domains)` で各文書の `href` を置き換え、新しい revision として保存します。`to` が正しいページパスでない場合は `DocumentValidationError` を投げます。書き換えた文書は公開確認を経て公開します。
- canonical は `resolvePageMetadata` の結果を使い、sitemap は `shouldIncludeInSitemap` が `true` のページだけを含めます。
- private のページは公開サイトで 404 またはホストの認証画面にし、sitemap から外し、検索エンジン向けには `noindex` を出します。

## 公開メタ情報

ページ固有の公開メタ情報は、文書の任意項目 `meta` に保存します。本文と同じ下書き保存・公開差分・rollback の対象になるため、プレビュー・公開後の HTML と編集画面の値が一致します。

```ts
type PageMeta = {
  description?: string;                       // 空白だけは不可・改行なし・最大500文字
  ogImage?: { src: string; alt: string };     // ソーシャルカバー。alt は最大300文字
  favicon?: string;                           // ページ固有の favicon
  noindex?: boolean;                          // 検索エンジンに表示しない
  structuredData?: string[];                  // ホストが許可した構造化データの ID（最大16件・重複不可）
};
```

URL は文書の他の URL と同じく、資格情報のない HTTPS か `/` から始まる同一サイト内パスです。`#id` は使えません。値が無い項目、`noindex: false`、空の `structuredData` は保存しません。空文字の説明文は拒否します。`meta` が空になった場合は文書から取り除きます。`meta` を含む文書は、この版以降のパッケージでだけ検証を通るため、描画側を先に更新してからエディターで保存してください。

構造化データやカスタムコードを任意の JSON・スクリプトとして文書へ保存しません。ホストは `listSites` の `structuredData` に許可する種類（`{ id, label, description? }`）を返し、スタッフはページごとに有効にする種類を選びます。JSON-LD の中身はホストが自分の正本データから生成します。

### サイト共通の設定

サイト全体の既定値は、任意メソッドで読み書きします。

```ts
type SiteSettings = {
  title: string;                              // サイトタイトル。最大120文字
  description?: string;                       // ページに説明文が無い場合の既定値
  ogImage?: { src: string; alt: string };
  favicon?: string;
  locale: string;                             // 既定の言語（ja / ja-JP 等）
  noindex?: boolean;                          // サイト全体を検索エンジンに表示しない
};

readSiteSettings(siteId, signal): Promise<{ settings: unknown; version: string }>;
saveSiteSettings({ siteId, settings, expectedVersion }, signal): Promise<{ status: 'saved'; version: string } | { status: 'conflict' }>;
```

`parseSiteSettings` で検証し、未知の項目を拒否します。保存は ETag 等の opaque な `version` による楽観ロックです。保存したサイト設定は下書きで、ホストは次の公開確認の差分に「サイト共通」の変更として含め、公開時に一緒に反映してください。409 ではエディターが入力を保持し、最新の設定の読込を明示操作にします。

### 描画側での使い方

```ts
import { resolvePageMetadata, renderPageHead, PREVIEW_RESPONSE_HEADERS } from '@niho/web/pages';

const metadata = resolvePageMetadata({
  document,                      // 検証済みの公開文書
  site: siteSettings,            // 任意
  domain: 'https://example.com', // 公開 origin
  path: '/about',                // このページの公開パス
  visibility: 'public',
  preview: false,
});
```

- `title` は文書の `title`、`description`・OG画像・favicon はページの値が無ければサイト設定の値を使います。
- `preview: true`、`visibility: 'private'`、ページまたはサイトの `noindex` のいずれかで `robots` は `noindex, nofollow` になり、canonical を出しません。
- OG画像の `/` から始まる URL は `domain` を前に付けた完全な URL にします。
- `metadata.locale` は文書の locale（`ja-JP`）のまま、`openGraph.locale` は Open Graph の形式（`ja_JP`）にします。
- `structuredData` は有効にした ID の配列です。ホストがその ID に対応する JSON-LD を生成します。

Next.js では `metadata` の各項目へ対応付けます。Astro では `renderPageHead(metadata)` の戻り値を `<head>` に `set:html` で入れられます。戻り値は title・meta・link だけを含み、すべての値を HTML escape 済みです。`og:image:alt` は alt が空でない場合だけ出します。JSON-LD は含みません。

下書きのプレビューは認証付きのURLで配信し、応答に `PREVIEW_RESPONSE_HEADERS`（`Cache-Control: private, no-store` と `X-Robots-Tag: noindex, nofollow`）を付け、`preview: true` で metadata を作ってください。プレビューURLを sitemap、canonical、公開ページのリンクに出しません。

## 内部リンクの影響

`findInternalLinks(document, path, domains)` は、同じサイトのパスを指すリンクのノード ID を返します。`/about`、`/about?x=1`、`/about#team`、`https://<許可済みドメイン>/about` を同じパスとして扱い、`#id` だけのリンクと他サイトの URL は対象外です。ホストは全ページの文書に対して実行し、`impact.linkedFrom` の件数に使えます。

## 編集画面

- 左のページパネル: 検索、フォルダ（パスの親ごと）、ページ名と灰色のパス、ホーム・テンプレート・共通枠の区別、非公開・未公開の表示、行ごとの操作メニュー、公開中のページ数。
- 右の「ページ」タブ: ページ名・パス・種類・非公開の切替（いずれも確認付きのページ操作）と、ページタイトル・説明文・ソーシャルカバー・favicon・noindex・構造化データ（文書の編集として元に戻す／やり直す対象）。検索結果での見え方を同じ解決関数で表示します。
- 右の「サイト」タブ: 公開ドメイン、サイトタイトル・説明文・ソーシャルカバー・favicon・言語・サイト全体の noindex。サイト設定は文書とは別に保存します。

ホストがページ操作やサイト設定のメソッドを実装しない場合、該当する操作は表示せず、値は読み取り専用で表示します。
