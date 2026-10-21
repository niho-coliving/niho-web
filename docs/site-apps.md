# サイト設定の連携画面

`@niho/web/site-apps` の `SiteApps` は「サイト設定 > 連携」に埋め込むReactコンポーネントです。GA4とSearch Consoleだけを表示し、計測タグとGA4レポート、サイト所有権とSearch Consoleレポートの状態・操作を分けます。CSSはコンポーネントがscopeして出力し、既存の `--niho-*` 色tokenを利用します。

```tsx
import { SiteApps } from '@niho/web/site-apps';
import type { SiteAnalyticsConnectionAdapter } from '@niho/web/site-analytics';

// 全メソッドでホストが認証・認可し、Google API・保存・公開反映を実装する。
const adapter: SiteAnalyticsConnectionAdapter = hostSiteAnalyticsAdapter;

<SiteApps
  target={{ projectId: selectedProject.id, siteId: selectedProject.site.id,
    siteOrigin: approvedPublicOrigin }}
  adapter={adapter}
  projectName={selectedProject.name}
  siteName={selectedProject.site.name}
/>;
```

`ProjectDashboard.onOpenSettings(project, 'analytics')` からホストの設定画面へ遷移し、このコンポーネントを表示してください。ホストが運営承認済みの正確な公開originを渡します。名前は任意で、未指定時はIDを表示します。認証・権限変更時にはadapter参照を差し替えるかunmountしてください。同じ対象の通常再描画ではadapter参照を維持します。

状態と変更計画は既存の [サイト分析接続契約](site-analytics-contract.md) のparserで検証します。変更はprepare → parser → 対象project/site/origin・現在値と次値の確認 → apply → `readConnection` の順です。所有権確認はpropertyとmethodも要求と照合し、公開確認コードだけを表示します。一回用のconfirmation tokenは表示・保存しません。有効期限は適用直前にも検証します。

apply、接続確認、同期retryの返り値は画面の状態として採用せず、その後の `readConnection` の検証済み応答を表示します。applyが失敗した場合や再取得に失敗した場合は直前の接続状態を保ち、再読込を案内します。変更結果が不明な間は次の変更を止め、再読込の成功後に操作を再開します。対象project/site/origin・adapter変更時には画面を再生成し、進行中のsignalをabortします。abortを無視した古い応答も採用しません。ホストはabort後もサーバーで変更が完了する可能性を考慮し、操作の冪等性とtokenの一回性を保証してください。

画面全体の権限なしは、ホストが `SiteAppsPermissionError`、または数値 `status: 401 | 403` を持つ例外を投げて通知します。権限エラーでは接続詳細と操作を隠し、管理者確認と再読込を案内します。サービス側の権限不足・失効は `reportingState` で別に表示します。任意の例外文は画面に出しません。

URLプレフィックスとdomain propertyはそのまま保持します。domain propertyはDNS所有確認に使えますが、レポート接続は対象originのルートURLプレフィックス完全一致だけに限定します。所有確認・レポート解除・計測タグ削除はそれぞれ別操作です。解除や差替え時の集計キャッシュ無効化、確認タグの公開範囲、Google権限検証はホストの責務です。

フォームはnative label/input/buttonと折返しを使います。確認画面はfocus移動・Tab循環・Escape取消・終了時のfocus復帰を持ち、背面はinertにします。320pxでも単一列で操作できます。
