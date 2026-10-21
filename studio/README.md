# NIHO Web Studio host

Issue #68 / #69 / #70 の Studio host です。共有 `@niho/web` ライブラリとは別に Cloudflare Workers へ配置し、静的 React UI、Worker API、Studio 専用 D1 registry、Experience / Kamakura editor BFF を1つの境界として運用します。

## この host が所有するもの

- Cloudflare Access の Google ログイン後に使う Studio shell
- `1 Project = 1 Site` の registry と `owner` / `editor` membership
- owner による期限付き one-time 招待、権限変更、参加解除、招待取消
- `project-kamakura` / `kamakura` と `project-experience` / `experience` の安定した Project / Site ID
- 参加 Project の一覧と、Project・Site ID を含む安定 URL の Dashboard
- `project-experience` / `experience` に限定した、下書き・プレビュー・公開・公開版への復元用 editor BFF
- `project-kamakura` / `kamakura` に限定し、Cloudflare service binding で `kamakura-site` の新形式共通ページだけへ接続する editor BFF

D1 が Project / Site / Member / Role / Invitation / Audit の正本です。NIHO account、niho-app の User / Project DB、NIHO cookie、Cloudflare dashboard membership は権限根拠にしません。Kamakura の content CMS はそのサイト側、Experience の contributor content は niho-app 側に残ります。

Experience と Kamakura の Editor UI / BFF は実装されています。Experience の本番編集は niho-app Backend Draft PR #19268 の本番反映と本番 bridge secret の設定まで有効化しません。STG検証画面は `/projects/project-experience/sites/experience/editor/staging` に限り、D1 の Experience owner のみ開けます。画面・APIの両方で owner を確認し、固定した `https://api-stg.niho.life` と別の `NIHO_STUDIO_BRIDGE_SECRET_STG` を使います。Kamakura は `kamakura-site` の内部 endpoint、service binding `KAMAKURA_SITE`、両 Worker の `KAMAKURA_STUDIO_BRIDGE_SECRET` が揃った後に利用します。この host は Dashboard の公開状態や解析値を合成せず、`unknown` / `unavailable` / `disconnected` / `null` のまま表示します。

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
- Experience / Kamakura editor の list/read/save/release 各 request でも、Access `sub`、固定 Project/Site、D1 の現在の `owner` / `editor` membership を再照合する
- API と静的応答は `no-store`。CSP、frame 拒否、MIME sniff 拒否等を付与する

Member 管理 mutation は従来どおり `POST` のみです。request URL と完全一致する `Origin`、`Sec-Fetch-Site: same-origin`、`application/json`、16 KiB の streaming 上限、JSON object、endpoint ごとの完全な key set を必須にします。この 16 KiB 境界は editor 追加後も変更しません。Editor mutation も同じ same-origin / JSON 条件を要求し、draft だけ 600 KiB、release-plan / release は 16 KiB の streaming 上限です。token、token hash、JWT、HMAC secret、request body は application log に出力しません。

## Experience editor bridge

通常編集は同一 origin の `/api/projects/project-experience/sites/experience/editor`、STG検証は `/api/projects/project-experience/sites/experience/editor-staging` だけを呼びます。ブラウザは NIHO API、NIHO cookie、bridge secret へ直接アクセスしません。BFF は query string、別 Project/Site、allowlist 外 page ID、未知の route/method を拒否します。対象 page ID は `home`、`experiences`、`experience-detail`、`booking`、`host`、`chrome`、locale は `en`、公開先は `https://experience.niho.life` に固定します。components / localization / assets API は backend にないため接続しません。

上流は固定 origin `https://api.niho.life`、prefix `/api/internal/studio/experience` です。各 request は browser cookie や Access JWT を転送せず、次の header だけで Studio identity を渡します。

```text
X-NIHO-Studio-Project: project-experience
X-NIHO-Studio-Subject: <verified Access sub>
X-NIHO-Studio-Timestamp: <unix seconds>
X-NIHO-Studio-Signature: v1=<lowercase hex HMAC-SHA256>
```

署名 message は次の改行区切りです。`rawBody` は転送する body の同一 byte 列で、GET は空 byte 列の SHA-256 です。

```text
v1\n${timestamp}\n${method}\n${pathname}\n${sha256hex(rawBody)}\n${project}\n${subject}
```

