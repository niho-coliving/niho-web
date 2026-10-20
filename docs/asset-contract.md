# 素材ライブラリ契約

`@niho/web/assets` は、サイト別の素材（画像・動画・PDF 等）を一覧・検索・アップロード・更新・削除し、ページ文書から安定した素材IDで参照するための公開可能な型・検証・純粋関数です。React を必要としません。`@niho/web/editor` の `PageEditor` に `assets` adapter を渡すと、左レールの「素材」パネルとインスペクタの「画像を選ぶ」が有効になります。

このパッケージは認証・認可・保存先・ウイルス検査・画像変換・配信 URL の発行・使用状況の集計・課金上限を所有しません。すべて認証済みホストの責務です。公開リポジトリ・公開パッケージ・文書に秘密、署名付き一時 URL、未公開原稿、個人情報を置きません。

## 文書からの参照

画像要素は URL の代わりに素材参照を持てます。URL はホストが描画時に解決します。

```json
{ "type": "element", "id": "photo", "tag": "img",
  "asset": { "provider": "uploads", "id": "ast_01HZX3" },
  "attrs": { "alt": "海辺のリビング" }, "children": [] }
```

- `asset` を持てるのは `img` だけです。`asset` と `attrs.src` は併用できません。`attrs.alt` は必須です（装飾画像は空文字）。
- `provider` はホストが決める素材の出所の名前（英字始まりの英数字・`_`・`-`、最大80文字）です。#11 の段階ではサイトへのアップロードだけを扱い、例では `uploads` を使います。
- `id` はホストが採番する不変の opaque ID です。英数字始まりの英数字・`.`・`_`・`~`・`-` で最大128文字です。同じ ID の内容を差し替えず、別の画像は別の ID にしてください。
- 背景画像は style の `backgroundImage` に `{ "asset": { "provider": "…", "id": "…" } }` だけを指定できます。文字列 URL・token は指定できません。`backgroundSize`（`auto` / `cover` / `contain`）、`backgroundPosition`（`center` / `top` / `bottom` / `left` / `right` と2語の組合せ）、`backgroundRepeat`（`no-repeat` / `repeat` / `repeat-x` / `repeat-y`）は通常の style として幅別に指定できます。

従来の `attrs.src` による URL 画像はそのまま描画できます。素材参照へ移す場合は、ホストが既存の公開 URL を素材として登録し、文書の `attrs.src` を `asset` に置き換えた新しい revision を保存します。エディターのインスペクタでも、URL 画像を選んで「画像を選ぶ」から素材へ切り替えられます。逆に「URL で指定」から URL 画像へ戻すこともできます。

素材参照を含む文書は、この版より前の `@niho/web` では検証エラーになります（未知フィールドを拒否するため）。素材参照を保存・公開する前に、描画する全サイトのパッケージをこの版以降へ更新してください。

## 描画時の解決

```ts
import { collectAssetReferences, uniqueAssetReferences, missingAssetReferences, assetKey, type ResolvedAssetMap } from '@niho/web/assets';

const references = uniqueAssetReferences(document);
// ホストのサーバー処理で、このサイトの公開に使ってよい素材だけを解決する。
const assets: ResolvedAssetMap = Object.fromEntries((await host.publicAssets(document.siteId, references))
  .map((asset) => [assetKey(asset.reference), { src: asset.src, width: asset.width, height: asset.height }]));
```

```tsx
<PageRenderer document={document} blocks={blocks} assets={assets} />
// Astro: renderPageToHtml(document, blocks, { assets })
```

`assets` のキーは `assetKey({ provider, id })`（`provider:id`）、値は `{ src, width?, height? }` です。`src` は HTTPS または `/` 始まりの公開 URL に限り、`parseResolvedAssets` と同じ規則で描画前に検証します。不正な値があると描画全体を止めます。`width` と `height` がそろっていて、要素側に寸法が無い場合は `img` に付けてレイアウトのずれを防ぎます。

解決できない参照（削除済み・非公開・他サイト・権限外）の画像は描画しません。背景画像も該当の宣言だけを出しません。公開前に `missingAssetReferences(document, assets)` で未解決の参照を確認し、公開を止めるか警告してください。公開ページに許可していない画像を残さないため、描画のたびに最新の許可状態から解決することを推奨します。キャッシュする場合は、素材の削除・非公開化と同時に無効化してください。

エディターのプレビューは `adapter.resolveAssets` で同じ形の map を取得し、未解決の画像を破線の枠で表示します。

## ホスト adapter

```ts
import type { AssetLibraryAdapter } from '@niho/web/assets';
import { PageEditor } from '@niho/web/editor';

<PageEditor adapter={editorAdapter} assets={assetLibrary} blocks={blocks} />
```

`assets` も `adapter` と同じく module scope / `useMemo` 等で参照を安定させてください。

