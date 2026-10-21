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
- 共通部品のライブラリを持つサイトでは、影響に `findComponentLinks(library, path, domains)`（部品の中のリンク）と `findInstanceLinks(document, library, path, domains)`（インスタンスのページごとのリンク先）も含めます。書換えでは `rewriteComponentLinks`（変わった部品の version を上げたライブラリ）と、各文書への `rewriteInstanceLinks` も行い、ライブラリも新しい revision で保存します。
- canonical は `resolvePageMetadata` の結果を使い、sitemap は `shouldIncludeInSitemap` が `true` のページだけを含めます。
- private のページは公開サイトで 404 またはホストの認証画面にし、sitemap から外し、検索エンジン向けには `noindex` を出します。

## 公開メタ情報

ページ固有の公開メタ情報は、文書の任意項目 `meta` に保存します。本文と同じ下書き保存・公開差分・rollback の対象になるため、プレビュー・公開後の HTML と編集画面の値が一致します。

```ts
type PageMeta = {
  description?: string;                       // 空白だけは不可・改行なし・最大500文字
  ogImage?: PageImage;                        // ソーシャルカバー
  favicon?: string;                           // ページ固有の favicon（URL だけ）
  noindex?: boolean;                          // 検索エンジンに表示しない
  structuredData?: string[];                  // ホストが許可した構造化データの ID（最大16件・重複不可）
};
```

```ts
// URL か素材ライブラリの参照のどちらか一方。alt は改行なし・最大300文字（装飾的なら空文字）。
type PageImage = { src: string; alt: string } | { asset: { provider: string; id: string }; alt: string };
```

URL は文書の他の URL と同じく、資格情報のない HTTPS か `/` から始まる同一サイト内パスです。`#id` は使えません。`src` と `asset` の併用・どちらも無い値は拒否します。`asset` の規則は[素材ライブラリ契約](asset-contract.md)の素材参照と同じで、URL はホストが描画時に解決します（文書には保存しません）。値が無い項目、`noindex: false`、空の `structuredData` は保存しません。空文字の説明文は拒否します。`meta` が空になった場合は文書から取り除きます。`meta` を含む文書は、この版以降のパッケージでだけ検証を通るため、描画側を先に更新してからエディターで保存してください。素材参照のソーシャルカバー（`ogImage.asset`）も同じで、これを含む文書・サイト設定は、対応する版より前の `@niho/web` では検証エラーになります。

構造化データやカスタムコードを任意の JSON・スクリプトとして文書へ保存しません。ホストは `listSites` の `structuredData` に許可する種類（`{ id, label, description? }`）を返し、スタッフはページごとに有効にする種類を選びます。JSON-LD の中身はホストが自分の正本データから生成します。

### favicon を URL のままにする理由

favicon は素材参照にしません。

- ブラウザが確実に扱える形式は ICO・PNG・SVG で、複数サイズや apple-touch-icon を併せて用意するのが一般的です。素材ライブラリで配置できる画像は JPEG・PNG・WebP・AVIF・GIF で、ICO と SVG（安全のため除外）を扱えず、WebP・AVIF・JPEG の favicon は表示されない環境があります。
- `ResolvedAsset` は形式を持たないため、描画時に favicon として使える画像か確かめられません。画像配信の変換で形式が変わる場合もあります。
- favicon はブラウザに長くキャッシュされ、`/favicon.ico` も別に取得されます。素材の非公開化に合わせて外しても表示が残るため、素材参照の「解決できなければ出さない」が働きません。

サイトのビルドと一緒に配信する静的ファイルの URL（`/favicon.ico` 等）を指定してください。

### サイト共通の設定

サイト全体の既定値は、任意メソッドで読み書きします。

```ts
type SiteSettings = {
  title: string;                              // サイトタイトル。最大120文字
  description?: string;                       // ページに説明文が無い場合の既定値
  ogImage?: PageImage;                        // URL か素材参照
  favicon?: string;
  locale: string;                             // 既定の言語（ja / ja-JP 等）
  noindex?: boolean;                          // サイト全体を検索エンジンに表示しない
};

readSiteSettings(siteId, signal): Promise<{ settings: unknown; version: string }>;
saveSiteSettings({ siteId, settings, expectedVersion }, signal): Promise<{ status: 'saved'; version: string } | { status: 'conflict' }>;
```

