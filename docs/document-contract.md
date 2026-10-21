# 文書・描画契約 v1

## 責務と信頼境界

このパッケージは公開用の文書と描画を共有します。管理 UI、保存先、認証・認可、サイトの公開状態、ドメインの所有確認、予約ドメインの業務処理は利用側が所有します。サイトの選択や認可済み revision の決定はこのパッケージを呼ぶ前に完了させます。

入力 JSON は信頼しません。runtime で全体を検証して新しい文書へコピーし、未知フィールドも拒否します。TypeScript の型アサーションを検証の代わりにしません。registry とその React コンポーネントは利用側の信頼できるコードです。registry 内での raw HTML、外部通信、認可、業務判断をこのパッケージが安全化することはできません。

## 文書の識別と互換性

必須項目は `schemaVersion: 1`、`siteId`、`pageId`、`locale`、`revision`、`title`、`tokens`、`body` です。サイト・ページ・ノード・ブロックの ID は英字で始まる英数字・`_`・`-` で最大 80 文字、locale は `ja` / `ja-JP` 等、revision は 1 以上の safe integer とします。title は空白以外を含む 300 文字以内です。任意項目 `meta` にページの公開メタ情報（説明文・OG画像・favicon・noindex・構造化データの ID）を持てます。値の規則と描画側の使い方は [ページ管理・公開情報の契約](page-contract.md) を正とします。`meta` は本文と同じ revision に属し、内容を変えたら revision を増やします。任意項目 `textStyles`（文字スタイル）は下の「文字スタイル」の節を正とします。

文書契約の非互換変更は `schemaVersion` を上げ、移行処理を明示してから導入します。未知版の暗黙変換は行いません。既存の鎌倉サイトの文書を直接受け入れる形式ではありません。移行時には現行の HTML / CSS を新しい許可リストに対応付ける adapter と視覚確認が必要です。

token の `label`、`textStyles`、node style の `textStyle`、文字の見た目プロパティ（`fontStyle` / `textDecorationLine`）、辺ごとの枠線幅（`borderTopWidth` / `borderRightWidth` / `borderBottomWidth` / `borderLeftWidth`）は v1 への後方互換な追加で、`schemaVersion` は 1 のままです。入力に無いキーは出力にも付けないため、既存文書の検証結果・直列化・fingerprint・CSS は変わりません。これらのキーを含む文書は、追加前のパッケージでは未知フィールドとして拒否されます。ホストは保存・公開側の検証も新しい commit SHA へ更新してから、新しい編集機能を使ってください。

`siteId/pageId/locale/revision` の組が公開内容を一意に表します。同じ組の内容を変更すると同一 scope の CSS が競合するため、内容更新時は必ず revision を増やします。scope は各値を長さ付きで連結して生成し、他ページ・サイト・revision と衝突しない形にします。`pageScope` は検証済みの ID を持つ文書に対して使います。

## ノード

| type | 内容 | 制約 |
| --- | --- | --- |
| `text` | `text` | HTML として解釈せず React が escape |
| `element` | `id`, `tag`, `attrs?`, `style?`, `children` | 安全な HTML タグ・属性のみ。子配列は必須 |
| `component` | `id`, `block`, `props`, `style?`, `slots?` | 登録済み名・許可された primitive props のみ。独自の children は持たない。`slots` は registry が宣言した表示領域ごとの見た目（[業務ブロックの表示領域契約](block-slot-contract.md)） |
| `instance` | `id`, `component`, `props?`, `style?` | 下書きだけで使う共通部品の参照。部品ライブラリを渡した検証でだけ受け付け、公開前に通常の element へ展開する（[共通部品契約](component-contract.md)） |

element / component / instance の `id` は文書全体で一意です。element の `attrs.id` は別の HTML ID として同一文書内の重複を拒否します。リンクの `#id` と ARIA の参照先は利用側で揃えます。HTML ID はブラウザ全体の名前空間なので、複数文書を同じページへ置く利用側は document 間でも一意にします。

タグは `src/types.ts` の `ElementTag`、属性は `src/document.ts` の許可リストを正とします。`a.href` は HTTPS・サイト内パス・同一文書内アンカーに加えて、安全な `mailto:` と `tel:` を許可します。メール宛先は単一の ASCII メールアドレス、query は重複のない `subject` / `body` のみです。電話番号は数字と `+ ( ) . -` のみを使い、空白・制御文字・改行・バックスラッシュ・危険な scheme は拒否します。mailto の subject / body では通常の空白をパーセントエンコードできます。`img` は安全な `src` か素材参照 `asset: { provider, id }` のどちらか一方と、`alt` が必須です。空の alt は装飾画像として許可します。素材参照の URL は描画時にホストの解決済み map から決め、解決できない画像は描画しません（[素材ライブラリ契約](asset-contract.md)）。`a[target=_blank]` には `noopener noreferrer` を描画時に補います。`source.srcSet` は単一 URL のみを許可します。開閉の `details` / `summary` は JS なしで動く部品として許可し、`summary` は `details` の最初の子だけに置けます（1 つまで。中にリンクや入れ子の開閉は置けません）。`details` の `open` は真偽値です。複数候補の srcset、SVG、iframe、form、script、style、イベント属性は v1 の対象外です。

