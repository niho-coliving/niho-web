# 多言語化コア契約

`@niho/web/localization` はReactに依存しない翻訳下書き契約です。認証、永続化、翻訳provider呼出し、公開snapshot、route/SEO manifest、エディターUIは含みません。

## 設定と言語

`parseSiteLocalizationConfig(input)` は未知fieldを拒否し、入力を参照しない値を返します。`sourceLocale` は必須です。サイト名や `defaultLocale` から推測しません。`defaultLocale` はURLの既定言語、`sourceLocale` は翻訳方向なので別のfieldです。

```ts
import {
  collectLocalizationUnits,
  createLocalizationOverlay,
  documentLocaleFor,
  parseSiteLocalizationConfig
} from "@niho/web/localization";

const kamakura = parseSiteLocalizationConfig({
  schemaVersion: 1,
  siteId: "kamakura",
  sourceLocale: "ja",
  defaultLocale: "ja",
  enabledLocales: ["ja", "en"],
  documentLocales: { ja: "ja-JP", en: "en" },
  glossaryVersion: "kamakura-2026-10",
  contextVersion: "site-copy-v1"
});

const experience = parseSiteLocalizationConfig({
  schemaVersion: 1,
  siteId: "experience",
  sourceLocale: "en",
  defaultLocale: "en",
  enabledLocales: ["en", "ja"],
  documentLocales: { ja: "ja", en: "en-US" },
  glossaryVersion: "experience-2026-10",
  contextVersion: "site-copy-v1"
});

documentLocaleFor(kamakura, "ja"); // "ja-JP"
documentLocaleFor(experience, "en"); // "en-US"
```

`localizationLocaleFor(config, documentLocale)` は逆方向の明示mappingです。mappingにない `en-US` 等を近い言語として推測しません。
`documentLocales.ja` は `ja` / `ja-*`、`documentLocales.en` は `en` / `en-*` の言語familyに限ります。対応を逆にした設定や無関係な言語は拒否します。

## 抽出と安定ID

`collectLocalizationUnits(config, sourceDocument, targetLocale, options)` は、まず既存の `parsePageDocument` / `parseComponentLibrary` で入力を検証し、次を返します。

- `page.title`、description、OG画像alt
- ID付きelementの単一text、alt、`aria-label`、title
- ID付きparagraph等をanchorにしたinline rich text
- 共通component定義の内容（配置数にかかわらず定義ごとに1単位）
- instanceが明示的に持つ、component schemaで `text` / `alt` と宣言されたoverride
- host schemaで明示的に許可したblockのstring prop
- 任意の言語別画像に使う、手動専用のasset override

unit IDはelement/component IDとfieldから作ります。childrenの配列位置や表示文字列は使いません。IDを保った移動では同じ単位、別IDへの置換では別単位になります。削除済み単位のoverlay entryは別単位へ移さず `obsolete` として報告します。

```ts
const extraction = {
  components: parsedComponentLibrary,
  blocks: {
    Booking: { props: {
      heading: { type: "string", maxLength: 80 },
      href: { type: "url" },
      productId: { type: "string" }
    } }
  },
  blockLocalization: {
    Booking: { props: ["heading"] }
  }
};

const jaToEn = await collectLocalizationUnits(kamakura, japaneseDocument, "en", extraction);
const enToJa = await collectLocalizationUnits(experience, englishDocument, "ja", extraction);
const overlay = createLocalizationOverlay(jaToEn);
```

上の例でproviderへ渡せるblock値は `heading` だけです。`href`、`productId`、未宣言のstring、任意propsは抽出しません。componentの `href` / `src` propも自動翻訳対象にしません。リンク変更はこの契約とは別の、hostによる手動・検証済み操作です。

## Rich text

単一の `TextNode` にIDがないため、それ自体を単位にしません。親のID付きelementをanchorにします。単一textはstring、複数のinline断片はHTMLではなく次のJSON treeになります。

```ts
const translated = {
  kind: "rich-text",
  children: [
    { type: "element", id: "detailsLink", tag: "a", children: [
      { type: "text", text: "Learn more" }
    ] },
    { type: "text", text: " about " },
    { type: "element", id: "important", tag: "strong", children: [
      { type: "text", text: "living by the sea" }
    ] }
  ]
};
```

安全なinline markは `a / strong / em / b / i / small / span / br` です。target言語の語順に合わせて同じ保護elementを並べ替えられますが、element ID・tag・個数を追加、削除、変更できません。深さは48段までで、markを介した場合もanchorの入れ子を拒否します。`href` やattrsはprovider表現に含まず、元documentから復元します。リンクIDとリンク先はfingerprintへ結び付けます。

paragraph内に安全に表現できないinstance等がある場合、短いtext leafへ分割せず `UNSUPPORTED_RICH_TEXT` を返します。ID付き親がない直接textは `UNANCHORED_TEXT` です。`issues` が残る限りcompletenessはfalseなので、hostは正規化するか対応範囲を明示的に増やす必要があります。

## Fingerprint

