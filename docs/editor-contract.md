# 共通エディターの利用契約

`@niho/web/editor` は認証済みスタッフ向けの React client component です。サイト・ページ・レイヤー、ライブキャンバス、インスペクタの3レールを提供します。既存サイトの認証や API をパッケージから直接呼びません。

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

React 19 と React DOM 19 を利用側で用意してください。`adapter` と `blocks` は module scope / `useMemo` 等で参照を安定させます。ホストの通常の再描画で作り直すと一覧・文書の再読込が起こるため、同じ編集セッション内では差し替えません。Next.js では adapter や registry の関数を Server Component から props で serialize せず、ホストの Client Component 内で組み立てます。

| adapter メソッド | 役割 |
| --- | --- |
| `listSites(signal)` | 編集権限のあるサイトと、許可済みの HTTPS 公開 origin 一覧 |
| `listPages(siteId, signal)` | 指定サイトで編集権限のあるページ・locale の一覧 |
| `readDocument(target, signal)` | 文書、opaque な `version`、データ連動値のロック、戻せる公開版 |
| `saveDraft({ target, document, expectedVersion }, signal)` | 楽観ロック付き下書き保存。成功時は新しい version とサーバー採番の revision、競合時は `status: 'conflict'` |
| `prepareRelease(request, signal)` | 公開 / rollback の正確な対象ドメイン、公開内容との差分、確認 token を発行 |
| `release(plan, signal)` | 確認済みの内容を公開 / rollback。成功時は最新 snapshot、競合時は `status: 'conflict'` |

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

テキスト、リンク、画像URL/alt、文字色・背景色・フォント・サイズ・余白・Flex/Grid・位置・レスポンシブ指定を編集できます。要素や登録ブロックの追加、複製、親/兄弟間の移動、削除、undo/redo に対応します。複製時はノードIDとHTML IDを作り直し、複製内のアンカーとARIA ID参照を付け替えます。

インスペクタは定義済みのプロパティだけを表示します。HTML、JS、任意CSS、未知propsを直接入力する欄はありません。値は core validator を通ってから文書へ適用し、無効値は入力欄に残して理由を表示します。入力途中または無効な値が残る間は保存・公開・構造操作を止め、「入力を取り消す」で適用済みの値へ戻せます。

サイズの数値は px、単位付き値は `rem` / `%` 等、トークン参照は `@space` 等で入力します。対応値は既存の[文書・描画契約](document-contract.md)に従います。値を空欄にするとその指定を削除します。全体の tokens 定義を変更するUIはこの版に含みません。

「編集する幅」は共通、375px以上、768px以上、1280px以上と文書内の既存 breakpoint から選べます。「表示幅」は iframe の実 viewport を375/768/1280pxへ変更するため、media query と固定位置のレイアウトを確認できます。キャンバス内のリンクやブロック操作は選択に使い、フォーム送信や遷移を止めます。サーバー描画用と同じ `PageRenderer` と host registry を使います。

iframe は scripts を許可しない sandbox として表示し、公開ページのCSS・fixed要素が編集UIへ重ならないようにします。registry は依然として信頼できるホストコードです。React の effect や親 window からの処理までは隔離できないため、プレビュー用ブロックで課金・予約・データ更新などの副作用を起こさないでください。

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

`http://127.0.0.1:4173` の動作例は公開可能なインメモリ adapter を使います。変更と「公開」はメモリ内だけに反映され、プロセス終了で失われます。外部API・認証・実サイトへ接続しません。

テストは core 連動編集、構造操作、ロック、履歴、実DOMでの入力・保存・409/通信失敗時の保持・保存中編集、公開ドメイン/差分確認、未保存移動を確認します。利用先への導入では認証・同時編集・本番公開処理・CSP・アクセシビリティとサイト固有ブロックの表示を確認してください。インラインCSSと `srcdoc` iframe を許可する CSP が必要です。
