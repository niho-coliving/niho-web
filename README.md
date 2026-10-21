# niho-web

公開ページの JSON 文書、入力検証、scoped CSS、React / HTML renderer を共有する TypeScript パッケージです。Astro と Next.js が同じ文書を描画できます。React renderer は本文と登録済みブロックをサーバーで描画し、初期 HTML に含めます。

このリポジトリには公開可能な文書契約と描画処理を置きます。認証情報、管理 API、サイトの非公開データ、価格・在庫・予約の判断処理は利用側が所有します。

ソースは公開されていますが、第三者への再利用ライセンスは付与していません（`UNLICENSED`）。

## 利用開始

Node.js 22 以上が必要です。React renderer には React 18.3 または 19、HTML helper には同じ版の React DOM を利用側で用意します。検証・CSS の `@niho/web/core` だけを利用する場合は React を必要としません。npm 公開前でも、リポジトリ直下を Git dependency として利用できます。利用先ではレビュー済みの commit SHA に固定してください。

```json
{
  "dependencies": {
    "@niho/web": "github:niho-coliving/niho-web#<reviewed-commit-sha>",
    "react": "^18.3.0 || ^19.0.0",
    "react-dom": "^18.3.0 || ^19.0.0"
  }
}
```

Git からのインストール時は `prepare` が TypeScript をビルドします。パッケージの公開範囲は `dist/`、設計文書、公開サンプルです。共有されたクライアント側コードへ秘密を渡さないでください。

| 入口 | 用途 |
| --- | --- |
| `@niho/web` | JSON 型、`validateDocument` / `parsePageDocument`、CSS、React SSR に使える `PageRenderer` |
| `@niho/web/core` | 検証・文書型・CSS・共通部品の検証と展開だけの入口。React の runtime import を含みません |
| `@niho/web/react` | `PageRenderer` とブロック registry の型 |
| `@niho/web/server` | Astro の build / server で使える `renderPageToHtml` |
| `@niho/web/editor` | 認証済みホストadapterへ接続する `PageEditor` と型。React / React DOM が必要 |
| `@niho/web/projects` | 1 Project = 1 Site の検証、純粋操作、atomic CAS契約。React不要 |
| `@niho/web/project-manager` | 認証済みホストadapterへ接続する `ProjectManager`。React / React DOM が必要 |
| `@niho/web/project-directory` | 管理フォームと独立した日常の `ProjectDirectory`。名前・ドメイン検索、更新順、サイトプレビュー、Dashboard / Editor導線 |
| `@niho/web/project-dashboard` | 選択した1 Project・1 Siteに固定した `ProjectDashboard`。公開状況・変更履歴・アクセス解析・設定導線 |
| `@niho/web/project-read-model` | summary / dashboardの型・読み取りadapter・runtime parser。React不要 |
| `@niho/web/project-editor` | 既存 `EditorAdapter` をProjectの唯一のSiteへ限定するwrapper |
| `@niho/web/pages` | ページのパス検証・ツリー・内部リンク影響、公開メタ情報（title / description / OG画像 / robots / canonical）の解決と `<head>` 出力。React不要 |
| `@niho/web/site-analytics` | GA4 / Search Console の接続状態・所有確認・変更計画の型と境界検証。React不要 |
| `@niho/web/assets` | 素材参照の列挙・解決済み素材 map の検証、素材ライブラリ adapter の型と応答検証。React不要 |
| `@niho/web/history` | 文書の差分（`diffDocuments`）、版履歴の項目の検証、端末内の緊急復元ストア（ページ・サイトごとの共通部品）。React不要 |
| `@niho/web/analytics` | GA4 / Search Console を分けて示す読取専用画面、型付きadapter、応答検証 |
| `@niho/web/localization` | 明示的な日英設定、安定IDの翻訳単位、候補・手編集・確認、共通構造からの文書生成。React不要 |
| `@niho/web/localization-release` | 言語単位の不変snapshot、route・内部リンク・SEO、prepare/apply/rollback検証。React不要 |