`parseSiteSettings` で検証し、未知の項目を拒否します。サイト設定の `ogImage.asset` は文書の外にあるため、`collectAssetReferences` には含まれません。ホストは `saveSiteSettings` で参照がそのサイトの使ってよい素材かを確認し、素材の使用状況・削除の可否にもサイト設定の参照を含めてください。保存は ETag 等の opaque な `version` による楽観ロックです。保存したサイト設定は下書きで、ホストは次の公開確認の差分に「サイト共通」の変更として含め、公開時に一緒に反映してください。409 ではエディターが入力を保持し、最新の設定の読込を明示操作にします。

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
  assets,                        // 任意。ホストが解決した素材（PageRenderer に渡すものと同じ map でよい）
});
```

- `title` は文書の `title`、`description`・OG画像・favicon はページの値が無ければサイト設定の値を使います。
- `preview: true`、`visibility: 'private'`、ページまたはサイトの `noindex` のいずれかで `robots` は `noindex, nofollow` になり、canonical を出しません。
- OG画像の `/` から始まる URL は `domain` を前に付けた完全な URL にします。
- 素材参照の OG 画像は `assets`（`ResolvedAssetMap`。キーは `assetKey`）で解決できた場合だけ、その `src` を `og:image` に使います。`assets` は `parseResolvedAssets` と同じ規則で検証し、不正な値があれば例外にします。素材の `width` と `height` がそろっていれば `og:image:width` / `og:image:height` も出します。
- ページの素材が解決できない場合（削除・非公開・他サイト・権限外、または `assets` を渡していない）は、ページに画像が無い場合と同じくサイト設定の画像で補い、それも解決できなければ `og:image` と `twitter:card` を出しません。公開ページに許可していない画像を残さないため、描画のたびに最新の許可状態から解決してください。公開前の確認では `missingAssetReferences(document, assets)` に OG 画像の素材も含まれます。
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
- ソーシャルカバー: `PageEditor` に `assets` adapter を渡したホストでは、プレビューの下の「画像を選ぶ」から素材ライブラリの選択パネルを開き、選んだ素材を参照として保存します。プレビューは `resolveAssets` で解決した画像です。SNS のリンクプレビューで表示できない形式（AVIF 等）は選べません（JPEG・PNG・WebP・GIF）。URL での指定は「URL で指定」の中に残り、URL を入れると素材の参照を外して URL の画像に切り替わります。「画像を外す」で未設定に戻せます。`assets` adapter が無いホストでは、従来どおり URL の入力だけを表示します。

ホストがページ操作やサイト設定のメソッドを実装しない場合、該当する操作は表示せず、値は読み取り専用で表示します。

### サイト共通スタイルの保存と削除

`SiteSettings` は任意で `tokens?: Record<string, DesignToken>` と `textStyles?: Record<string, TextStyle>` を持ちます。値と参照の許可範囲はページと共通で、`parseSiteSettings` は未知フィールド・未解決参照・型不一致を拒否します。公開情報だけを編集・保存する場合も既存のスタイル定義を保持します。`readSiteSettings` / `saveSiteSettings` を持たないホストはページのスタイルだけで動作します。

スタイル変更時の保存要求には、保存済み基準の `previousStyles?: SiteStyles` を追加します。エディターは保存前に全ページの実効参照を再検証し、最新のサイト設定と元の version / 内容を比較します。差異または409では入力・元のversion・移行前のページを保持し、競合した最新設定と比較できます。事前確認は補助で、以下の原子的処理はホストの必須責務です。

1. 認証・サイト権限と `expectedVersion`、`previousStyles` と現在の設定の一致を検証します。
2. 全ページの下書き・公開 snapshot・共有参照・保護対象を列挙し、ページ override を適用した実効参照を検証します。UIの閲覧可能ページ一覧だけを権限範囲の根拠にしません。
3. 削除するサイト定義を各ページで切り離し、見た目を保ったページと新しい設定を同じトランザクションで保存します。各ページの CAS / revision、既存ロック、公開 snapshot の不変性を維持します。途中失敗では全体を反映しません。公開版は同じ見た目の新しい公開 snapshot として作り、過去版を書き換えません。
4. 新しい opaque なサイト version を返します。公開差分・影響ページ・キャッシュ更新対象もサイト設定の変更として扱います。

全参照の切り離しを原子的に保証するホストだけ `siteStyleCapabilities: { atomicReferenceDetachment: true }` を設定してください。省略したホストでは共通定義の削除を UI と保存前ガードの両方で拒否します。追加・更新は利用できます。ホストも capability 宣言だけに依存せず、保存 API で同じ条件を強制してください。

切り離しの補助関数は `detachRemovedSiteStyles(page, previousStyles, nextStyles)`（`@niho/web/core`）です。削除 token を参照する宣言を旧 literal 値へ置き換え、削除文字スタイルは responsive を含むページ所有の定義へ移します。既存のページ override を優先し、共有参照から独立した状態で以前の見た目を保ちます。切り離し後は `parsePageDocument(result, blocks, { components, siteStyles: nextStyles })` で検証してから保存します。この関数はページ1件の純粋変換で、DBトランザクションや全参照列挙を代行しません。

サイト設定の保存は下書き保存です。`prepareRelease` は現在の公開 snapshot と次の設定を比較し、サイト共通 token / 文字スタイルの before / after と全影響ページを `changes` / `affected` に含めてください。確認 token はサイト設定の version と対象ページ・部品の版に結び付け、`release` で再検証します。削除に伴う切り離しだけで見た目が変わらない場合も、参照の変更を公開差分に明示します。

`readRevision` は共通スタイルを参照する版について、その版に対応する不変の `siteStyles` snapshot を文書とともに返してください。履歴表示・差分・復元では現在のサイト設定を過去版へ合成しません。旧来の自己完結した文書は `siteStyles` を省略できます。ホストは公開版とロールバック版でも同じ snapshot を固定し、後からサイト設定を更新・削除しても過去版の見た目を変えないでください。
