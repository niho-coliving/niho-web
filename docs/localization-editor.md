# 多言語エディターのホスト接続

`PageEditor` は `EditorAdapter.localization` を省略した場合、従来どおり単言語で動作します。指定した場合は、同じ論理 `pageId` の原文と訳文を上部の「日本語 / English」で切り替え、実際の `PageDocument` をキャンバスで編集します。管理画面自体の表示言語は日本語のままです。

認証、Project / Site 権限、永続化、翻訳provider、ジョブ実行、監査、公開snapshotはホストの責務です。ライブラリはproviderを直接呼ばず、認証情報も保持しません。

## adapter

```ts
const adapter: EditorAdapter = {
  // 既存メソッド。選択中の documentLocales の文書を読み書きする。
  readDocument,
  saveDraft,
  // 共有部品を使うサイトでは、原文編集と保存の唯一の正本。
  components: {
    readLibrary,
    saveLibrary,
    listUsage
  },
  // ...
  localization: {
    readSite,
    readPage,
    command,
    requestSiteTranslation
  }
};
```

- `readSite(siteId, signal)` は、`SiteLocalizationConfig`、論理ページ1行ごとの日英状態、opaqueなversion、任意のサイト翻訳job状態を返します。`sourceLocale` は必須で、サイト名やlocaleから推測しません。
- `readPage(target, signal)` は、現在の正本原文、`sourceVersion`、現在のoverlay、opaqueなversion、任意のblock allowlist・旧原文値・job状態を返します。遅い応答はsite / page / localeと読込epochで破棄されます。`components`を併用するホストでは、部品ライブラリは`components.readLibrary`から得た`LibrarySession`を使い、`readPage.components`は返しません。後者は旧ホスト向けのfallbackです。
- `command` は `request-translation`、`adopt-candidate`、`review-current`、`set-value` を処理します。すべて `expectedSourceVersion`、opaque version、overlay versionをCASし、409は `{ status: "conflict" }` に変換します。手修正の`set-value`はさらに`sourceFingerprint`と`expectedEntryVersion`（未作成は0）を比較し、指定unit以外を変更しません。
- `requestSiteTranslation` は任意です。実装すると「サイト全体を翻訳」を表示します。queued / running / failedを`readSite`で返してください。エディターは常時pollせず、操作・保存・再読込時だけ状態を読み直します。

`localization`を実装したホストでは、`readSite`の設定・状態が検証でき、現在の`PageDocument.locale`が明示mappingに一致するまで、エディターは原文／訳文を推測せず編集・保存・公開を停止します。再読込失敗を単言語モードへのopt-inとして扱いません。queued / running中は「翻訳状況を更新」で`readSite`と`readPage`を明示的に再読込できます。

候補は現在の訳を上書きしません。「翻訳案を採用」で初めてdraftへ入り、確認済みにはなりません。「現在の訳を確認済みにする」は候補を採用せず、現在のdraftを現在の原文fingerprintに結び付けます。

訳文側の`readDocument`は、現在の正本原文とoverlayを`materializeLocalizedPage`した最新の共通構造を返してください。原文の構造・style変更後も手修正済みの訳値は保持し、変更された原文unitだけを`review-needed`にします。これは編集用draftの契約です。公開中の訳文snapshotは独立して保持し、draft再materializeで置き換えません。

`PageDocument`が`instance`を含む場合、`EditorAdapter.components`を実装し、同じサイトの現在の正本`ComponentLibrary`を`readLibrary`から返します。原文ページと部品デザインの読込・編集・undo/redo・自動保存・CAS・使用状況・公開影響は、このcanonical `LibrarySession`だけを使います。`readPage.sourceVersion`は正本原文と、その抽出に使った正本component libraryの組を識別しなければなりません。エディターはraw文書のstableなinstance/component IDを保存対象として保持し、訳文の表示時だけcanonical libraryとoverlayから作った同一IDのlocalized libraryを展開します。展開後の配列位置をraw文書へ適用したり、ページ保存や訳文操作で正本の共通定義を更新したりしません。

## 訳文保存の必須検証