React は optional peer dependency です。API サーバーなど React を入れない利用先では `import { parsePageDocument } from '@niho/web/core'` を使います。root と `/react` は React runtime を import します。

多言語coreは共通構造を保ったまま、明示的な `sourceLocale` とlocale mapping、安定IDの翻訳単位、非同期candidate、手編集、確認、target文書生成を扱います。翻訳provider・認可・永続化・公開snapshotはホスト責務です。詳細は [多言語core契約](docs/localization-contract.md) を参照してください。

言語別公開は `@niho/web/localization-release` で、ページ・共通部品・ナビ・スタイル・外部resource hash・route・SEOを1つの完成版として検証します。token、認可、永続化、CAS、CDNと実サイト描画はhostが所有します。詳細は [言語別公開・ルート・SEO契約](docs/localization-release.md) を参照してください。

## 文書の形

```ts
import { parsePageDocument, type PageDocument } from '@niho/web';

const document: PageDocument = {
  schemaVersion: 1,
  siteId: 'demo',
  pageId: 'home',
  locale: 'ja-JP',
  revision: 1,
  title: '海のそばで過ごす',
  tokens: {
    ink: { type: 'color', value: '#172d25' },
    space: { type: 'length', value: '1.5rem' },
  },
  body: [{
    type: 'element', id: 'intro', tag: 'section',
    style: {
      base: { color: { token: 'ink' }, padding: { token: 'space' } },
      responsive: [{ minWidth: 768, declarations: { maxWidth: '64rem' } }],
    },
    children: [{
      type: 'element', id: 'heading', tag: 'h1',
      children: [{ type: 'text', text: '海のそばで過ごす' }],
    }],
  }],
};

// API・ファイル・ストレージから受け取る値は unknown として検証する。
const checked = parsePageDocument(document);
```

`validateDocument(input, blocks?)` は `parsePageDocument` と同じ検証入口です。検証済みの新しい文書を返し、不正入力には例外を返します。サーバーの JSON 受け取り処理でも利用できます。

[公開サンプル](examples/page.json)にはリンク、トークン、Flex、レスポンシブ指定を含めています。`schemaVersion` は文書契約の版、`revision` はページ内容の更新番号です。同じ site / page / locale / revision の内容は不変として扱い、内容を変えたら revision を増やします。

## Next.js の React renderer

```tsx
// app/page.tsx（Server Component）
import { PageRenderer } from '@niho/web';
import document from './page-document.json';

export default function Page() {
  return <PageRenderer document={document} />;
}
```

`PageRenderer` は `useEffect` やクライアントでの JSON fetch を必要としません。scoped `<style>` と本文の `<div lang="…">` を返します。`title` は文書の情報として保持し、Next.js の `metadata` / Astro の `<head>` へ設定するのは利用側の責務です。読み込む文書を site / page / locale から選ぶ処理も利用側に置きます。

## 登録済み動的ブロック

文書に保存するのは名前と公開 props だけです。利用側のコードに registry と許可する props を定義します。すべてのノードを検証した後にブロックを描画します。未知ブロック、未知 props、型違い、必須値不足はエラーになります。

```tsx
import { PageRenderer, type BlockRegistry } from '@niho/web/react';

const blocks = {
  PublicNotice: {
    props: {
      heading: { type: 'string', required: true, maxLength: 80 },
      href: { type: 'url', required: true },
      tone: { type: 'enum', values: ['info', 'warning'] },
    },
    component: ({ heading, href }) => (
      <aside><a href={String(href)}>{heading}</a></aside>
    ),
  },
} satisfies BlockRegistry;

// body の flow content 内へ追加するノード:
const notice = {
  type: 'component', id: 'notice', block: 'PublicNotice',
  props: { heading: 'お知らせ', href: '/news', tone: 'info' },
};

// PageRenderer document の body に notice を含める。
// <PageRenderer document={document} blocks={blocks} />
```

ブロックの内側の見た目（カードの見出し・画像の収まり・予約ボタンの色など）をスタッフに整えさせる場合は、registry の `slots` で変更できる領域とプロパティを宣言し、ブロックが該当要素へ `data-nw-slot` を付けます。値の正本は props とホストのデータのままです。詳細は [業務ブロックの表示領域契約](docs/block-slot-contract.md) を参照してください。

