# native SitePresentation 契約

`SitePresentation` は、編集対象の `PageDocument` の外側にサイト固有の見た目を合成する、任意の versioned snapshot です。従来文書はこの値なしで従来どおり描画できます。

- `siteId`・`locale` は編集対象、header、footer の全てで一致させる。`version` はフォント manifest・layout・共有文書依存を固定する opaque な版とする。
- `reset` は現在 `neutral-v1` のみ。`layout` は `NodeStyle`、`tokens` は既存 design token、`fonts` は HTTPS/root-relative の安全な woff/woff2 URLと有限 descriptorだけを受け付ける。CSS文字列・実行コード・任意HTMLは受け付けない。
- `shared.header` / `shared.footer` は canonical な別 `PageDocument`。本文へ複製して保存しない。共有文書自身を編集するときは対応slotの文書だけを置換し、本文slotには重複表示しない。
- `SitePageRenderer` と `renderSitePageToHtml` は、同じ reset・`@font-face`・layout・header/body/footer composition を使う。各文書は別 `data-nw-owner` scope のため、本文キャンバスの選択・ドラッグは共有枠へ越境しない。
- `presentationAssetDocument` は素材解決用の一時的なbody結合だけに使う。保存対象にしてはならない。
- presentation がある snapshot の保存・公開確認・公開実行は `presentationVersion` をCASする。履歴snapshotに presentation がない旧版へ、現在の共有枠を暗黙に混ぜない。
- 必須presentationを持つホストは、欠落・対象不一致・不正フォント・不正共有文書を見えるエラーとして止める。部分表示へ黙ってフォールバックしない。

検証の中心は `test/presentation.test.mjs`、実PageEditorでの保存scopeと5px空要素は `test/editor-style-ui.test.mjs`、project境界は `test/project-adapter.test.mjs` で確認します。

Kamakura catalog は `nativePresentationPages` で必須対象を明示する。旧 backend の省略は空配列として互換を保つ。対象ページで presentation が欠落すると読込を拒否する。フォント用CSPはKamakura editorの固定media prefixだけに限定し、他editor・Dashboardには追加しない。

CSS生成は数字で始まる単語を含むフォント名も正しく引用する。layout自身のselectorと子孫scopeを分け、composition wrapperだけを `display:contents` にする。Editorは選択outlineで装飾を表示し、空要素の実寸を変更しない。

実サイトのfixtureを使うローカル検証は `KAMAKURA_SITE_FIXTURE=/absolute/path/to/kamakura-site npm run demo:kamakura`。保存先はメモリ内だけで、公開APIは呼ばない。

## native overlay

任意の `overlays`（最大8件）は、canonicalな別PageDocumentとid・label・triggerIds・closeIdsだけを持つ。実行コードは含めない。対象site/locale、文書IDと操作IDの重複、件数上限を検証する。共有メニューの編集は対応するoverlay slotだけを差し替え、本文へは保存しない。

`initializeSitePresentation` は同じ信頼済みruntimeを公開SSRとEditorプレビューで使い、開閉・Escape・Tab循環・フォーカス復帰・スクロール固定を行う。呼び直す前に返されたcleanupを呼ぶ。スクロール固定時もgutterを維持し、表示幅を変えない。Editorのプレビューではoverlay操作とメニューを閉じる操作だけを通し、ページ遷移・フォーム送信は引き続き止める。

公開ホストは `@niho/web/presentation-runtime` から初期化する。JSONからJavaScript・CSSを読み込む経路や、iframe sandbox/CSPの緩和は追加しない。overlayの公開済み文書と表示設定も依存SHA・公開commitのCAS対象に含める。

## host-owned display view

`hostViews` は、CMS・予約・カレンダー・地図・カルーセルのようにホストが所有する表示を、本文のblock propsと完全一致させて合成する任意のsnapshotです。本文には元のcomponentとpropsだけを保存し、展開済みの表示文書は下書きへ保存しません。

- 一致keyは登録済みblock名と、block contractで正規化したpropsです。同じkeyの重複、未知props、対象site/localeの不一致、presentation内のpageId再利用を拒否します。対象block用のview集合が有効なとき、一致するviewがなければsample componentへfallbackせず描画を止めます。
- viewの`document`は安全な`PageDocument`だけです。component/instanceを含められず、再帰できません。view数、合計JSON bytes、node数、slot binding数を上限内に制限します。`presentationAssetDocument`はviewも素材解決へ含めますが、編集・保存対象にはしません。
- `slotBindings` はblock contractで宣言済みのslotだけを、view内の一意なelement IDへ結びます。本文componentのslot style規則はこの要素へ通常どおり適用されます。
- `externalFrames` は空の`div`を置換する読み取り専用iframe descriptorです。HTTPS、title、loading、限定referrer policy、fullscreen flagと、任意の論理`frameKey`＋数値上限だけを受け付け、資格情報・制御文字・markup delimiterを拒否します。rendererは既定でopaqueな`sandbox="allow-scripts"`、幅・高さ100%、border 0を付けます。任意の`sandbox` / `allow` / HTMLは指定できません。接続先hostの許可リストは統合側でさらに狭めます。Google Mapsのようなorigin維持が必要な外部サービスは、信頼する実行コード側で`createExternalFramePolicy({parentOrigin, sources})`を渡します。同一originは禁止し、HTTPSの完全なoriginとpathだけを照合します。JSONからsandbox権限を要求することはできません。自動高さ通知は送信元iframe window、opaque origin、type/key、100px以上の整数、descriptor上限の全条件が一致した場合だけ反映し、cleanup時に戻します。
- `carousel` はroot・全slide・prev/next/play操作の既知IDと、上限付きinterval・fadeMs、loop、swipeだけを宣言します。runtimeは先頭slideから決定的に開始し、非表示slideをlayoutから外し、hover/focus/reduced-motion時にautoplayを止め、cleanupでtimer/listener/animation/属性を戻します。fadeMsは重なるslide用のクロスフェードで、reduced-motionまたはWeb Animations未対応なら即時切替です。frame高さは編集モードでも再要求し、Editorのpreviewではpresentation runtimeの操作だけを通し、通常のlink遷移やform送信は止めます。
- native `details` / `summary` は文書の`open`有無を初期状態とし、Editorプレビューでもsummaryの標準開閉を許可します。選択・編集境界は従来どおり本文owner scopeに限定します。

受け手の互換性を先に配備します。順序は (1) library/Studio reader、(2) site Worker/static reader、(3) `hostViews`を含むnative dataです。CMS等からbuild時にコンパイルするviewは、検証済みview本体だけの決定的`contentHash`を`presentationVersion`へ含めます（hash自身は入力にしません）。編集可能本文へviewを保存せず、旧sampleや古いsnapshotへ黙って戻しません。config/fonts/shared文書などcanonical Git resourceは引き続きblob SHA集合でCASします。

`SitePageRenderer`とSSRの既定`hostViewMode="prefer"`はStudio/静的確認用のdisplay viewを優先します。実公開hostが送信可能form等の実componentを所有するときは`fallback`（実componentがあれば優先）または`off`を明示し、読み取り専用表示で置換しないでください。