`NIHO_STUDIO_BRIDGE_SECRET` は padding なし canonical base64url で、decode 後 32 byte 以上を必須にします。欠落・不正なら fail-closed 503 です。上流 fetch は redirect を追跡せず、timeout、`no-store`、JSON media type、2 MiB response 上限を適用します。3xx、非 JSON、上限超過、上流 401/403/404/429/5xx は Studio の Access session error と混同せず 503 にします。409 だけ editor conflict として保持します。

STG検証は同じ allowlist と署名契約を使いますが、上流は固定 `https://api-stg.niho.life`、鍵は `NIHO_STUDIO_BRIDGE_SECRET_STG` です。STG UI は環境を明示します。通常の Experience editor ルートや本番用 key/origin は切り替えません。STG API が未配備、secret が無効、または owner 以外なら閉じます。公開・復元の受入操作は STG API 上でのみ行い、本番 API へは送信しません。

Editor HTML route だけ `PageEditor` の inline style と `iframe srcDoc` に必要な `style-src 'unsafe-inline'` / `frame-src 'self'` を追加します。`script-src 'self'` は維持し、Directory / Dashboard など他 route の CSP は緩和しません。

## Kamakura editor bridge

ブラウザは同一 origin の `/api/projects/project-kamakura/sites/kamakura/editor` 配下だけを呼びます。利用できる route は `GET catalog`、`GET :pageId`、`PUT :pageId/draft`、`POST :pageId/release-plan`、`POST :pageId/release` だけです。`pageId` は `^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$` に固定し、query string、未知の route / method、600 KiB を超える draft を拒否します。

上流は Cloudflare service binding `KAMAKURA_SITE`（service `kamakura-site`）だけです。署名用 URL は `https://next-kamakura.niho.life/internal/studio/web-content/...` に固定し、任意 origin のネットワーク fetch や generic proxy にはしません。browser cookie、Cloudflare Access JWT、NIHO account 情報は転送しません。各 request は Experience と同じ HMAC message 形式で、Project header だけ `project-kamakura` を使います。secret は別の `KAMAKURA_STUDIO_BRIDGE_SECRET` とし、canonical base64url、decode 後 32 byte 以上を必須にします。

上流応答は redirect 拒否、timeout、JSON media type、2 MiB 上限を適用します。409 は editor conflict として保持し、上流の 401 / 403 は Studio の Access session expiry に変換せず 503 として扱います。catalog は Project / Site metadata、`ja` の新形式 page ID、旧形式 page path、件数、重複を BFF で検証し、既知 field だけを browser へ返します。

Kamakura の `PageEditor` が編集するのは `src/site/niho-web` の新形式ページだけです。現時点では0件のため、UI は移行待ちを明示し、catalog の旧形式一覧を読み取り専用で表示します。旧形式のデザインは `https://next-kamakura.niho.life/admin/pages`、記事・サークル・会社などの CMS は `https://next-kamakura.niho.life/admin` で引き続き編集します。Studio は CMS を変更せず、STUDIO からの全面移行を完了扱いにしません。source of truth は `studio` のままで、移行作業は kamakura-site #42 に残ります。

Kamakura の editor route にも Experience と同じ範囲限定 CSP 緩和を適用します。Directory / Dashboard / invite route の CSP は変えません。

## Migration と初回セットアップ

前提: Node.js 22、依存関係、Wrangler CLI。Wrangler は環境側で管理し、Cloudflare にログイン済みの operator が実行します。

1. NIHO アカウントに作成済みの `niho-web-studio` D1 と `studio/wrangler.toml` の binding・account ID を照合する。token、credential、実メールアドレスはリポジトリへ書かない。
2. 作成済みの専用 Cloudflare Access application `NIHO Web Studio` が `studio.niho.life` 全体を保護し、専用ポリシー `Allow NIHO Web Studio staff`（Google ログインと `@niho.life`）のみを使うことを照合する。Cloudflare dashboard membership を Studio role として使わない。Access session は 12 時間、Cookie は HttpOnly。
3. 作成済み Access application の AUD tag と `ACCESS_AUDIENCE`、issuer `https://niho-coliving.cloudflareaccess.com` を照合する。
4. まず NIHO API STG と Studio Worker に、STG 専用 `NIHO_STUDIO_BRIDGE_SECRET_STG` を同じ値で設定する。STG用と本番用の secret は別にする。Kamakura の secret もExperienceとは共用しない。本番 Experience secret は本番受入時まで設定しない。値を shell 引数、リポジトリ、ログへ残さず、対話入力または承認済みの secret handling で設定する。

