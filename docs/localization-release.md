# 言語別公開・ルート・SEO契約

`@niho/web/localization-release` は、言語ごとの完成済み公開snapshotを生成・検証するReact非依存パッケージです。公開中の訳文を最新の原文レイアウトへ合成せず、ページ、共通部品、ナビ、スタイル、外部resource binding、route、SEOを1つの不変releaseとして扱います。

認証、公開権限、暗号学的にランダムな一回限りtoken、tokenの保管と原子的consume、DB、履歴保存、CAS、CDN、Cloudflare、OIDC、公開サイト描画はホストの責務です。このパッケージはtokenや権限を発行せず、ブラウザから渡されたsnapshotを正本とは扱いません。

## 公開snapshot

`createPublishedSiteLocaleSnapshot(input, options)` は次を同時に検証し、入力を参照しない `PublishedSiteLocaleSnapshot` を返します。

- 明示した `sourceLocale` / `defaultLocale` / `documentLocales`
- hostが正本から渡した `publicPageIds` と完全一致するmaterialized `PageDocument[]`
- 同じsite・locale・論理 `pageId`、重複しないroute
- 同じreleaseのlocalized `ComponentLibrary`、文書・部品内のtokensとstyle
- 公開ページだけを参照するナビ
- host allowlistに含まれる業務blockだけ
- source / config / target overlayのversionとdigest
- CSS、CMS、asset等、PageDocument外にあるものをhostが渡した範囲だけのresource binding
- target言語では全ページと共通内容の確認完了、抽出issueが0件であること

source言語は翻訳reviewを要求しませんが、文書identity、公開catalogue、block、共有参照、resource bindingはtargetと同じく検証します。`requiredResourceIds` に指定したCSS/CMS等のbindingが無ければ失敗します。指定されていない外部resourceを「snapshotに固定済み」とは扱いません。

```ts
import { createPublishedSiteLocaleSnapshot } from "@niho/web/localization-release";

const snapshot = await createPublishedSiteLocaleSnapshot({
  config,
  locale: "en",
  releaseId: "kamakura-en-2026-10-21-1",
  version: "release-cas-12",
  pages: materializedPages.map(({ document, sourcePath }) => ({
    path: sourcePath,
    document,
    indexable: true
  })),
  publicPageIds: authoritativePublicCatalogue.map((page) => page.pageId),
  components: localizedComponentLibrary,
  navigation,
  supportedBlocks: ["Booking"],
  manifest: {
    source: { version: sourceVersion, digest: sourceDigest },
    overlay: { version: overlayVersion, digest: overlayDigest },
    config: { version: configVersion, digest: configDigest },
    resources: [{ id: "siteCss", kind: "css", version: cssVersion, digest: cssDigest }]
  },
  requiredResourceIds: ["siteCss"],
  completeness: {
    reviewedPageIds: authoritativePublicCatalogue.map((page) => page.pageId),
    sharedReviewed: true,
    unresolvedIssues: []
  }
}, { blocks });
```

`contentDigest` はcanonical JSONに対するWeb Crypto SHA-256です。内容同一性の比較用であり、署名、認証、認可の代用ではありません。保存済みsnapshotの読込時は `verifyPublishedSiteLocaleSnapshot` でparserとdigestの両方を検証します。

原文を先に公開した場合、targetの旧snapshotはページ本文だけでなく、旧レイアウト、旧共通部品、旧ナビ、旧style、旧resource bindingを丸ごと維持します。新しいsource-onlyページは旧targetのroute、ナビ、sitemap、hreflangへ入りません。targetを次に公開するときだけ、新しい完成済みtarget snapshotへ一括で切り替えます。

## prepare / apply

`createSiteLocaleReleasePreparation` はsite / locale / action、現在の期待release version、候補release ID・version・digest、候補が当時持つsource / overlay / config / resource manifest、期限をdescriptorへ結び付けます。さらに必須の `liveDependency: { version, digest }` へ、hostが現在のsource、config、公開catalogue、overlay、resource identityから作った集約identityを渡します。rollback候補の古いmanifestは履歴として変更せず、現在の依存状態とは別に保持します。

