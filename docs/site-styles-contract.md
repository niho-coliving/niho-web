# サイト共通スタイル契約 v1

複数ページで token と文字スタイルを共有するための公開契約です。共通スタイルはページ、拠点、ユーザー所属とは別のDTOで、ホストが明示した `siteId` だけに属します。

```ts
type SiteStyleLibrary = {
  schemaVersion: 1;
  siteId: string;
  revision: number;
  tokens: Record<string, DesignToken>;
  textStyles: Record<string, TextStyle>;
};
```

`parseSiteStyleLibrary` は未知フィールド、未知schema、別形式のCSS値、壊れたtoken参照、件数・値の上限を拒否し、入力から切り離した値を返します。認証・認可、永続化、`revision` の採番、楽観ロック（CAS）、変更履歴はホスト責務です。公開ライブラリはDB接続や秘密を持ちません。

## ページとの合成

```ts
import { materializeSiteStyles } from '@niho/web/site-styles';

const effective = materializeSiteStyles(rawPage, sharedSnapshot);
```

- ページの `tokens` / `textStyles` はローカル上書きとして残り、同名ではページが優先します。
- `siteId` が一致しない組み合わせを拒否します。拠点やログインユーザーの所属から暗黙に選びません。
- 合成後の文書全体を既存の `parsePageDocument` と閉じたCSS schemaで再検証します。共通文字スタイルから共通tokenを参照できます。
- 戻り値は入力から切り離した有効文書です。raw pageとsnapshotを変更しません。
- ComponentLibraryのtokenは従来の名前空間と展開規則のままです。共通スタイルのresolverは部品を展開しません。公開描画には従来どおり展開済み文書を渡します。

保存の正本は常に元のraw pageです。`materializeSiteStyles` の戻り値を下書きへ保存したり、複製元にしたりしないでください。共通定義がページローカル上書きへ変わり、その後の共通変更を受けなくなります。

## 描画

```tsx
<PageRenderer document={rawPage} siteStyles={sharedSnapshot} />

renderPageToHtml(rawPage, blocks, { siteStyles: sharedSnapshot, assets });
generatePageCss(rawPage, blocks, assets, { siteStyles: sharedSnapshot });
```

各入口は同じ有効文書を作ってから本文とCSSを生成します。`siteStyles` を省略した既存呼出しの挙動は変わりません。snapshotはホストが明示的に取得して渡し、描画ライブラリがlive設定を探索することはありません。

## 切離しと取り込み

`detachSiteStyles(rawPage, sharedSnapshot, blocks?)` は、そのページが実際に参照する共有文字スタイルとtokenだけをローカルへ移したraw pageを返します。ノードのbase・responsive・state、業務ブロックのslot、文字スタイルからのtoken参照を対象にし、未使用の共通定義はコピーしません。共有定義の削除またはページの切離し前に、ホストが対象ページごとに保存してください。

`planSiteStyleImport(rawPage, sharedSnapshot, blocks?)` は、ページローカル定義のうち追加できる `tokens` / `textStyles` と、同名で内容が異なる `conflicts` を返します。snapshotもページも変更せず、既存の共通定義を自動上書きしません。ホストは衝突を利用者に解決させた後、CAS付きでライブラリを保存します。

## 公開snapshot

公開版を作る時点で、ホストはその公開に選んだ `SiteStyleLibrary` snapshotを使って有効文書を生成し、版の内容を固定します。freeze済み公開snapshotの表示時に、後からlive共通設定を合成してはいけません。たとえば旧日本語版へ、後日変更した英語向けスタイルを混ぜることは禁止です。

現行の localization-release schemaは変更しません。ホストは公開準備時に言語・ページ・共通スタイルの版を揃え、固定済みの有効文書を既存の公開snapshotへ渡します。rollbackも当時固定した有効文書へ戻し、現在の共通設定で再合成しません。

## エディター接続

この契約はReact非依存のparser、合成、切離し、取り込み計画と描画オプションまでを扱います。PageEditorでの読込・保存・競合解決・使用状況UIはホストadapter側で接続します。