各unitの `sourceFingerprint` はWeb CryptoのSHA-256で作ります。source value、保護link参照、site/unit identity（page unitではpageId、共通componentではcomponent owner）、ja↔enの方向、文脈、glossary/context versionをcanonical JSONとして結び付けます。childrenの配列位置、revision、style、tokenは含めません。

fingerprintは変更検知・非同期結果の照合用です。認証、署名、改ざん防止の代わりではありません。hostは別途Project/Site権限を検証します。

## Candidate、手編集、確認

overlayはページ・翻訳方向・楽観versionにscopeされます。provider結果は次のenvelopeで `acceptTranslationResult` に渡します。

```ts
const result = {
  schemaVersion: 1,
  resultId: "job_42",
  siteId: jaToEn.siteId,
  pageId: jaToEn.pageId,
  sourceLocale: "ja",
  targetLocale: "en",
  baseVersion: overlay.version,
  values: jaToEn.units.filter((unit) => unit.translatable).map((unit) => ({
    unitId: unit.unitId,
    sourceFingerprint: unit.sourceFingerprint,
    value: providerOutput.get(unit.unitId)
  }))
};

const withCandidates = acceptTranslationResult(overlay, jaToEn, result);
```

受理時にsite/page/direction、現在のsource fingerprint、overlayの `baseVersion`、重複・未知unit、値の型・長さ、rich-text保護要素を検証します。生成候補内のURL、メールアドレス、数値（桁区切りの表記差を除く）も原文と一致しなければ拒否します。固有名詞は推測で保護せずhost glossaryで管理します。受理した値はcandidateにだけ入り、既存のmanual draftを上書きしません。同じ結果の再受理はversion不一致で拒否されます。

操作は分離されています。

```ts
const manuallyEdited = editLocalizedValue(withCandidates, jaToEn, {
  unitId: "page.title",
  value: "NIHOkamakura",
  expectedVersion: withCandidates.version
});

const candidate = manuallyEdited.entries.find((entry) => entry.unitId === "page.node.lead.richText")!.candidate!;
const adopted = adoptTranslationCandidate(manuallyEdited, jaToEn, {
  unitId: "page.node.lead.richText",
  expectedVersion: manuallyEdited.version,
  candidateVersion: candidate.version
});

const reviewed = reviewLocalizedValue(adopted, jaToEn, {
  unitId: "page.node.lead.richText",
  expectedVersion: adopted.version
});
```

- `editLocalizedValue`: draftだけを明示的に手編集し、以前の確認を解除します。candidateは比較用に残します。
- `adoptTranslationCandidate`: 指定versionのcandidateをdraftへ採用し、以前の確認を解除します。
- `reviewLocalizedValue`: 現在のdraftを現在のsource fingerprintに対して確認済みにします。新candidateを採用せず、既存訳を維持したまま確認することもできます。
- `localizationStatus`: `source / missing / draft / review-needed / reviewed` とcandidate、obsolete、issueの集計を返します。

原文変更後に旧draftを自動で置換せず `review-needed` にします。英語原文の日本語draftを編集しても英語原文は変更しません。逆翻訳APIはありません。

## Materialization

`await materializeLocalizedPage(config, sourceDocument, collection, overlay, options)` は、現在のsource document・component library・configからunitを非同期で再抽出し、順序に依存せずcollection全体を照合してから、candidateではなくdraftだけを適用します。sourceの移動やstyle変更だけなら同じ安定unitとして扱い、本文、config context/glossary/direction、component内容、保護hrefが変わった古いcollectionや改変collectionは拒否します。pageId、node/component ID、構造（rich-text内の安全な語順変更を除く）、style、token、金額、在庫、予約ID、hrefはsourceを維持し、targetの明示的なPageDocument localeへ変えます。戻り値は既存parserで再検証済みです。

画像asset unitは `required: false` / `translatable: false` です。overrideがなければsource assetを共有し、completenessを妨げません。差し替える場合は `editLocalizedValue` へ `{ kind: "asset", asset: { provider, id } }` を渡し、既存asset validatorを通します。provider URLは受け付けません。

```ts
const preview = await materializeLocalizedPage(kamakura, japaneseDocument, jaToEn, reviewed, extraction);
preview.document.locale; // "en"
preview.document.pageId === japaneseDocument.pageId; // true
preview.status.complete; // 全required unitがreviewedでissuesがなければtrue
```

公開snapshotはこのcore overlayとは別です。hostは公開時点でページ、共通component、route/SEO manifestを同じreleaseへ固定し、過去の公開targetをdraft更新で置換しないでください。

## 公開API

- Config/mapping: `parseSiteLocalizationConfig`, `documentLocaleFor`, `localizationLocaleFor`
- Extraction/fingerprint: `collectLocalizationUnits`
- Persistence parsing/construction: `parseLocalizationOverlay`, `createLocalizationOverlay`
- Candidate/draft/review: `acceptTranslationResult`, `editLocalizedValue`, `adoptTranslationCandidate`, `reviewLocalizedValue`
- Output/status: `materializeLocalizedPage`, `localizationStatus`

すべてのparserと操作は未知field・非plain object・上限超過を拒否し、新しいdetached valueを返します。
