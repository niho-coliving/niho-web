# 共通部品契約 v1

スタッフがページの一部を「共通部品」として登録し、複数のページ・テンプレート・共通枠で再利用するための契約です。部品の定義はサイトごとの部品ライブラリに置き、文書からは `instance` ノードで参照します。

| 用語 | 文書上の形 | 所有者 |
| --- | --- | --- |
| 共通部品 | 部品ライブラリの `components[]` | スタッフがエディターで作成・編集する |
| インスタンス | `{ type: "instance", component }` ノード | ページ・テンプレート・共通枠の文書 |
| 業務ブロック | `{ type: "component", block }` ノード | ホストの registry（従来どおり別種） |

部品はスタッフが組んだ要素の部分木で、実行コード・HTML・任意 CSS を持ちません。業務ブロックを部品の中へ置くことはできますが、価格・在庫・予約・決済・フォーム送信は引き続きホストの registry と API が正本です。

## 公開の考え方

部品は**公開時に展開**します。下書き文書はインスタンスを含みますが、ホストは公開する前に `resolvePageDocument` で通常の element へ展開し、展開済みの v1 文書を公開版として保存します。公開 API・SSR・Astro の静的 HTML は今までどおり部品を含まない文書だけを受け取るため、公開側の renderer を更新しなくても導入できます。

- 部品を更新すると、その部品を使う各文書の**プレビューと公開差分**に反映されます。公開済みのページは、その文書を公開するまで変わりません。
- サイト全体のヘッダー・フッターは、共通枠の文書（Experience の `chrome` 等）に部品を置きます。ホストは従来どおり共通枠を各ページの外側に描画するため、共通枠を1回公開すれば全ページへ反映されます。
- 一覧・詳細テンプレート（Experience の `experience-detail` 等）に置いた部品も同様に、テンプレートを公開した時点で全件へ反映されます。
- 展開結果は下書きと内容が異なるため、ホストは公開版を**新しい revision** で保存します。同じ site/page/locale/revision に異なる内容を割り当てないという文書契約は変わりません。

## 部品ライブラリ

```ts
type ComponentLibrary = {
  schemaVersion: 1;
  siteId: string;
  revision: number;
  tokens: Record<string, DesignToken>;
  components: ComponentDefinition[];
};
type ComponentDefinition = {
  id: string;
  name: string;
  kind: "header" | "footer" | "navigation" | "section" | "part";
  version: number;
  root: ElementNode;
  props?: Record<string, ComponentPropDefinition>;
};
type ComponentPropDefinition = {
  label: string;
  node: string;
  field: "text" | "href" | "src" | "alt";
};
```

- ライブラリは1サイトに1つです。`siteId` が文書と一致しないライブラリは使えません（他サイトの部品を拒否）。`revision` はページ文書と同じくホストが保存時に採番する正の safe integer です。
- `id` は文書の ID と同じ規則（英字開始、英数字・`_`・`-`、最大80文字）で、ライブラリ内で一意です。`name` は空白だけにできない80文字以内で、ライブラリ内で重複できません。`kind` は一覧の分類と共通枠での使い分けに使う表示用の種類です。
- `version` は定義を変更するたびに増える正の safe integer です。エディターは保存時に、保存済みの定義と内容が異なる部品だけを +1 します。ホストは保存時に version が減っていないことを検証します。
- `root` は1つの element です。中身は文書と同じノード規則（タグ・属性・style・業務ブロックの props 契約・HTML の入れ子）で検証します。ノード ID は部品の中で一意、HTML の `attrs.id` も部品の中で一意です。
- 部品の中に別の部品のインスタンスを置けます。参照先は同じライブラリ内に限り、循環参照と4段を超える入れ子を拒否します。
- `tokens` は部品の style が参照するデザイントークンです。形式と上限はページ文書の tokens と同じです。
- 上限は部品200件、ライブラリ全体のノード5,000件、部品ごとの公開 props 32件です。

### インスタンスごとに変えられる値（公開 props）

部品の作成者は、部品内の特定の値を「ページごとに変えられる値」として公開できます。公開していない値はすべて部品の共通値です。

| field | 対象ノード | 値 |
| --- | --- | --- |
| `text` | 子が空、または文字1つだけの element（void・`ul`/`ol`/`dl`/`picture` を除く） | 4,096文字以内の文字列。空文字は文字なし |
| `href` | `a` | 安全な公開 URL |
| `src` | URL で指定した `img`（素材ライブラリの `asset` を使う画像は不可） | 安全な公開 URL |
| `alt` | `img` | 2,048文字以内の文字列（空は装飾画像） |