| メソッド | 役割 |
| --- | --- |
| `listAssets(query, signal)` | `siteId` の素材を検索語・種類・フォルダで絞り、`limit` 件ずつ返す。フォルダ一覧、容量、アップロード条件、続きの `nextCursor` を含める |
| `uploadAsset(request, signal)` | 1ファイルを受け取り、検査・保存後に素材を返す。拒否は理由付きの `rejected` |
| `updateAsset(request, signal)` | 名前・代替テキストの初期値・フォルダを楽観ロック付きで更新 |
| `listAssetUsages(request, signal)` | 素材を参照している下書き・公開版のページ一覧 |
| `deleteAsset(request, signal)` | 未使用の素材だけを削除。使用中なら `in-use` と使用先を返す |
| `resolveAssets(request, signal)` | エディターのプレビュー用に、参照を表示用 URL へ解決 |
| `createFolder(request, signal)`（任意） | フォルダを作成。実装しない場合は UI に作成ボタンを出さない |

エディターは各応答を `parseAssetListResult` 等で検証します。要求した `siteId` と異なる素材、危険なサムネイル URL、未知のフィールドを含む応答は採用しません。ただし UI の検証は補助です。ホストは各呼出しで認証、サイト・プロジェクトの権限、素材の所属を確認してください。`createProjectEditorAdapter` で編集対象を1サイトに限定した場合も、素材 adapter は同じサイトの素材だけを返す必要があります。

### 素材の形

| フィールド | 内容 |
| --- | --- |
| `provider` / `id` | 文書から参照する組 |
| `siteId` | 所属サイト。要求したサイトと一致しなければ拒否 |
| `kind` | `image` / `video` / `pdf` / `other` |
| `status` | `ready` / `processing`（検査・変換中。配置できない） |
| `name` / `mimeType` / `bytes` / `width` / `height` | 表示名、形式、容量、画像の寸法 |
| `alt` | ページへ配置するときの代替テキストの初期値。配置後は要素ごとの `attrs.alt` を編集する |
| `folderId` / `thumbnailUrl` / `usageCount` | フォルダ、エディター用サムネイル、使用数の目安 |
| `version` / `updatedAt` | メタデータ更新・削除の楽観ロック値、更新日時 |

一覧に出すのは編集者が閲覧を許可された素材だけです。ページへ配置できるのは `kind: "image"`・`status: "ready"`・`image/jpeg` / `image/png` / `image/webp` / `image/avif` / `image/gif` の素材だけです（`isInsertableImage`）。動画・PDF・SVG 等は一覧と詳細に表示しますが、配置ボタンを出しません。

### アップロード

`listAssets` の応答に `upload: { accept, maxBytes }` がある場合だけ、アップロードボタンを表示します。エディターは形式・サイズ・容量の残りを送信前に確認しますが、ホストも同じ制限を必ず再検証してください。ファイル内容から形式を判定し、拡張子や `Content-Type` を信用しないでください。

拒否は `{ status: "rejected", reason }` で返します。

| reason | 表示 |
| --- | --- |
| `permission` | 素材を追加する権限がない |
| `quota` | 容量の上限を超える |
| `size` | 1ファイルの上限を超える |
| `type` | 受け付けない形式 |
| `scan` | 安全性の確認で受け付けなかった |
| `invalid` | ファイルを読み取れない |

HTTP の 403 / 413 / 415 / 507 / 409 を例外の `status` として投げた場合も、同じ分類で表示します。それ以外の例外は一般的な失敗として扱い、生のメッセージを表示しません。ウイルス検査や変換を非同期で行う場合は `status: "processing"` で返し、完了後の一覧で `ready` にします。

### 更新・削除と使用状況

`updateAsset` と `deleteAsset` は `expectedVersion` を受け取り、ストレージ側で原子的に比較します。競合は `{ status: "conflict" }` です。自動上書き・自動 merge はしません。

削除は、どのページの下書き・公開版からも参照されていない素材だけに許可してください。ホストは削除処理の中で使用状況を再確認し、使用中なら `{ status: "in-use", usages }` を返します。公開版で使われている素材を消すと公開ページの画像が失われるためです。エディターも、編集中の文書（未保存の変更を含む）で使っている素材の削除ボタンを無効にし、このページの使用箇所を別の画像へまとめて置き換える操作を案内します。他ページの使用箇所は、そのページを開いて置き換え、公開した後に削除します。

undo で削除済み素材の参照が戻ることがあります。その画像はプレビューで未解決の枠になり、公開時には描画されません。保存・公開 API でも参照先の存在と所属を検証してください。

## 文書の保存・公開時の検証

ホストは保存・公開のたびに `collectAssetReferences(document)` で参照を列挙し、すべてが同じサイトに属し、利用者が使ってよい素材であることを確認してください。文書の `siteId` と異なるサイトの素材、他プロジェクトの素材、存在しない ID を含む文書は保存を拒否します。公開前の差分（`prepareRelease`）には、追加・削除される素材の名前を含めると確認しやすくなります。

## 動作例と検証

`npm run demo` の動作例は `examples/memory-asset-library.mjs` のメモリ内ライブラリを使います。アップロードしたファイルはデモサーバーのメモリにだけ保存され、再起動で消えます。認証・外部ストレージ・実サイトには接続しません。メモリ内ライブラリは、他サイトの要求の拒否、形式・サイズ・容量の再検査、楽観ロック、使用中の削除拒否、他サイト素材を解決しないことをホスト境界の例として実装しています。本番の永続化例ではありません。

実サイトでの保存・配信・権限の受け入れは、Experience は niho-coliving/niho-experience#39、鎌倉は niho-coliving/kamakura-site#42 で行います。