props 契約は `string` / `url` / `number` / `boolean` / `enum` です。入れ子のオブジェクト、配列、関数、React の特殊 props、イベント props を文書から渡せません。URL に使う prop には `url` を指定します。既存の型付きコンポーネントへ接続するときは registry の小さな adapter で props を渡してください。

registry は利用側がレビューした信頼できるコードです。文書からモジュールや JS を取得しません。ブロックは同期描画できるよう、必要な公開データを利用側で取得してから接続します。価格や在庫を表示する場合も、計算・認可・取得元の判断は利用側に置きます。Client Component の接続・hydration は各フレームワークの規則に従います。

## 共通部品

スタッフが組んだ要素の部分木をサイトごとの部品ライブラリへ登録し、文書から `instance` ノードで参照できます。ヘッダー・フッター・セクション見出しなどを複数の文書で共有し、部品を1回更新すると、使っている文書のプレビューと公開差分に反映されます。部品は公開時に通常の element へ展開します。

```ts
import { parseComponentLibrary, parsePageDocument, resolvePageDocument } from '@niho/web/core';

// 下書きの検証。部品ライブラリを渡したときだけ instance を受け付ける。
const library = parseComponentLibrary(rawLibrary, blocks);
const draft = parsePageDocument(rawDraft, blocks, { components: library });

// 公開時は展開済みの文書を、新しい revision の公開版として保存する。
const { document: resolved } = resolvePageDocument(draft, library, blocks);
const published = { ...resolved, revision: nextRevision };
```

