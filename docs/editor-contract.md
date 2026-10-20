# 共通エディターの利用契約

`@niho/web/editor` は認証済みスタッフ向けの React client component です。左の追加・ページ・レイヤー等のパネル、中央のライブキャンバス、右の要素・ページ・サイト設定を提供します。既存サイトの認証や API をパッケージから直接呼びません。

## ホストへの接続

```tsx
'use client';
import { PageEditor, type EditorAdapter, type EditorBlockRegistry } from '@niho/web/editor';

// ここではホストが所有する認証済みクライアントを渡す。
export function StaffPageEditor({ adapter, blocks }: {
  adapter: EditorAdapter;
  blocks: EditorBlockRegistry;
}) {
  return <PageEditor adapter={adapter} blocks={blocks} />;
}
```

React 18.3 または 19 と、同じ版の React DOM を利用側で用意してください。`adapter` と `blocks` は module scope / `useMemo` 等で参照を安定させます。ホストの通常の再描画で作り直すと一覧・文書の再読込が起こるため、同じ編集セッション内では差し替えません。Next.js では adapter や registry の関数を Server Component から props で serialize せず、ホストの Client Component 内で組み立てます。

| adapter メソッド | 役割 |
| --- | --- |
| `listSites(signal)` | 編集権限のあるサイトと、許可済みの HTTPS 公開 origin 一覧 |
| `listPages(siteId, signal)` | 指定サイトで編集権限のあるページ・locale の一覧 |
| `readDocument(target, signal)` | 文書、opaque な `version`、データ連動値のロック、戻せる公開版 |
| `saveDraft({ target, document, expectedVersion }, signal)` | 楽観ロック付き下書き保存。成功時は新しい version とサーバー採番の revision、競合時は `status: 'conflict'` |
| `prepareRelease(request, signal)` | 公開 / rollback の正確な対象ドメイン、公開内容との差分、確認 token を発行 |
| `release(plan, signal)` | 確認済みの内容を公開 / rollback。成功時は最新 snapshot、競合時は `status: 'conflict'` |
| `preparePageChange` / `applyPageChange`（任意） | ページの作成・複製・名前とURLの変更・公開切替。影響の確認と一回限りの確認 token。[ページ管理の契約](page-contract.md) |
| `readSiteSettings` / `saveSiteSettings`（任意） | サイト共通の公開情報。楽観ロック付き |

`listPages` の各ページに任意で `path`・`kind`（page / template / shared）・`visibility`・`published` を返すと、左のページパネルにフォルダ・種別・公開状態を表示します。任意メソッドを実装しないホストでは、ページ操作とサイト設定の保存を表示しません。

target は `siteId/pageId/locale` の組です。文書の組と一致しない読込結果は受け入れません。ホストは各呼出しで現在のセッションの認証・サイト/ページ権限を確認し、文書を `@niho/web/core` で検証してください。UI の選択値やロック表示をサーバーの認可の代わりにしません。

`AbortSignal` は読込の切替と unmount 時に abort します。公開処理は signal が abort されてもサーバーで成立する可能性があるため、ホスト側で結果の照会と重複実行の防止を実装します。例外の生メッセージ・token・秘密を UI に表示しません。

## 楽観ロックと編集の保持

`version` は HTTP ETag や DB の更新番号を文字列にしたもの等、ホストが管理する opaque な値です。文書内の `revision` と別に扱います。下書き保存時は `expectedVersion` と保存先の現行版を原子的に比較し、サーバーが現行 revision より大きい safe integer を採番して文書に設定し、必ず新しい version とともに返します。同じ site/page/locale/revision に異なる内容を保存しません。

成功応答は `{ status: 'saved', version: 'new-version', revision: 2 }` の形式です。送信文書の revision は編集開始時点の基準であり、採番をクライアントへ任せません。ホストは revision 以外の送信内容を変形せず保存してください。応答の revision が送信時以下・非整数・safe integer 外の場合、エディターは応答を採用せず、手元の編集と元の version を保持します。

HTTP 409 は adapter で `{ status: 'conflict' }` へ変換します。`status: 409` を持つ例外も競合として表示します。他の例外は一般的な保存失敗として扱います。どちらの場合も文書・undo/redo・元の expectedVersion を保持します。競合の自動上書きや自動 merge はしません。再読込で手元の変更を破棄する場合は、明示確認が必要です。

保存中も編集を続けられます。成功時は現行の作業コピー・undo/redo履歴・保存開始時の文書から作る保存済み基準を、返された revision に揃えます。内容と履歴の順序を保つため、保存中の追加編集は未保存のまま残り、undo/redoで保存時点に戻すと正しく保存済みになります。次の保存では新しい version と revision を送信し、サーバーがさらに新しい revision を採番します。保存処理中のページ切替や公開操作はできません。