`p` や見出しなどの phrasing content の中への block element、入れ子のリンク、void element の子、不正な list / picture の子を拒否し、初期 HTML をブラウザが組み替えて hydration と食い違うことを防ぎます。ブロックは `<div data-nw-node="…" data-nw-block="…">` に包むため、flow content の中だけで利用できます。ブロック自身が返す HTML の妥当性は利用側で保証します。

## トークンと style

tokens は最大 128 件です。名前は小文字英字から始まる英数字・`-` とし、`color` / `length` / `fontFamily` / `number` の型を持ちます。任意の `label` は編集画面の表示名で、前後の空白を除いて 1 文字以上・60 文字以内、制御文字を含みません。CSS には出力しません。`{ token: 'ink' }` は定義済みかつプロパティと型が一致し、解決した値自体もそのプロパティに適合するときだけ使えます。token value から別 token への参照はできません。

`color` は HEX（3/4/6/8桁）と限定した基本色名、`length` は 0 または px / rem / em / % / vh / vw / vmin / vmax / ch、`fontFamily` は引用符を要しない名前のカンマ区切り、`number` は有限数です。幅・高さ・最小幅・最大幅に限り、`calc(<数値>% ± <数値>px)` の形も使えます（割合は 1,000 以下、px は 10,000 以下）。細かい値の正は `src/style-values.ts` の検証です。`rgb()`、`hsl()`、任意の `calc()`、カスタム CSS 変数、任意の selector・擬似クラス・擬似要素、任意のアニメーション・`transform` 文字列は v1 に含めません。状態（hover・focus・active）、変形、遷移、登場、幅別の非表示は下の「演出」の範囲だけを許可します。画像 URL は style に直接書けません。背景画像は `backgroundImage: { asset: { provider, id } }` の素材参照だけを受け付け、解決済みの安全な URL から `background-image:url("…")` を生成します。未解決の背景画像は宣言を出しません。`backgroundSize` / `backgroundPosition` / `backgroundRepeat` は列挙値です。

枠線幅は `borderWidth` で四辺共通の幅を指定し、`borderTopWidth` / `borderRightWidth` / `borderBottomWidth` / `borderLeftWidth` で各辺を上書きできます。辺ごとの指定は、同じ段の共通指定より優先します。各プロパティは非負の長さまたは `length` token を受け付け、幅の上限は他の長さと同じです。生の CSS 値は保存しません。

表示を壊す過大値は拒否します。長さの上限は px が 10,000、rem / em / ch が 1,000、% / vh / vw / vmin / vmax が 1,000 です（負値は絶対値で判定）。数値だけの指定（px として扱うプロパティ）と length token も同じ上限です。`zIndex` は `auto` か絶対値 9,999 以下の整数です。

文字の見た目には次の閉じた値を使えます。

| プロパティ | 値 |
| --- | --- |
| `fontStyle` | `normal` / `italic` |
| `textDecorationLine` | `none` / `underline` / `line-through` |


node の `style` は `base` と `responsive` の宣言を持ちます。base を先に、続いて minWidth 昇順の `@media` を生成します。Grid はトラック列と限定した `repeat()` / `minmax()` に対応します。生の selector や CSS ファイルを JSON から読み込みません。CSS と token 変数は文書の `data-nw-scope` の下だけに出力し、ノードごとの `data-nw-owner` でも所属を限定するため、入れ子の別文書へ同じノード ID のルールが漏れません。ノードへ任意 class / style / data 属性を付ける入口は設けません。

## 文字スタイル

`textStyles` は名前付きの文字の見た目（STUDIO のテキストスタイル相当）で、最大 64 件です。名前は token と同じ規則です。各スタイルは任意の `label`、必須の `base`、任意の `responsive` を持ちます。使えるプロパティは `fontFamily` / `fontSize` / `fontWeight` / `lineHeight` / `letterSpacing` / `fontStyle` / `textDecorationLine` だけです。色は含めず、カラーの token で共通化します。値・token 参照の型と解決値の検証、`responsive` の規則（320〜3840px、昇順、重複なし、最大 12 個）は node style と同じです。

```json
{
  "textStyles": {
    "heading": { "label": "見出し", "base": { "fontSize": 28, "fontWeight": 700 }, "responsive": [{ "minWidth": 768, "declarations": { "fontSize": 40 } }] }
  },
  "body": [{ "type": "element", "id": "title", "tag": "h1", "style": { "textStyle": "heading", "base": { "color": { "token": "ink" } } }, "children": [] }]
}
```