訳文の`saveDraft`では、ブラウザのボタン非表示だけを信頼せず、ホストの認可済み保存境界で`validateLocalizedDocumentSave`を必ずawaitします。

```ts
import { validateLocalizedDocumentSave } from "@niho/web/localization";

const checked = await validateLocalizedDocumentSave(
  config,
  authoritativeSourceDocument,
  request.document,
  { components, blocks, blockLocalization }
);

// request.localization の3 versionも同じtransactionで比較し、
// checked.valuesだけをoverlayへ反映してから文書とoverlayをatomicに保存する。
```

このhelperは現在のcollectorで宣言された値だけを訳文から取り出し、既存の`materializeLocalizedPage`で期待文書を再構成します。node ID、タグ、保護リンク、href、style、token、配置、共通props、業務ID、未宣言fieldが原文と異なる場合は拒否します。原文に`UNANCHORED_TEXT` / `UNSUPPORTED_RICH_TEXT`が残る場合も保存・公開可能扱いにしません。

`saveDraft`の`request.localization`には次が入ります。

- `expectedSourceVersion`
- `expectedVersion`（`readPage`のopaque version）
- `expectedOverlayVersion`

ホストは文書versionに加えてこの3値を比較し、古い原文・overlayへの保存を409にしてください。手編集値を`editLocalizedValue`で反映すると、既存の確認は自動で解除されます。

## 編集できる範囲

原文は従来の全デザイン機能を使えます。訳文では、現在のcollectionが宣言した次だけを編集できます。

- ページtitle、description、OG画像alt
- ID付きtext / rich text、`alt` / `aria-label` / `title`
- schemaで許可したcomponent instance / blockの表示文言
- 言語別画像のasset reference

訳文キャンバスのリッチテキスト編集は、既存のinline ID・mark・リンク先を保持した文字編集です。raw JSONは表示しません。構造、スタイル、href、追加・複製・削除・移動・resize・detach・共通設定・構造を変え得る履歴復元は「共通デザインは原文側で編集してください」と停止します。入力途中または未保存の文書がある言語切り替えは、既存の未保存変更dialogを通ります。

画像は原文assetを既定で共有し、訳文で選択したときだけasset referenceをoverlayへ保存します。altは空文字も意図した値として扱えます。URL文字列を言語別画像として保存することはできません。

共通部品のunitは定義ID＋定義内node IDで一度だけ表示します。通常文字・空alt・rich text・asset referenceの手修正、候補採用、確認は`command`でoverlayへ保存します。ホストはshared-component unitをサイト＋target localeの共有値として永続化し、同じ定義を使う全ページの`readPage`で同じ値・確認状態を返してください。ページごとのoverlay表現を採る場合も、1ページでの`set-value`／採用／確認を同一transactionまたは整合する更新処理で全利用ページへ反映し、ページ移動で値を巻き戻してはいけません。正本`ComponentLibrary`自体は変更しません。

訳文のundo/redoは、そのセッション内で許可済みのcontent操作だけを戻します。端末内の緊急復元は現在の正本原文に対して`validateLocalizedDocumentSave`を再実行し、文字・画像だけの復元を許可して、ID・href・style・構造を変えた退避を拒否します。サイト全体／言語全体の履歴とrollbackは#43の公開契約とは分離したままです。

## 動作デモ

```sh
npm run demo:localization
```

`http://127.0.0.1:4176` に、NIHOkamakura（日本語→英語）とNIHO experience（英語→日本語）、各2ページを表示します。実際の`ComponentLibrary` instanceとして共有するヘッダー／フッター、ページ本文、画像を持ち、静的辞書による候補生成、手編集、採用、確認、原文更新後の再materialize、遅延、失敗、409をインメモリで試せます。本番AI・実サイト・認証情報・永続化には接続しません。

## 今回含まないもの

言語別の公開snapshot、route / canonical / hreflang / sitemap、公開版の原子的切り替えはIssue #43の範囲です。実ホストのDB/API・認可・翻訳worker接続はniho-app #19244以降で実装します。エディターライブラリ単体では翻訳内容を永続化せず、公開中の訳文も変更しません。
