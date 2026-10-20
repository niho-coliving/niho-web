# 共通プロジェクト契約

`@niho/web/projects` は、1プロジェクトに1サイトを結び付け、複数メンバーを参加させる公開可能なモデル・検証・純粋操作を提供します。`@niho/web/project-manager` は認証済みホストへ接続する管理用 React 画面です。

このパッケージは認証、権限、招待、ID採番、アカウント台帳、管理API、非公開データ、本番永続化を所有しません。Project に role / owner / invitation / email を保存しません。ホストは各adapter呼出しでセッションと対象サイトへの権限を検証してください。

## モデルと入力検証

```ts
type Project = {
  id: string;
  name: string;
  site: { id: string; name: string; domains: readonly string[] };
  members: readonly { userId: string; displayName: string }[];
};
type ProjectCatalog = { projects: readonly Project[] };
```

- `site` は単数かつ必須です。`sites` や第2サイトを表す未知フィールドは拒否し、サイト差替え操作は提供しません。Project と唯一のSiteは `addProject` で一緒に追加します。
- Project内の `userId`、Catalog内の `project.id` と `site.id` は重複できません。同じ `userId` が別Projectへ参加することはできます。
- `project.id` と `site.id` は文書互換のため、英字から始まる英数字・`_`・`-` の最大80文字です。`userId` はホストの不変IDをそのまま扱う独立したopaque値で、数字開始を含む1〜128文字を許可し、制御文字を拒否します。名前は空白だけにできず最大120文字です。未知フィールド、通常のJSON objectでない入力も拒否します。
- 上限は100 Project、1 Projectあたり500 member、1 Siteあたり20 domainです。domainはパス・query・fragment・資格情報・末尾 `/` のない正確なHTTPS originに限定します。
- parserは入力参照を保持せず、新しいobject/arrayへコピーします。外部入力は `unknown` のまま保存せず、`parseProjectCatalog` / `parseProjectCatalogSnapshot` を通してください。

`addProjectMember` の二重追加は例外や二重行を作らず、`{ status: "unchanged", reason: "already-member" }` を返します。参加していないメンバーの解除も `not-member` を返します。解除はProject、Site、Pageを削除しません。

## atomic CAS とホスト永続化

`ProjectCatalogStore` の `compareAndSwapCatalog` は、opaqueな `expectedVersion` の比較とCatalog書込みをストレージ側で原子的に行います。HTTPなら競合を409へ対応させてください。`commitProjectCatalog` は、既存Projectがすべて残り、そのProjectと`site.id`の結び付きが変わらないことを送信前に検査します。成功snapshotは再検証し、送信Catalogと同じ内容である場合だけ採用します。storeへ渡すcopyと比較基準は分離されているため、storeによる引数のmutationも成功扱いしません。競合時は入力Catalogと旧versionの検証済みコピーを返し、自動上書き・自動merge・自動再読込は行いません。

```ts
const snapshot = await readProjectCatalog(store, signal);
const change = addProjectMember(snapshot.catalog, projectId, member);
if (change.status === "changed") {
  const result = await commitProjectCatalog(store, snapshot, change.catalog, signal);
  if (result.status === "conflict") {
    // result.snapshot は手元の入力と旧version。最新状態を明示的に再取得する。
  }
}
```

アカウント照合とID採番はホストが担当します。ライブラリはNIHO APIを直接呼びません。本番ホストはDB transaction、ETag、compare-and-swap等でこの契約を実装する必要があります。デモのin-memory実装は永続化例ではありません。

## ProjectManager

`ProjectAdapter.resolveMember` は、利用者が入力したメールアドレス等をホストの既存アカウントへ照合します。返すのは `{ userId, displayName }` だけです。入力識別子は `addMember` やCatalogへ渡しません。未登録者への招待やロール選択は行いません。

create / add / remove はすべて `expectedVersion` を受け取り、`saved` / `conflict` / `unchanged` を返します。成功応答でも既存Projectの消失やSite差替えは採用しません。競合・通信失敗時、画面はCatalogの旧versionとフォーム入力を保持します。非同期操作中は再読込、二重送信、Project切替を止め、adapter差替えとunmount時は進行中の `AbortSignal` をabortします。

`onOpenProject` は管理画面から編集画面等を開くためのcallbackです。`ProjectManager` 自身は既存 `PageEditor` をunmountしません。ホストが画面を切り替える場合、編集中の未保存内容を確認してから切り替えてください。

## 1サイト限定エディター

```tsx
import { createProjectEditorAdapter } from '@niho/web/project-editor';
import { PageEditor } from '@niho/web/editor';

const scoped = createProjectEditorAdapter(authenticatedEditorAdapter, project);
<PageEditor adapter={scoped} />;
```

wrapperは `listSites` をProjectの唯一のSiteへ絞り、`listPages`、read、save、prepare、releaseのsite/文書identity/公開domainを照合します。別siteや許可外domainは元adapterへ渡す前、または応答採用前に拒否します。元の `PageEditor` 利用方法は変わりません。

このwrapperは認可機構ではありません。元adapterは毎回、現在の認証、サイト・ページ権限、文書検証、永続化、公開tokenを検証してください。

## 合成データの動作例

```sh
npm run demo:projects
```

`http://127.0.0.1:4174` で、2 Project、複数member、同一の架空userIdが複数Projectへ参加する例、ProjectManager操作、選択Projectの1サイトへ限定したPageEditor接続を確認できます。`kamakura-site` / `niho-experience-site` は対応関係を示す名称だけで、実サイト・実アカウント・本番APIには接続しません。変更はプロセス内メモリだけにあり、再起動で失われます。