commit直前に、ホストは保存済み正本から候補snapshotを再生成し、現在releaseとlive dependencyを読み直して `verifyPreparedSiteLocaleRelease` を実行します。publishとrollbackの両方で、準備後の原文・overlay・config・catalogue・CSS/CMS変更、現在versionのdrift、期限切れ、site/locale/source/default/document locale違いは失敗します。候補は現在版と異なるrelease IDとversionを持つ必要があり、replayできません。検証は現在値を変更せず、成功時だけdetachedな候補を返します。

ホストは別途、公開権限とactor scopeを再確認し、サーバーにだけ保存したランダムな一回限りtokenを原子的にconsumeし、期待versionのCASと現在releaseの差し替えを同じtransactionで行います。クライアントが送った任意snapshotをapply対象にしてはいけません。通信断で結果が不明な場合はtokenを再送する前に現在releaseを読み直します。

## rollbackと現在の取消

`projectCurrentPublishedSiteLocaleSnapshot` は、hostが渡す現在の `eligiblePageIds` / `revokedPageIds` と承認済み同一site originを使い、保存済みsnapshotを変更せずに現在の公開read用cloneを作ります。過去snapshotに存在するページを減らすことだけができ、新しく追加されたsource-onlyページや現在の原文layoutを旧targetへjoinしません。対象ページが0件なら明示的に利用不可として失敗します。

投影は取消済みページをpage、route、SEO、pageId nav、href-only navから除き、相対URLと承認済みoriginの絶対URLのanchorをリンクとして機能しない形へ安全に変換します。共通部品のhref公開propに束縛された要素は、prop契約を保つためhrefのないa要素として残し、安全なインスタンス別URLの上書きは維持します。その他は非link要素へ変換します。業務blockは `type: "url"` のprop、部品instanceは `field: "href"` に束縛されたpropだけを除去対象にし、同じpathを表示する文字propは保持します。外部siteの同じpathは変更しません。必須block prop等を安全に除去できずdocument/block契約を満たせない場合は、dead linkを残さず投影自体を失敗させます。投影後のdigestは公開可視性を反映するためcache identityも変わります。

`createRevocationSafeRollback` はこの投影を通し、過去snapshotをそのまま再有効化せず、新しいrelease ID / version / digestを持つrollback snapshotを作ります。現在catalogueに追加された未翻訳source-onlyページが古い承認済みtargetに無いことは欠損扱いにせず、古いsnapshotに存在する現在eligibleなページだけを復元します。

削除、非公開、権限喪失はすべてのlocaleより優先します。ホストは不変履歴とは別に現在のglobal revocationを保持し、公開read、言語switch、sitemap、navの最終gateにします。価格、在庫、予約可能性、CMSレコード権限等の動的な業務block可視性もsnapshotだけでは固定せず、権威あるhost read modelを最終gateにします。

## routeと内部リンク

`localePath(config, locale, sourcePath)` は `defaultLocale` をrootにし、非default localeだけへ `/en` または `/ja` を一度付けます。`sourceLocale` と `defaultLocale` は別概念で、どちらも必須です。日本語を暗黙補完しません。

- 原文pathの大文字小文字、綴り、末尾slash有無を維持
- `/en` / `/ja` で始まる既存原文pathはcatalogue全体で衝突として拒否
- traversal、query、fragment、protocol-relative、壊れたpercent encoding、encoded slash/backslashをpathとして拒否
- Experienceは英語root・日本語`/ja`、鎌倉は日本語root・英語`/en`

`resolveLocalizedInternalLink` は現在の公開routeと完全一致する内部リンクだけを書き換え、queryとfragmentを維持します。外部URL、asset、API、embed、未知route、draft-only routeは変更しません。`known` に別siteのreleaseが混ざる場合は拒否し、そのpathをpageId解決へ利用しません。論理pageIdが既知でもtarget releaseに無い場合は `unresolved-known` を返すため、呼出元はそのnav itemを省けます。予約ID、商品ID、業務dataは変更しません。