element と component の `style.textStyle` には存在する textStyles のキーだけを指定できます。CSS は token 変数 → box-sizing → 文字スタイル → ノード個別の順に出力します。文字スタイルは使われているものだけ、利用ノードの selector をカンマで束ねて base → `@media` 昇順で出力し、未使用のスタイルは出力しません。selector はノード規則と同じ `[data-nw-scope] [data-nw-owner][data-nw-node]` で詳細度が等しいため、後に出るノード個別の指定が全幅で文字スタイルより優先します。HTML の出力（data 属性）は変わりません。

## 演出（状態・変形・遷移・登場・幅別の表示）

公開 HTML は JS なしで内容と操作がすべて見える・使える状態で返し、初期表示で内容を隠しません。動きはすべて `@media (prefers-reduced-motion:no-preference)` の中だけ、hover は `@media (hover:hover)` の中だけに出力します。

| 項目 | 文書 | 値 |
| --- | --- | --- |
| 変形 | `translate` / `rotate` / `scale` / `skew` / `transformOrigin`（base・responsive） | 移動は長さ 1〜2 個（px は ±1000、rem/em は ±64、% と vw/vh は ±100。数値は px）、回転は ±360deg（数値は deg）、拡大・縮小は 0〜5 の数 1〜2 個、傾きは ±180deg（数値は deg、2 軸は空白区切り）、原点は `left top` … `right bottom` と `center` の 9 値 |
| 遷移 | `transitionDuration` / `transitionDelay` / `transitionTimingFunction` | 0〜5s（`ms` 可、数値は ms）と `ease` `ease-in` `ease-out` `ease-in-out` `linear` |
| 状態 | `style.states.hover` / `focus` / `active` | `color` `backgroundColor` `borderColor` `opacity` `textDecorationLine` `translate` `rotate` `scale` `skew` だけ（color token 参照可） |
| 登場 | `style.appear` | `effect`（`fade` `fade-up` `fade-down` `fade-left` `fade-right` `zoom`）、`trigger`（`load` / `view`）、`duration` 100〜3000ms、`delay` 0〜3000ms、任意の `easing` |
| 幅別の非表示 | `style.hidden` | `{ minWidth, maxWidth? }` の配列。minWidth は 0 か 320〜3840、maxWidth はその範囲の最後の幅（含む）で minWidth より大きい整数。昇順・重なりなし・最大 12 |
| 横スクロール | `overflowX` / `scrollSnapType` / `scrollSnapAlign` | `visible` `hidden` `auto` `scroll` / `none` `x mandatory` `x proximity` / `none` `start` `center` `end` |

CSS はノード規則の後に、状態 → 遷移 → 登場 → 幅別の非表示の順で出力します。hover は `@media (hover:hover){<sel>:hover{…}}`、focus はキーボード操作で必ず見える `<sel>:focus-visible{…}`、active は `<sel>:active{…}` です。`skew` は制限済み角度から `transform:skew(...)` を生成し、任意の transform 文字列は受け付けません。`transition-property` は文書に持たせず、そのノードの状態で使うプロパティ（`color` `background-color` `border-color` `opacity` `translate` `rotate` `scale` `transform` `text-decoration-color`）から生成します。状態スタイルの無いノードの遷移の指定は出力しません。

登場の keyframes は文書 scope 付きの固定名（`<scope>-fade-up` 等）で、使われた効果だけを出力します。内容は動き始めの opacity と translate / scale だけで、レイアウトはずれません。`load` は `animation:<name> <duration>ms <easing> <delay>ms both`、`view` はさらに `@supports (animation-timeline: view())` の中で `animation-timeline:view(); animation-range:entry 0% entry 60%`（時間は auto、遅れは使わない）です。動きを減らす設定の利用者と未対応のブラウザでは animation 自体を適用しないため、内容はそのまま見えます。

幅別の非表示は全ノード規則の最後に `@media (min-width:Apx) and (max-width:B.98px){<sel>{display:none}}`（minWidth 0 は min を省く、maxWidth が無ければ max を省く）として出力し、表示用の display を戻す規則は持ちません。業務ブロックの表示領域（`slots`）の style では `states` / `appear` / `hidden` / `textStyle` を受け付けません。共通部品のインスタンスの style では同じキーを使え、root の指定に重ねます（状態はプロパティ単位、登場と非表示は丸ごと置き換え）。

scope はページ間の CSS selector の衝突を避けるもので、Shadow DOM のような完全な隔離ではありません。ホストサイトの global CSS、継承、登録ブロックの CSS は描画に影響します。外側のサイトで必要な reset と視覚確認を行ってください。同じ文書の重複表示は同じ style が複数出ることがあります。