作業コピーと履歴の revision は最新の保存先を表す基準です。編集中の内容をその revision の公開済み文書として扱わず、永続化・公開する際は保存で採番した不変の文書を使います。rollback で過去の内容を復元するときも、異なる内容へ古い revision を再利用せず、新しい revision の文書を返してください。

編集履歴はメモリ内で最大50操作です。undo/redo・保存済み表示は文書内容と保存済みの基準を比較します。サイト/ページ移動・再読込は未保存の文書と入力途中の値を破棄する前に確認します。タブを閉じる際もブラウザへ離脱確認を要求します。ブラウザや端末を閉じた後の復元、localStorage、自動保存はこの版に含みません。

## 安全な入力と編集範囲

テキスト、リンク、画像（素材ライブラリまたはURL）/alt、背景画像、文字色・背景色・フォント・サイズ・余白・Flex/Grid・位置・レスポンシブ指定を編集できます。要素や登録ブロックの追加、複製、親/兄弟間の移動、削除、undo/redo に対応します。複製時はノードIDとHTML IDを作り直し、複製内のアンカーとARIA ID参照を付け替えます。

追加パレットのセクション・ボックス・テキスト・見出し・リッチテキスト・画像はクリックで選択した親の末尾へ追加するか、キャンバス／レイヤーへドラッグして挿入位置を指定します。既存要素も選択後にキャンバスまたはレイヤーから移動でき、選択枠の右下をドラッグすると現在選んだ編集幅の幅・高さを一操作として変更します。キーボード向けには追加先の選択と上／下／末尾への移動、右インスペクタのサイズ欄を残します。不正な入れ子、循環、ロックされた変更はモデルの検証で拒否します。

本文・見出しはキャンバスでダブルクリックして直接編集できます。リッチテキストは許可済みの段落・見出し・箇条書き・太字・斜体・リンクを文書ノードとして保存します。貼り付けはプレーンテキストに限定し、contenteditable の HTML は保存せず、許可済みノードへ変換して既存validatorを通します。Escapeで編集を取り消し、Cmd/Ctrl+Enterまたはフォーカス移動で確定します。保存対象はあくまで検証済みのPageDocumentです。

インスペクタは定義済みのプロパティだけを表示します。HTML、JS、任意CSS、未知propsを直接入力する欄はありません。値は core validator を通ってから文書へ適用し、無効値は入力欄に残して理由を表示します。入力途中または無効な値が残る間は保存・公開・構造操作を止め、「入力を取り消す」で適用済みの値へ戻せます。

サイズの数値は px、単位付き値は `rem` / `%` 等、トークン参照は `@space` 等で入力します。対応値は既存の[文書・描画契約](document-contract.md)に従います。値を空欄にするとその指定を削除します。全体の tokens 定義を変更するUIはこの版に含みません。

「編集する幅」は共通、375px以上、768px以上、1280px以上と文書内の既存 breakpoint から選べます。「表示幅」は iframe の実 viewport を375/768/1280pxへ変更するため、media query と固定位置のレイアウトを確認できます。編集中のキャンバス内のリンクやブロック操作は選択に使い、プレビュー中もリンク遷移とフォーム送信を止めます。サーバー描画用と同じ `PageRenderer` と host registry を使います。

iframe は scripts を許可しない sandbox として表示し、公開ページのCSS・fixed要素が編集UIへ重ならないようにします。registry は依然として信頼できるホストコードです。React の effect や親 window からの処理までは隔離できないため、プレビュー用ブロックで課金・予約・データ更新などの副作用を起こさないでください。

`insertableBlocks` を空配列にすると、登録済み業務ブロックの新規追加を隠し、既存ブロックの表示 props 編集だけを残せます。省略時はすべての登録ブロックを追加できます。サイト固有の配置条件は保存 API でも検証してください。

## 素材ライブラリ

`PageEditor` に `assets`（`AssetLibraryAdapter`）を渡すと、左のツールレールの「素材」パネルが素材ライブラリになります。渡さない場合は従来どおり、画像を追加して「画像 URL」で指定する案内を表示します。adapter・素材の形・ホストの責務は[素材ライブラリ契約](asset-contract.md)を正とします。

- 「素材」では検索、種類（画像・動画・PDF）、フォルダで絞り込み、アップロード、名前・代替テキストの初期値・フォルダの更新、使用状況の確認、未使用素材の削除ができます。容量と1ファイルの上限、受け付ける形式は adapter の応答に従い、送信前にも確認します。
- 素材の詳細から「選択中の画像を置き換え」「選択中の要素の背景にする」「ページに追加」を選べます。インスペクタの「画像を選ぶ」「背景画像を選ぶ」は、同じパネルを選択モードで開き、画像を1回選ぶと適用して閉じます。選択モードでアップロードした1枚もそのまま適用します。
- 置き換えたときは素材の代替テキストを要素の alt の初期値にします。配置後の alt は要素ごとに編集します。
- 配置できるのは確認済みの JPEG・PNG・WebP・AVIF・GIF 画像だけです。動画・PDF 等は一覧と詳細に表示しますが、配置操作を出しません。
- 入力途中の値がある間、保存・公開処理中、確認ダイアログの表示中は配置できません。配置・置き換えは通常の編集と同じく validator、ロック、undo/redo を通ります。ロックされた画像（`asset` / `attrs.src`）や背景（`style`）は変更できません。
- このページで使っている素材は削除できません。「このページの使用箇所を置き換え」で別の画像へまとめて置き換えられます。他ページの下書き・公開版で使われている素材も、ホストが返す使用先を表示して削除を止めます。
- 選択モードは、どのパネルを開いていても「素材」パネルに切り替えて表示し、閉じると元のパネルへ戻ります。パネルを切り替えても、キャンバスの選択と入力途中の値は保持します。

