# ビルダー接続と第三サイト demo

## trusted integration の追加

Studio の編集対象は `studio/integration-registry.mjs` にコードとして固定登録する。登録値は `projectId`、`siteId`、`aliases`、`environments` だけで、environment には編集画面の suffix と Studio 内 API prefix を指定する。URL、query、API応答から登録やbackend originを増やす機構は持たない。

新しい接続は次の順で追加する。

1. registry に Project、Site、alias、利用する environment を登録する。
2. `studio/integration-entry.tsx` の trusted component map に、共通の `{ project, environment }` propsを受けるEditor componentを登録する。
3. `studio/worker.ts` の trusted worker adapter mapに、そのhostだけのroute許可、membership、署名、上流dispatchを登録する。
4. 対象hostの文書、block、共通部品、素材、公開planを正規validatorで検証する。
5. registry testへcanonical path、alias、environment、API prefix、unknown/mismatch拒否を追加する。

共通 client shell と worker router は site名で分岐しない。HTML pathとAPI prefixはregistry定義から解決し、未知のProject、Site、environment、混線した組合せは `null` として閉じる。API prefixが入れ子の場合は長い登録を優先する。同一Project/Site、alias、同一environment path、同一API prefixの重複はregistry作成時に拒否する。

host adapterには業務上の差異を残す。Kamakuraは許可済みpage ID、catalog/block契約、素材body検証、asset previewとCSPを所有する。Experienceは英語ページ集合、NIHO API署名、STG owner限定を所有する。どちらもD1 membership、同一origin要求、body上限、署名、redirect拒否、応答上限を維持する。

## BuilderDefinition

Studio の両接続は `studio/integration-builder.ts` の同じ定義を `PageEditor` へ渡す。標準挿入はcoreの `standardBuilderDefinition` が正本であり、Studio側へコピーしない。Studio定義は共通の `layoutInsertionPresets` を明示的に追加し、横並び、グリッド、リストを利用可能にする。

業務blockの配置許可はBuilderDefinitionと別である。KamakuraとExperienceは現在 `insertableBlocks=[]` を維持し、保存済み業務blockの安全な表示と、自由な新規配置を区別する。Experienceの表示は引き続き副作用のない業務previewである。

## Atelier Moku demo

`atelier` はKamakuraとExperienceの名称・業務データを含まない第三サイトである。次を1つの操作可能な例に含む。

- 標準項目と横並び・グリッド・リスト
- 独自の「作品カード」挿入
- 条件styleと登場を組み合わせる独自motion宣言
- 検証済み `WorkshopNote` block
- `atelier_signature` 共通部品instance
- ローカルSVG画像
- expectedVersionによる下書き・共通部品のCAS保存
- 対象、文書、block、共通部品、公開確認tokenのserver側検証
- 部品展開後のSSRとscoped CSS

起動する。

```sh
npm run demo:builder
```

既定は `127.0.0.1:4177` だけでlistenする。`PORT` が設定済みの場合はそのportを使う。下書きと共通部品はserver processのメモリに保存するため、ブラウザを再読込しても残り、serverを再起動すると初期化される。`/preview` は現在の下書きを共通部品展開後にSSRする。

## 任意機能と境界

BuilderDefinition、共通部品、業務block、素材、motionは独立した任意機能である。接続しない機能は利用可能に見せない。制作定義が返す部分木、編集操作後の文書、保存要求、SSR入力は既存validatorを通す。保存文書は `schemaVersion: 1` のままで、関数、任意HTML、任意CSS、backend URL、秘密を含めない。

Editor componentとworker adapterはtrusted codeでだけ登録する。公開文書やURLがReact component、service binding、upstream origin、署名keyを選ぶことはできない。新しいhost固有のrouteや権限差はhost adapterへ閉じ、core/editorにsite名の条件を追加しない。

## 対象受入

2026-10-22の対象testでは、第三サイトの挿入、階層移動、Grid配置、条件styleとmotion、undo/redo、CAS保存、再読込、公開plan/token、SSR/CSSを連続して確認した。registry testでは第三siteをfactoryへ追加し、canonical/alias/APIの往復、長いAPI prefixの優先、unknown environment、Project/Site混線、重複定義の拒否を確認する。

```sh
npm run build
node --test test/studio-integration-registry.test.mjs test/atelier-builder-demo.test.mjs
npm run studio:typecheck
npm run studio:build
```

## 実ブラウザ受入（2026-10-22）

第三サイトdemoを最終workspaceで操作し、次を確認した。

- テキスト編集、undo/redo、保存、ブラウザ再読込後の保持。
- 独自の作品カード挿入と `atelier_main` 配下への移動。選択IDと実DOMの親を照合。
- 画像専用タブのURL・レスポンシブURL・説明欄と、対象別のタブ構成。
- 375px幅・50%表示でiframeのCSS幅375px、画面上の幅約188px。文書幅と倍率を分離。
- 条件付き変形Y=-6pxを直接入力し、キャンバスのcomputed styleと保存を確認。
- 2タブのCAS競合で編集内容を保持。比較画面を閉じた後も「比較する」が表示され、最新内容へ復旧可能。
- 左パネルを閉じてもツール列が残り、左右パネルとも復帰可能。390×844pxでも操作可能。

Studioの公開アプリは確認時にメンテナンス画面だったため、公式ヘルプのエディタ全体・インスペクターの画像を視覚基準にした。指定された既存Kamakura管理画面とそのCSSも参照した。今回のブラウザ操作先はローカルの合成データdemoであり、本番2サイトのデータや公開状態は変更していない。
