# NIHO Web Studio host

Issue #68 の Studio host です。共有 `@niho/web` ライブラリとは別に Cloudflare Workers へ配置し、静的 React UI、Worker API、Studio 専用 D1 registry を1つの境界として運用します。

## この host が所有するもの

- Cloudflare Access の Google ログイン後に使う Studio shell
- `1 Project = 1 Site` の registry と `owner` / `editor` membership
- owner による期限付き one-time 招待、権限変更、参加解除、招待取消
- `project-kamakura` / `kamakura` と `project-experience` / `experience` の安定した Project / Site ID
- 参加 Project の一覧と、Project・Site ID を含む安定 URL の Dashboard

D1 が Project / Site / Member / Role / Invitation / Audit の正本です。NIHO account、niho-app の User / Project DB、NIHO cookie、Cloudflare dashboard membership は権限根拠にしません。Kamakura の content CMS はそのサイト側、Experience の contributor content は niho-app 側に残ります。

編集・保存・公開 bridge は Issue #69 / #70 の範囲で、まだ接続されていません。この host は公開状態や解析値を合成せず、`unknown` / `unavailable` / `disconnected` / `null` のまま表示します。

## 認証・認可境界

Cloudflare Access 側で Studio hostname 全体を Access application として保護します。そのうえで Worker は静的 HTML/JS/CSS と API の全 request について `Cf-Access-Jwt-Assertion` を検証します。

- `alg=RS256` と `kid` を確認し、設定した issuer の `/cdn-cgi/access/certs` から取得した JWKS で署名検証する
- `iss`、Access application の `aud`、`exp`、`iat`、任意の `nbf` を検証する
- app identity token の `type=app`、空でない安定 `sub`、IdP で検証済みの `email` claim を必須にする。service token の空 `sub` や app token 以外は受け付けない
- email は ASCII の通常形式だけを受け付け、小文字へ正規化する。不正形式、前後空白、制御文字、複数の `@` は拒否する
- email や request URL の Project ID だけを membership として信用しない。Project 読取と owner 操作は request ごとに D1 の現在 membership を照合する
- owner 操作の SQL 自体にも actor の owner 条件を入れ、D1 `batch()` の transaction 内で mutation と audit を実行する
- 最後の owner の削除・降格は DB trigger が transaction 内で拒否するため、同時 request でも迂回できない
- 非参加者には Project の存在・名称を返さない。ただし、検証済み email に明示的に宛てられた有効な招待 token を提示した場合だけ、受諾に必要な Project / Site 名と role を返す
- membership revoke は次の API request から有効になる
- API と静的応答は `no-store`。CSP、frame 拒否、MIME sniff 拒否等を付与する

API mutation は `POST` のみです。request URL と完全一致する `Origin`、`Sec-Fetch-Site: same-origin`、`application/json`、16 KiB の streaming 上限、JSON object、endpoint ごとの完全な key set を必須にします。token や token hash は application log に出力しません。

## Migration と初回セットアップ

前提: Node.js 22、依存関係、Wrangler CLI。Wrangler は環境側で管理し、Cloudflare にログイン済みの operator が実行します。