## 動的ブロック

`BlockRegistry` の各エントリは `props` 契約と React `component` を持ちます。JSON に実装コード、ファイル名、import path、実行式を保存しません。登録されていても props の許可リスト外の値は渡しません。props の名前は信頼できる registry 側で定義し、React の特殊 props や `on…` は拒否します。

`string` の上限は最大 4,096 文字、`url` は安全な公開 URL、`number` は有限数と任意の min/max、`boolean` は真偽値、`enum` は指定値の文字列です。必須かどうかは `required` で明示します。文字列 prop を URL に使う設計は避け、URL prop を宣言します。props に文書からオブジェクトや配列は渡せません。複雑なデータは公開 ID を渡してアプリの adapter へ接続します。

renderer は同期の React ツリーを返します。データ取得は呼び出し前に利用側で完了させ、データを閉じ込めた同期 component を registry に置く構成を推奨します。Astro の静的 HTML helper は hydration 情報を含みません。Next.js の Client Component や Astro island を利用する場合は利用側がフレームワークの規約に合わせて wrapper を定義します。未知ブロックを静かに空欄にする fallback はありません。

## エラーとリソース上限

無効入力は `DocumentValidationError` で止め、`path` に原因の位置を返します。実際の入力値はエラー文へ埋め込みません。描画 API と CSS API は毎回検証し、無効文書の途中までを公開しません。登録コンポーネント自身が投げる例外は呼び出し側へ伝わります。ページ配信時のエラーページ・直前の公開 revision の利用はアプリ側で決めます。

上限は 5,000 ノード、深さ 48 段、単一 text 100,000 文字、本文 text 合計 1,000,000 文字、属性 2,048 文字、URL 2,048 文字、CSS 値 256 文字、レスポンシブ指定 12 個、幅別の非表示 12 個、token 128 件、文字スタイル 64 件です。これらはパース済みオブジェクトの上限です。HTTP リクエスト・ファイルのバイト上限と JSON parse は受け取り側で管理します。

## 検証範囲

対象限定テストで文書契約、入力拒否、文書のコピー、scoped CSS、許可されたレイアウト、文字スタイルの CSS の順序と束ね方、過大値の上限、演出の値の境界と CSS の出力位置（hover・focus-visible・reduced-motion・`@supports`・非表示が最後）、開閉の入れ子、旧文書の出力が変わらないこと、registry の props 検証、登録ブロックが初期 HTML に含まれること、React `renderToString` と共通 HTML helper の一致を確認します。

実際の Next.js / Astro アプリでの bundling・hydration・CSP・サイト全体 CSS の視覚確認は利用側の導入時に行います。nonce を必須とする CSP を使うサイトでは、現在のインライン style の配信方法を導入前に調整する必要があります。

## サイト共通スタイル

ページ JSON の `schemaVersion` と必須フィールドは変更しません。`SiteSettings` に任意の `tokens` / `textStyles` を保存し、ページにはページ所有の定義だけを保持します。設定を渡さない既存ホストの検証・描画は従来どおりです。

```ts
const settings = parseSiteSettings(siteSettingsJson);
const page = parsePageDocument(pageJson, blocks, { siteStyles: settings });
// page.tokens / page.textStyles は入力に含まれていたページ定義だけ。
const effective = resolvePageStyles(page, settings);
// 部品があるページは展開時にも同じ設定を渡す。
const resolved = resolvePageDocument(pageJson, library, blocks, settings);
```

優先順位は、token と文字スタイルそれぞれについて `site → page` です。同名の定義はページが丸ごと上書きします。文字スタイルのプロパティ単位の合成はしません。共有定義と同じ値でも、明示されたページの override は保持し、将来のサイト変更から独立させます。

サイトの文字スタイルはサイトの token だけで検証し、ページによる未定義参照の補完を許しません。その後、実効 token で継承した文字スタイルを再検証します。ページの override によって token の種類が不適合になった場合も拒否します。未解決の token / textStyle、型不一致、未知フィールド、上限超過を許しません。共有値を参照するページは、設定を省略して検証すると拒否されます。

`PageRenderer` の `siteStyles`、`renderPageToHtml(document, blocks, { siteStyles })`、`generatePageCss(document, blocks, assets, siteStyles)` は同じ解決関数を使います。`resolvePageDocument` の返す展開済み文書には実効定義が含まれるため、そのまま設定なしで描画できます。この展開済み文書をページ下書きの正本へ保存しないでください。公開 snapshot に実効定義を固定する方式はホストが選べます。

共有設定とページを別時点から取得すると公開中の見た目が変わるため、ホストは同じ公開 snapshot の設定・文書を組にして読み出してください。キャッシュキーにも設定の版を含めます。
