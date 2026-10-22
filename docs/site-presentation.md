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