`resolveLanguageSwitch` は同じ論理pageIdが実際に公開済みのlocaleだけを返します。未公開targetをtopへ代替しません。ブラウザ言語redirectはこの契約にありません。

## SEOとcache

`deriveLocalizedPageSeo` はactual current snapshot群から、`documentLocales`に基づくhtml lang、indexableなself canonical、実在する公開対応ページだけのselfを含む相互hreflang、default localeの対応ページがある場合だけのx-defaultを生成します。preview / noindexではcanonical、hreflang、x-defaultを出しません。

文書の`meta.noindex=true`はroute側の`indexable=true`より優先し、サイトマップにも含めません。受信snapshotに両者の矛盾があればparserで拒否します。

`createLocalizedSitemap` は各current releaseのindexable routeだけを返します。`siteLocaleReleaseCacheIdentity` はsite、locale、releaseId、pageId、snapshot digest、resource digestを含みます。本文とSEOを別releaseから合成しないでください。

## エディター接続

`EditorLocalizationAdapter` の `readRelease / prepareRelease / applyRelease / rollbackRelease` をすべて実装したhostでは、訳文の「言語全体の公開確認」が有効になります。確認画面には全ページ・全共通resource、domain、現在版、準備版、確認用の依存版、期限、未完了理由を表示します。hostのconfirmation tokenと `optimisticVersion` は、pure release APIへ渡すlive dependencyと同じ現在状態へ結び付けます。

未保存文書、保存前の共通部品、入力中の手動buffer、履歴表示中はprepare/applyできません。409と期限切れは現在状態を再読込し、通信失敗は成立状況不明として再実行前の確認を求めます。成功・失敗・競合の後に同じページのlocale公開状態を再読込します。
applied応答はrequestと同じsite / locale、および準備済みrelease ID / version / summaryでなければ成功として扱いません。未知status、別scope、遅れて到着した旧adapter/旧targetの応答も破棄します。

4メソッドのどれかが無い旧hostでは訳文公開を無効のままにし、運用者向けの説明を表示します。source言語の既存ページ単位 `prepareRelease / release` は互換のままで、他のsource draftをまとめて公開しません。rollbackは過去の言語全体releaseを対象とし、ページrevision番号ではありません。

`examples/localization-demo.tsx` の公開操作は、version付き一回限りnonce、期限、CAS、履歴を見せるためだけの明示的なインメモリ偽hostです。初期の未確認項目、公開成功、rollback、次回409、成立状況不明、source-onlyページ追加後も旧target公開版が維持される流れを確認できます。本番認証・安全性・保存・実サイト公開を代替しません。

## routeではない共通resourceとpublic read

共通chrome、template、UI copyはpublic route pageではありません。`/chrome` や `/copy-interface` のような架空routeを作らず、実bytes・hash・versionをhostが保持する必須の不変resource sidecarとして同じreleaseへbindします。CSS、CMS由来resource、assetも同様です。whole-language gateは静的デモページだけでなく、これら全resourceの確認とbindingを含みます。

動的な業務route catalogueとmetadataは、template・entity・releaseへ結び付くhost canonical sidecarです。snapshot内の静的page flagを公開membershipの正本にしてはいけません。public endpointが返すのは投影済みの公開content、公開metadata、release identityに限定し、内部source/config/overlay manifest、CAS descriptor、confirmation token、snapshot全DTOをvisitorへdumpしません。

## 明示的な非対象

- NIHO / CloudflareのDB schemaとmigration
- credential、OIDC、IAM、公開権限、監査log
- production token生成・保管・consume
- public-site renderer、CDN purge、実サイト公開
- 翻訳providerとjob

これらはhost実装（niho-app #19244等）で接続します。