- props の名前は ID 規則に従い、`constructor` / `prototype` 等の予約名を拒否します。`label` はスタッフに見せる40文字以内の名前です。
- `node` は部品の `root` 自身または子孫の element を指します。入れ子にした別部品の内部は指せません。同じノード・同じ field を2つの props で公開できません。
- 業務ブロックの props は公開できません。業務ブロックの表示 props は部品の共通値として編集し、データ連動値（registry の `lockedProps`）は従来どおりホストが管理します。

## インスタンス

```ts
type InstanceNode = {
  type: "instance";
  id: string;
  component: string;
  props?: Record<string, string>;
  style?: NodeStyle;
};
```

- `component` は同じサイトのライブラリにある部品の `id` です。消えた参照は検証で拒否します。
- `props` はこのインスタンスだけの値です。部品が公開している props の名前だけを適用し、値はその field の規則で検証します。キーは最大64件です。
- 部品側で公開をやめた props の値は**適用せずに保持**します（エディターは「使われなくなった値」として表示し、整理できます）。部品の版を戻したときに値が戻るためです。値自体は4,096文字以内の文字列として検証します。
- `style` はインスタンスの外枠（部品の `root`）だけに重ねる見た目です。base と幅別の指定をプロパティ単位で部品の値へ上書きします。部品の内側の見た目は部品の編集で変更します。
- インスタンスを含む文書は、ライブラリを渡した検証（`parsePageDocument(input, blocks, { components })`）でだけ受け付けます。ライブラリなしの検証・`PageRenderer`・CSS 生成はインスタンスを拒否するため、未展開の下書きを誤って公開描画できません。

## 展開の規則

`resolvePageDocument(document, library, blocks)` は、インスタンスを部品の `root` の複製へ置き換えた v1 文書と、展開したノードの出所を返します。

1. 公開 props の値を対象ノードへ適用し、インスタンスの `style` を root の style へ重ねます。
2. 展開した root は**インスタンスの ID** を引き継ぎます。内側のノード ID は `<インスタンスID>--<部品内のノードID>` にし、入れ子の部品は同じ規則で連結します。連結後の ID が80文字を超える場合は拒否します。部品内の ID は短く保ってください（エディターは `n1`, `n2`… を振ります）。ライブラリの検証では各部品を ID `preview` のインスタンスとして展開して長さを確かめます。
3. HTML の `attrs.id` は付け替えません。ページ内リンク（`#footer` 等）と ARIA 参照を保つためです。HTML ID を持つ部品を同じ文書へ2回置くと、HTML ID の重複として拒否します。
4. tokens は部品ライブラリの値に文書の値を重ねます（同名なら文書が優先）。合計128件を超える場合は拒否します。
5. 展開結果を通常の文書検証へ通します。入れ子規則（段落の中の block 要素、リンクの入れ子、リストの子など）・ID 重複・業務ブロックの props も展開後の形で検証します。

展開結果の ID は部品の構造とインスタンス ID だけで決まるため、同じ入力からは常に同じ HTML と CSS が生成されます。

## 編集操作

| 操作 | 文書 | ライブラリ | 規則 |
| --- | --- | --- | --- |
| 部品にする | 選択した element をインスタンスに置換（ID は維持） | 部分木を新しい部品として追加 | ページ固有のロックを含む部分木は不可。参照している tokens をライブラリへ写す |
| 配置 | インスタンスを追加 | なし | ホストが追加を許可していない業務ブロックを含む部品は配置できない |
| ページごとの値 | インスタンスの `props` を設定・解除 | なし | 公開 props の規則で検証 |
| 外枠の見た目 | インスタンスの `style` を変更 | なし | 通常の style 規則 |
| 部品を解除 | インスタンスを展開した element に置換 | なし | 以後は部品の更新を受けない。中の別部品はインスタンスのまま残す |
| 部品を編集 | なし | 部品の `root` / `props` / 名前・種類を変更 | 公開 props の対象ノードは、先に公開をやめないと削除・変更できない。自分自身を含む部品は循環として拒否 |
| 複製・名称変更 | なし | 部品を追加・変更 | 名前は一意 |
| 削除 | なし | 部品を削除 | どの文書・部品からも参照されていない場合だけ |