1. NIHO アカウントに作成済みの `niho-web-studio` D1 と `studio/wrangler.toml` の binding・account ID を照合する。token、credential、実メールアドレスはリポジトリへ書かない。
2. 作成済みの専用 Cloudflare Access application `NIHO Web Studio` が `studio.niho.life` 全体を保護し、専用ポリシー `Allow NIHO Web Studio staff`（Google ログインと `@niho.life`）のみを使うことを照合する。Cloudflare dashboard membership を Studio role として使わない。Access session は 12 時間、Cookie は HttpOnly。
3. 作成済み Access application の AUD tag と `ACCESS_AUDIENCE`、issuer `https://niho-coliving.cloudflareaccess.com` を照合する。
4. build と migration を実行する。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
```

`0001_studio_registry.sql` は2つの Project/Site を seed し、membership を暗黙追加しません。`0002_membership_administration.sql` は既存 membership を保持したまま nullable email、招待、audit を追加します。Migration は additive で、既存 owner bootstrap を壊しません。`public_origin` も実接続を確認するまで `NULL` のままです。

## owner の out-of-band bootstrap

最初の owner だけは招待では作れないため、既存どおり operator が out-of-band で追加します。候補 owner が Access 経由で Studio に入り、署名検証済み `GET /api/session` の `subject` と `email` を本人確認します。operator は本人と対象 Project を別経路で確認してから D1 へ明示的に追加します。

以下の placeholder をローカルで置換して実行します。実 `sub`、氏名、メールをファイルや shell history に残さない運用を推奨します。email は小文字へ正規化してください。

```sql
INSERT INTO project_members (project_id, access_subject, role, display_name, email)
VALUES ('project-kamakura', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>', '<verified-email@example.com>');

INSERT INTO project_members (project_id, access_subject, role, display_name, email)
VALUES ('project-experience', '<VERIFIED_ACCESS_SUB>', 'owner', '<DISPLAY_NAME>', '<verified-email@example.com>');
```

`0001` 時点ですでに追加済みの member は email が `NULL` のままでも利用できます。owner UI では「メール未登録（bootstrap）」と表示されます。招待による新規 member は Access email が保存されます。

## 招待と member 管理の運用

Dashboard 下部の「メンバー管理」は、現在 D1 で owner のユーザーだけに表示されます。

1. owner が email、`editor` または `owner`、1・3・7日の期限を指定して招待を作成する。
2. Worker は 32 byte の暗号学的乱数 token を生成し、D1 には SHA-256 hash だけを保存する。
3. creation response にだけ招待 URL を返す。未ログインでも Access の認証後に招待へ戻れるよう、token は一回限りの URL query に入れる。Studio は読み取り後すぐ address bar から query を除去する。Access やブラウザの履歴には一時的に URL が残り得るため、安全な経路で本人にだけ共有する。
4. owner が URL を安全な別経路で本人へ共有する。Studio はメールを送信しない。
5. 招待先本人が Access へ同じ email でログインし、表示内容を確認して「招待を承諾する」を押す。
6. D1 transaction が、未使用・未取消・期限内・email 一致を再確認し、membership insert、token consume、audit insert を一括実行する。email 一致だけの auto join は行わない。

招待 URL は creation response 後に再表示できません。紛失時は古い pending 招待を取消し、新しい招待を作成します。owner は pending 招待の取消、owner/editor の変更、member の削除ができます。最後の owner は必ず残ります。各成功操作は `actor_subject`、action、Project、target、時刻を `studio_audit_records` へ記録し、raw token は記録しません。

## API scope

Project 固有 API はすべて次の prefix 配下です。

```text
/api/projects/:projectId/sites/:siteId/
```

- `GET dashboard`: 現在 member のみ
- `GET membership`: 現在 owner の member / invitation 一覧
- `POST invitations`: owner の招待作成
- `POST invitations/revoke`: owner の pending 招待取消
- `POST members/role`: owner の昇格・降格
- `POST members/remove`: owner の member 削除
- `POST invitations/preview`: 招待 token hash、scope、verified email が一致する本人だけ
- `POST invitations/accept`: 本人の明示承諾。membership と token consume を atomic に実行

unknown Project/Site と権限のない Project/Site は、外部から区別できる詳細を返しません。owner API が返す member 情報は、その owner が管理する同一 Project に限定します。

## local 確認と配置

```sh
npm run studio:typecheck
npm run studio:build
wrangler dev --config studio/wrangler.toml
```

ローカルでも Worker は実 Access JWT を要求します。JWT 検証を迂回する development mode は設けていません。配置前に Access application の hostname、issuer、AUD、D1 binding、custom domain を相互確認し、`wrangler deploy --config studio/wrangler.toml` を実行します。

## 制約と follow-up

- Editor bridge は未接続です。現在も編集・保存・公開はできません。Issue #69 / #70 で各 site-local API を接続し、その全操作でも現在 membership と site 固定を再検証します。
- 招待メールの配信、再送、token の再表示はありません。URL の安全な共有は owner の運用責任です。
- Access email の変更や IdP account の統合は自動追従しません。membership の主体は安定 `sub` で、保存 email は招待照合と owner 表示用です。
- out-of-band bootstrap SQL 自体は application audit に自動記録されません。operator 側の変更記録を残してください。
- audit の閲覧 UI/API、保持期間、export は未実装です。D1 には改変・削除を拒否する record として保存します。
