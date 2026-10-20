# 文書・描画契約 v1

## 責務と信頼境界

このパッケージは公開用の文書と描画を共有します。管理 UI、保存先、認証・認可、サイトの公開状態、ドメインの所有確認、予約ドメインの業務処理は利用側が所有します。サイトの選択や認可済み revision の決定はこのパッケージを呼ぶ前に完了させます。

入力 JSON は信頼しません。runtime で全体を検証して新しい文書へコピーし、未知フィールドも拒否します。TypeScript の型アサーションを検証の代わりにしません。registry とその React コンポーネントは利用側の信頼できるコードです。registry 内での raw HTML、外部通信、認可、業務判断をこのパッケージが安全化することはできません。

## 文書の識別と互換性

必須項目は `schemaVersion: 1`、`siteId`、`pageId`、`locale`、`revision`、`title`、`tokens`、`body` です。サイト・ページ・ノード・ブロックの ID は英字で始まる英数字・`_`・`-` で最大 80 文字、locale は `ja` / `ja-JP` 等、revision は 1 以上の safe integer とします。title は空白以外を含む 300 文字以内です。任意項目 `meta` にページの公開メタ情報（説明文・OG画像・favicon・noindex・構造化データの ID）を持てます。値の規則と描画側の使い方は [ページ管理・公開情報の契約](page-contract.md) を正とします。`meta` は本文と同じ revision に属し、内容を変えたら revision を増やします。

文書契約の非互換変更は `schemaVersion` を上げ、移行処理を明示してから導入します。未知版の暗黙変換は行いません。既存の鎌倉サイトの文書を直接受け入れる形式ではありません。移行時には現行の HTML / CSS を新しい許可リストに対応付ける adapter と視覚確認が必要です。

`siteId/pageId/locale/revision` の組が公開内容を一意に表します。同じ組の内容を変更すると同一 scope の CSS が競合するため、内容更新時は必ず revision を増やします。scope は各値を長さ付きで連結して生成し、他ページ・サイト・revision と衝突しない形にします。`pageScope` は検証済みの ID を持つ文書に対して使います。

## ノード

| type | 内容 | 制約 |
| --- | --- | --- |
| `text` | `text` | HTML として解釈せず React が escape |
| `element` | `id`, `tag`, `attrs?`, `style?`, `children` | 安全な HTML タグ・属性のみ。子配列は必須 |
| `component` | `id`, `block`, `props`, `style?` | 登録済み名・許可された primitive props のみ。独自の children は持たない |

element / component の `id` は文書全体で一意です。element の `attrs.id` は別の HTML ID として同一文書内の重複を拒否します。リンクの `#id` と ARIA の参照先は利用側で揃えます。HTML ID はブラウザ全体の名前空間なので、複数文書を同じページへ置く利用側は document 間でも一意にします。

タグは `src/types.ts` の `ElementTag`、属性は `src/document.ts` の許可リストを正とします。`img` は安全な `src` か素材参照 `asset: { provider, id }` のどちらか一方と、`alt` が必須です。空の alt は装飾画像として許可します。素材参照の URL は描画時にホストの解決済み map から決め、解決できない画像は描画しません（[素材ライブラリ契約](asset-contract.md)）。`a[target=_blank]` には `noopener noreferrer` を描画時に補います。`source.srcSet` は単一 URL のみを許可します。複数候補の srcset、SVG、iframe、form、script、style は v1 の対象外です。

`p` や見出しなどの phrasing content の中への block element、入れ子のリンク、void element の子、不正な list / picture の子を拒否し、初期 HTML をブラウザが組み替えて hydration と食い違うことを防ぎます。ブロックは `<div data-nw-node="…" data-nw-block="…">` に包むため、flow content の中だけで利用できます。ブロック自身が返す HTML の妥当性は利用側で保証します。

## トークンと style

tokens は最大 128 件です。名前は小文字英字から始まる英数字・`-` とし、`color` / `length` / `fontFamily` / `number` の型を持ちます。`{ token: 'ink' }` は定義済みかつプロパティと型が一致し、解決した値自体もそのプロパティに適合するときだけ使えます。token value から別 token への参照はできません。