部品を解除したノードは、新しいページ内 ID（重複時は `_copy1` 等の接尾辞）を持つ通常の element になり、公開 props とインスタンスの style は適用済みの値として残ります。

## エディターとホストの接続

部品の読込・保存・使用状況は `EditorAdapter` の任意フィールド `components` で接続します。省略したホストの動作は変わりません。

```ts
interface EditorComponentAdapter {
  readLibrary(siteId: string, signal: AbortSignal): Promise<{ library: unknown; version: string }>;
  saveLibrary(request: { siteId: string; library: ComponentLibrary; expectedVersion: string }, signal: AbortSignal): Promise<EditorSaveResult>;
  listUsage(siteId: string, signal: AbortSignal): Promise<readonly ComponentUsageEntry[]>;
}
type ComponentUsageEntry = {
  target: EditorTarget;
  title: string;
  role?: "page" | "template" | "frame";
  /** template / frame の場合、その文書と一緒に表示される公開ページ数。 */
  reach?: number;
  /** 部品 ID ごとのインスタンス数（入れ子の部品経由を含む）。 */
  components: Readonly<Record<string, number>>;
};
```

- `readLibrary` は opaque な楽観ロック値 `version` と検証前のライブラリを返します。ライブラリがまだないサイトでは `revision: 1`、`components: []` の空ライブラリを返してください。
- `saveLibrary` はページの下書き保存と同じく、`expectedVersion` の比較・revision の採番・409 の `{ status: "conflict" }` 変換をホストが原子的に行います。ホストは保存前に `parseComponentLibrary` で検証し、削除された部品をどの文書（下書き・公開版）も参照していないこと、各部品の version が減っていないことを確認してください。
- `listUsage` は保存済みの下書きを対象にした使用状況です。ホストは各文書へ `componentUsage(document, library)` を使って集計できます。
- 部品の中の素材（`img` の `asset`・背景画像）と内部リンクは、ページの文書ではなくライブラリにあります。素材の使用状況・削除の可否には `componentAssetReferences(library)` を含めてください。ページのパス変更では `findComponentLinks` / `findInstanceLinks` を影響に含め、`rewriteComponentLinks`（変わった部品の version を上げる）と `rewriteInstanceLinks`（インスタンスのページごとのリンク先）で書き換えます（[ページ契約](page-contract.md)）。
- インスタンスを含む下書きの保存（`saveDraft`）では、ホストはライブラリを渡して `parsePageDocument` で検証してください。
- 公開確認の要求（`EditorReleaseRequest`）の `componentsVersion` は、確認時に表示していたライブラリの version です。ホストは差分を展開済みの文書で計算し、確認 token をページの version とライブラリの version の両方に結び付け、`release` 時にどちらかが変わっていれば 409 を返します。plan は要求と同じ `componentsVersion` を返してください。公開版には展開済みの文書を新しい revision で保存します。
- 部品とページを続けて保存する場合は部品 → ページの順にします。部品の保存だけが成功しても、未使用の部品が増えるだけで文書は壊れません。

## 業務ブロックとの境界

- 部品の中の業務ブロックは、配置先の文書と同じ registry の props 契約で検証します。registry のデータ連動値のロックは、部品の編集中も同じブロックへ適用されます。
- ページ固有のロック（snapshot の `locks`）を含む部分木は部品にできません。ロックはページのノード ID に結び付いているためです。
- `insertableBlocks` で追加を制限しているホストでは、制限外の業務ブロックを含む部品を新しく配置できません。既存インスタンスの表示と編集は維持します。ホストは保存 API でもページごとの配置条件を検証してください。

## 互換性

- `schemaVersion` は 1 のままです。インスタンスを含まない文書の検証・描画・CSS は変わりません。
- TypeScript の `PageNode` に `InstanceNode` が加わります。`node.type` を網羅的に分岐している利用側のコードには instance の分岐が必要です。公開版の文書に instance は現れません。
- 部品の解除で、文書にないライブラリの token は値として埋め込みます。文書へ token を写すと、同じ文書の他のインスタンスがライブラリの token の変更を受けなくなるためです。
- 公開版は展開済みの v1 文書なので、古い版の `@niho/web` を固定した公開サイトでもそのまま描画できます。インスタンスを含む下書きを古い renderer に渡した場合は `unknown node type` で止まり、途中までを公開しません。
- ライブラリに未知のフィールド、未知の版、他サイトの `siteId` があれば拒否します。暗黙の移行はしません。
