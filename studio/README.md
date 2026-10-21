# NIHO Web Studio host

Issue #68 の Studio host です。共有 `@niho/web` ライブラリとは別に Cloudflare Workers へ配置し、静的 React UI、Worker API、Studio 専用 D1 registry を1つの境界として運用します。

## この host が所有するもの

- Cloudflare Access の Google ログイン後に使う Studio shell
- `1 Project = 1 Site` の registry と `owner` / `editor` membership
- `project-kamakura` / `kamakura` と `project-experience` / `experience` の安定した Project / Site ID
- 参加 Project の一覧と、Project・Site ID を含む安定URLの Dashboard

NIHO account、niho-app の User / Project DB、NIHO cookie、Cloudflare dashboard membership は権限根拠にしません。Kamakura の content CMS はそのサイト側、Experience の contributor content は niho-app 側に残ります。編集・保存・公開 bridge は Issue #69 / #70 の範囲で、この host は動作を装いません。

## 認証・認可境界

Cloudflare Access 側でも Studio hostname 全体を Access application で保護します。そのうえで Worker は静的 HTML/JS/CSS と API の全リクエストについて `Cf-Access-Jwt-Assertion` を検証します。

- `alg=RS256` と `kid` を確認し、設定した issuer の `/cdn-cgi/access/certs` から取得した JWKS で署名検証する
- `iss`、Access application の `aud`、`exp`、`iat`、任意の `nbf`、空でない安定 `sub` を検証する
- email やリクエストURLの Project IDだけを membership として信用しない
- directory / dashboard の各読取で、検証済み `sub` と D1 membership を再照合する。membership revoke は次の API request から有効になる
- 非参加・未知・古い Project/Site の Dashboard は同じ `forbidden` 応答にし、存在を区別させない
- API と静的応答は `no-store`。CSP、frame拒否、MIME sniff拒否等を付与する

現時点の API は read-only です。GET 以外は認証後に、同一 origin、`Sec-Fetch-Site`、JSON content type、16 KiB 上限、JSON object であることを確認したうえで `405` にします。将来の save/publish API も、同じ入口と各requestのD1 membership再照合を通す必要があります。

## 初回セットアップ（まだ deploy しない）

前提: Node.js 22、依存関係、Wrangler CLI。Wrangler は環境側で管理し、Cloudflare にログイン済みの operator が実行します。

1. 新しい D1 database を作成する。
2. `studio/wrangler.toml` の `database_id` をその database IDへ置き換える。account ID、token、credential、実メールアドレスはリポジトリへ書かない。
3. Google IdPを使う専用 Cloudflare Access application を Studio hostname 全体に作成する。許可対象は Access policy で明示する。Cloudflare dashboard membership を Studio role として使わない。
4. Access application の issuer（末尾slashなしの正確なHTTPS origin）と AUD tag を `ACCESS_ISSUER` / `ACCESS_AUDIENCE` に設定する。
5. build と migration を実行する。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
```

Migration は2つの Project/Siteだけを seed し、membership は1件も暗黙追加しません。`public_origin` も、実接続を確認するまで `NULL` のままです。

## owner の out-of-band bootstrap

email では追加しません。まず候補 owner が Access 経由で Studio に入り、認証済み `GET /api/session` の応答から自分の `subject` を確認します。この endpoint の値は Worker が署名検証した Access `sub` です。operator は本人と対象 Project を別経路で確認してから、D1へ明示的に追加します。

以下の placeholder をローカルで置換して実行します。実 `sub`、氏名、メールをファイルや shell history に残さない運用を推奨します。

```sql
INSERT INTO project_members (project_id, access_subject, role, display_name)
VALUES ('project-kamakura', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>');

INSERT INTO project_members (project_id, access_subject, role, display_name)
VALUES ('project-experience', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>');
```

通常の member provisioning も当面は同じく operator が、検証済み Access `sub` を out-of-band で確認して D1 に追加します。email一致だけの自己登録はありません。DB trigger が最後の owner の削除・editorへの降格を拒否し、Project/Site IDと結び付きを不変にします。

## local確認と配置

```sh
npm run studio:typecheck
npm run studio:build
wrangler dev --config studio/wrangler.toml
```

ローカルでも Worker は実 Access JWT を要求します。JWT検証を迂回する development mode は設けていません。配置前に Access application のhostname、issuer、AUD、D1 binding、custom domainを相互確認し、`wrangler deploy --config studio/wrangler.toml` を実行します。本変更では deploy しません。

## 必須 follow-up

- Issue #69 / #70: 各 site-local APIへの editor bridge。save/publishを含む全操作で現在のmembershipとsite固定を再検証する。
- 招待を追加する場合: owner発行、one-time、期限付き、十分なentropy、保存時hash化、Accessで検証済みemail claimとの一致、明示acceptを必須にする。emailだけのauto-joinは禁止する。
- member管理UI/APIを追加する場合: owner限定、CSRF/JSON/body/input境界、同一Project scope、最後のowner保護、監査証跡を実装する。現在は未実装で、偽の招待・設定UIは表示しない。
- 公開状態・解析・更新日時は接続元ができるまで `unknown` / `unavailable` / `disconnected` / `null` のまま扱い、合成値を入れない。