`color` は HEX（3/4/6/8桁）と限定した基本色名、`length` は 0 または px / rem / em / % / vh / vw / vmin / vmax / ch、`fontFamily` は引用符を要しない名前のカンマ区切り、`number` は有限数です。細かい値の正は `src/style-values.ts` の検証です。`rgb()`、`hsl()`、`calc()`、カスタム CSS 変数、擬似クラス・擬似要素、アニメーションは v1 に含めません。画像 URL は style に直接書けません。背景画像は `backgroundImage: { asset: { provider, id } }` の素材参照だけを受け付け、解決済みの安全な URL から `background-image:url("…")` を生成します。未解決の背景画像は宣言を出しません。`backgroundSize` / `backgroundPosition` / `backgroundRepeat` は列挙値です。

node の `style` は `base` と `responsive` の宣言を持ちます。base を先に、続いて minWidth 昇順の `@media` を生成します。Grid はトラック列と限定した `repeat()` / `minmax()` に対応します。生の selector や CSS ファイルを JSON から読み込みません。CSS と token 変数は文書の `data-nw-scope` の下だけに出力し、ノードごとの `data-nw-owner` でも所属を限定するため、入れ子の別文書へ同じノード ID のルールが漏れません。ノードへ任意 class / style / data 属性を付ける入口は設けません。

scope はページ間の CSS selector の衝突を避けるもので、Shadow DOM のような完全な隔離ではありません。ホストサイトの global CSS、継承、登録ブロックの CSS は描画に影響します。外側のサイトで必要な reset と視覚確認を行ってください。同じ文書の重複表示は同じ style が複数出ることがあります。

## 動的ブロック

`BlockRegistry` の各エントリは `props` 契約と React `component` を持ちます。JSON に実装コード、ファイル名、import path、実行式を保存しません。登録されていても props の許可リスト外の値は渡しません。props の名前は信頼できる registry 側で定義し、React の特殊 props や `on…` は拒否します。

`string` の上限は最大 4,096 文字、`url` は安全な公開 URL、`number` は有限数と任意の min/max、`boolean` は真偽値、`enum` は指定値の文字列です。必須かどうかは `required` で明示します。文字列 prop を URL に使う設計は避け、URL prop を宣言します。props に文書からオブジェクトや配列は渡せません。複雑なデータは公開 ID を渡してアプリの adapter へ接続します。

renderer は同期の React ツリーを返します。データ取得は呼び出し前に利用側で完了させ、データを閉じ込めた同期 component を registry に置く構成を推奨します。Astro の静的 HTML helper は hydration 情報を含みません。Next.js の Client Component や Astro island を利用する場合は利用側がフレームワークの規約に合わせて wrapper を定義します。未知ブロックを静かに空欄にする fallback はありません。

## エラーとリソース上限

無効入力は `DocumentValidationError` で止め、`path` に原因の位置を返します。実際の入力値はエラー文へ埋め込みません。描画 API と CSS API は毎回検証し、無効文書の途中までを公開しません。登録コンポーネント自身が投げる例外は呼び出し側へ伝わります。ページ配信時のエラーページ・直前の公開 revision の利用はアプリ側で決めます。

上限は 5,000 ノード、深さ 48 段、単一 text 100,000 文字、本文 text 合計 1,000,000 文字、属性 2,048 文字、URL 2,048 文字、CSS 値 256 文字、レスポンシブ指定 12 個です。これらはパース済みオブジェクトの上限です。HTTP リクエスト・ファイルのバイト上限と JSON parse は受け取り側で管理します。

## 検証範囲

対象限定テストで文書契約、入力拒否、文書のコピー、scoped CSS、許可されたレイアウト、registry の props 検証、登録ブロックが初期 HTML に含まれること、React `renderToString` と共通 HTML helper の一致を確認します。

実際の Next.js / Astro アプリでの bundling・hydration・CSP・サイト全体 CSS の視覚確認は利用側の導入時に行います。nonce を必須とする CSP を使うサイトでは、現在のインライン style の配信方法を導入前に調整する必要があります。