adapter が `listProviders` を実装すると、パネルの上部に「すべて」と出所（サイト・CMS 画像・ストック等）の切替と「最近使った」が表示されます。出所の権限に応じて、アップロード・編集・削除の操作を出し分けます。ストック等の配置前には `acquireAsset` でライセンスを記録します。

プレビューは `adapter.resolveAssets` で取得した URL で描画し、解決できない画像は破線の枠で表示します。「最新の文書を再読込」と公開の後は、解決と素材一覧を取り直し、非公開化・削除された素材をプレビューから外します。保存する文書には素材参照だけを入れ、URL を入れません。

## データ連動値のロック

ブロックに共通のデータ連動値は registry に明示します。

```tsx
const blocks = {
  PublicNotice: {
    props: {
      heading: { type: 'string', required: true },
      count: { type: 'number', required: true },
    },
    defaultProps: { heading: 'お知らせ', count: 3 },
    lockedProps: { count: '公開データから取得する件数です。ホスト側で管理します。' },
    component: ({ heading, count }) => <aside>{heading}: {count}</aside>,
  },
} satisfies EditorBlockRegistry;
```

ページ固有のロックは snapshot の `locks` に `{ nodeId, fields, reason }` として返します。fields は `props.count`、`attrs.href`、`style.base.color`、`style`、`children`、`*` 等の文書フィールドです。text node 自体はIDを持たないため、その親の `children` をロックしてください。

ロックされた欄は理由付きで無効化し、モデル側でも編集・削除・undo/redoによる変更を拒否します。データ連動値を含む要素やその祖先の複製・削除も拒否し、移動は値を変えない場合に許可します。ロックは編集補助なので、同じ制約を保存・公開APIでも適用してください。価格・在庫・予約の取得や計算をパッケージへ持ち込みません。

## 公開 / rollback の二段階確認

公開操作は保存済みの文書だけに許可します。prepareRelease は現在の公開内容と保存済み下書きの差分をホスト側で計算し、人が理解できる `path/before/after` の文字列配列として返してください。rollback の場合は指定した公開版を反映した結果との差分にします。UI は plan をコピーして保持します。

plan の target、expectedVersion、action、rollback revision が要求と一致し、domain が listSites の許可済み HTTPS origin に含まれることを確認してからダイアログを開きます。origin は `https://example.com` の形式で、パス・資格情報・末尾 `/` を含めません。対象ドメインと差分を表示し、明示チェック後だけ実行ボタンを有効にします。確認中は背後の編集を無効化します。

ホストは confirmationToken を対象文書・version・ドメイン・action・rollback revision・正確な差分に結び付け、短い有効期限と一回限りの利用を実装してください。release 時も認可と version を原子的に再検証し、UI から渡された domain や changes を権限の根拠にしません。token をログや永続文書に保存しません。

公開409は現在の編集内容を保持して確認を閉じます。通信失敗は「成立したか不明」として扱い、ホスト側で公開状態を確認するよう表示します。成功時はホストが返す最新 snapshot を検証して読込むため、文書と version を必ず最新状態で返してください。

## 動作例と検証

```sh
npm ci
npm test
npm run typecheck
npm run demo
```

`http://127.0.0.1:4173` の動作例は公開可能なインメモリ adapter を使います。変更と「公開」はメモリ内だけに反映され、プロセス終了で失われます。素材ライブラリには生成した見本画像・PDF・動画のメタデータが入っており、アップロードしたファイルもデモサーバーのメモリにだけ保存します。外部API・認証・実サイトへ接続しません。サムネイルや配信 URL を別ドメインから読む場合は、CSP の `img-src` にそのドメインを追加してください。

テストは core 連動編集、構造操作、ロック、履歴、素材のアップロード・置き換え・保存・再読込と削除防止、実DOMでの入力・保存・409/通信失敗時の保持・保存中編集、公開ドメイン/差分確認、未保存移動を確認します。利用先への導入では認証・同時編集・本番公開処理・CSP・アクセシビリティとサイト固有ブロックの表示を確認してください。インラインCSSと `srcdoc` iframe を許可する CSP が必要です。