`PageRenderer`・`renderPageToHtml`・CSS 生成は展開済みの文書だけを描画し、未展開の instance は拒否します。公開版の形は従来の v1 文書のままなので、公開サイトの renderer を更新しなくても導入できます。詳細は [共通部品契約](docs/component-contract.md) を参照してください。`PageEditor` では、adapter に `components` を渡すと「部品」パネル・インスタンスの設定・部品の編集を使えます（[エディター契約の「共通部品」](docs/editor-contract.md#共通部品)）。

## Astro の静的 / サーバー HTML

```astro
---
import { renderPageToHtml } from '@niho/web/server';
import document from '../content/page-document.json';

const html = renderPageToHtml(document);
---
<html lang={document.locale}>
  <head><title>{document.title}</title></head>
  <body><Fragment set:html={html} /></body>
</html>
```

`set:html` へ渡すのは `renderPageToHtml` の戻り値だけにしてください。JSON 内の本文文字列は React が escape します。この入口は静的 HTML 用です。操作を伴うブロックを hydrate する場合は Astro の React integration を使い、registry を定義したアプリ側 React wrapper を island として配置します。

## 検証と対応範囲

- 未知フィールド、schema の版違い、重複 ID、画像の `alt` 不足、代表的な不正 HTML の入れ子を拒否します。
- HTML タグ・属性・CSS プロパティは許可リスト方式です。任意 HTML / CSS / selector / JavaScript / event handler は扱いません。
- URL は資格情報のない HTTPS、`/` から始まる同一サイト内パス、`#id` に限定します。HTTP、protocol relative、data、javascript、制御文字を含む値を拒否します。
- 色・フォント・寸法・余白・Flex・Grid・位置・画像の収まり等を扱います。名前付きの文字スタイル（`textStyles`）と表示名付きの token で見た目を共通化できます。任意 CSS 関数や `url()` は許可しません。背景画像は素材参照だけを指定でき、`url()` はホストが解決した安全な URL から描画時に生成します。数値の寸法は px、line-height 等の数値プロパティは単位なしです。
- レスポンシブ指定は 320–3840px の `minWidth` を昇順に最大 12 個。DOM ノードは最大 5,000、深さは最大 48 段、本文テキスト合計は最大 1,000,000 文字です。

エラーは `DocumentValidationError` で、`path` に対象位置が入ります。公開 API は描画・CSS 生成時にも入力を検証します。詳細と制約は [文書・描画契約](docs/document-contract.md) を参照してください。

## 開発

スタッフ向けエディターは `@niho/web/editor` の `PageEditor` を使います。左の追加・ページ・レイヤーパネル、中央キャンバスでの直接文字編集とドラッグ配置、右インスペクタ、下書き保存、楽観ロック、公開/rollbackの対象ドメインと差分確認を提供します。[ホスト接続・編集・公開の契約](docs/editor-contract.md)と `npm run demo` のインメモリ動作例を参照してください。

同じ論理ページの日英編集はoptionalな`EditorAdapter.localization`で追加できます。原文言語を明示し、訳文の実キャンバス編集、候補比較・採用・確認、サイト全体の翻訳job状態、サーバー側でも使える共通構造検証を提供します。[多言語エディターのホスト接続](docs/localization-editor.md)と`npm run demo:localization`を参照してください。

ページ一覧（検索・フォルダ・テンプレートと共通枠の区別）、ページの作成・複製・URL変更・公開切替の影響確認、ページ別とサイト共通の公開情報は [ページ管理・公開情報の契約](docs/page-contract.md) を参照してください。公開ページの `<head>` は `@niho/web/pages` の `resolvePageMetadata` で、編集画面と同じ値から作ります。
画像は URL を直接書く代わりに、サイト別の素材ライブラリの素材ID（`{ provider, id }`）で参照できます。`PageEditor` に `assets` adapter を渡すと、素材のアップロード・検索・代替テキスト編集・配置・置き換え・使用中素材の削除防止を使えます。サイトのアップロード素材、NIHO の公開許可済み CMS 画像、ライセンス確認済みストックを出所ごとに分けて、同じパネルから選べます。公開時の URL 解決は `PageRenderer` / `renderPageToHtml` の `assets` で行います。[素材ライブラリ契約](docs/asset-contract.md)を参照してください。

保存状態の表示、任意の自動保存、端末内の緊急復元、409競合の比較、版履歴と復元、公開前レビューは [保存・作業復元・版履歴の契約](docs/save-history-contract.md) を参照してください。

プロジェクト管理は `@niho/web/projects` と `@niho/web/project-manager` を使います。1プロジェクトは唯一のサイトと複数メンバーを持ち、同じメンバーは別プロジェクトにも参加できます。ユーザーIDは数字開始を含む最大128文字のopaque値として扱い、既存Projectの消失やSite差替えを拒否します。権限・ロール・招待・認証・ID採番・本番DB/APIは含まず、認証済みホストのatomic CAS adapterが必要です。[共通プロジェクト契約](docs/project-contract.md)を参照してください。

サイト接続の状態・変更計画は `@niho/web/site-analytics` の `SiteAnalyticsConnectionAdapter` を使います。GA4測定IDとレポート用プロパティID、Search Consoleの所有確認とAPI読取権限は別々の状態です。認証・Google API・保存・サイト公開設定はホスト側の責務です。[サイト分析・接続契約](docs/site-analytics-contract.md)を参照してください。

```sh
npm run demo:projects
```

この動作例は架空メンバーを持つ2プロジェクトの日常一覧、選択した1サイトのDashboard、既存ProjectManagerと `PageEditor` の導線を表示します。表示メタデータは `Project` 正本と分けて読み取りadapterから取得し、未接続の解析・未取得の数値・権限喪失・遅延応答を区別します。[一覧・Dashboardのホスト接続契約](docs/project-views-contract.md)を参照してください。日時・画像・解析値も合成値で、実アカウント、実サイト、本番永続化には接続しません。

サイト分析は `@niho/web/analytics` の `SiteAnalytics` を認証済みホストの読取adapterへ接続します。[サイト分析の契約](docs/analytics-contract.md)と `npm run demo:analytics` の合成データ例を参照してください。

```sh
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

テストは文書検証、拒否すべき URL / 属性 / CSS、レイアウト、スコープ分離、ブロック契約、React SSR と HTML helper の出力を確認します。public GitHub Actions は secrets・外部 API・非公開リポジトリに依存せず同じ確認を実行します。