```sh
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
wrangler secret put NIHO_STUDIO_BRIDGE_SECRET_STG --config studio/wrangler.toml
wrangler secret put KAMAKURA_STUDIO_BRIDGE_SECRET --config studio/wrangler.toml
```

`NIHO_STUDIO_BRIDGE_SECRET_STG` には NIHO API STG が参照する Secret Manager の値だけを設定します。本番値との共用は禁止です。Secret Manager から Cloudflare へ移すときも対話型またはログに出ない承認済みの secret handling を使い、shell 引数・ファイル・ログ・Issue に値を残しません。

5. `studio/wrangler.toml` の `KAMAKURA_SITE` が同じ Cloudflare account の service `kamakura-site` を指すことを確認する。
6. Experience STG は、(1) niho-app PR #19268 の API を STG に反映、(2) Cloud Run STG が Secret Manager の STG key を参照していることを確認、(3) Studio Worker の STG key を設定、(4) この Worker を配備、(5) owner で STG画面を開き list / read / save / release-plan / release / rollback を受入確認、の順に進める。本番用 API key や本番コンテンツはこの確認に使わない。
7. Kamakura は、(1) 両 Worker に Kamakura secret を設定、(2) `kamakura-site` の署名済み `/internal/studio/web-content/*` を先に配備、(3) Studio D1 migration `0004` を適用、(4) Studio Worker を配備、(5) catalog / save / release-plan / release / rollback を受入確認、とする。Studio を先に配備して backend 未反映を編集可能とは案内しない。

```sh
npm ci
npm run studio:typecheck
npm run studio:build
wrangler d1 migrations apply niho-web-studio --remote --config studio/wrangler.toml
```

`0001_studio_registry.sql` は2つの Project/Site を seed し、membership を暗黙追加しません。`0002_membership_administration.sql` は既存 membership を保持したまま nullable email、招待、audit を追加します。`0003_experience_site_metadata.sql` は Experience site を API と同じ metadata に更新します。`0004_kamakura_site_metadata.sql` は Kamakura site を catalog と同じ `鎌倉サイト（新サイト確認用）` / `https://next-kamakura.niho.life` に更新します。Migration は既存 membership と owner bootstrap を壊しません。

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
- Experience: `GET editor/sites`、`GET editor/sites/experience/pages`、`GET editor/sites/experience/pages/:pageId/en`（通常編集は owner/editor）
- Experience: `PUT .../draft`、`POST .../release-plan`、`POST .../release`
- Experience STG: 同じ route を `/editor-staging` 配下で提供し、owner のみ許可
- Kamakura: `GET editor/catalog`、`GET editor/:pageId`
- Kamakura: `PUT editor/:pageId/draft`、`POST editor/:pageId/release-plan`、`POST editor/:pageId/release`

unknown Project/Site と権限のない Project/Site は、外部から区別できる詳細を返しません。owner API が返す member 情報は、その owner が管理する同一 Project に限定します。

## local 確認と配置

```sh
npm run studio:typecheck
npm run studio:build
wrangler dev --config studio/wrangler.toml
```

ローカルでも Worker は実 Access JWT を要求します。JWT 検証を迂回する development mode は設けていません。配置前に Access application の hostname、issuer、AUD、D1 binding、custom domain を相互確認し、`wrangler deploy --config studio/wrangler.toml` を実行します。

## 制約と follow-up

- Experience editor は Backend Draft PR #19268 の merge・配備と、Studio Worker／NIHO API の両 secret 設定が揃うまで UI を「接続待ち」にします。直接 API は未設定時に 503 で停止します。揃う前に「本番で編集可能」と案内しません。
- Kamakura editor は新形式の共通ページだけを扱います。現時点の `src/site/niho-web` は0件で、旧形式一覧は読み取り専用です。作成、素材 upload、旧形式ページ編集、CMS 操作、全面移行はこの bridge の対象外です。
- Experience editor は production API が提供するページ文書・下書き・公開・復元だけを扱います。自由追加できない NIHO 業務ブロックは `insertableBlocks=[]` とし、components / localization / assets は未実装です。
- 招待メールの配信、再送、token の再表示はありません。URL の安全な共有は owner の運用責任です。
- Access email の変更や IdP account の統合は自動追従しません。membership の主体は安定 `sub` で、保存 email は招待照合と owner 表示用です。
- out-of-band bootstrap SQL 自体は application audit に自動記録されません。operator 側の変更記録を残してください。
- audit の閲覧 UI/API、保持期間、export は未実装です。D1 には改変・削除を拒否する record として保存します。
