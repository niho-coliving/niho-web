"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  parseSearchConsoleVerificationPlan, parseSiteAnalyticsChangePlan,
  parseSiteAnalyticsConnection, parseSiteAnalyticsTarget,
  type GoogleAnalyticsState, type SearchConsoleOwnershipState, type SearchConsoleProperty,
  type SearchConsoleVerificationMethod, type SearchConsoleVerificationPlan,
  type SiteAnalyticsChangeAction, type SiteAnalyticsChangePlan, type SiteAnalyticsConnection,
  type SiteAnalyticsConnectionAdapter, type SiteAnalyticsTarget, type TrackingTagState,
} from "./site-analytics.js";
import { siteAppsCss } from "./site-apps-style.js";

export { siteAppsCss } from "./site-apps-style.js";
export type { SiteAnalyticsConnectionAdapter, SiteAnalyticsTarget } from "./site-analytics.js";

export type SiteAppsProps = {
  readonly target: SiteAnalyticsTarget;
  readonly adapter: SiteAnalyticsConnectionAdapter;
  readonly projectName?: string;
  readonly siteName?: string;
};

/** Hosts may throw this for session or project permission failures. Never put secrets in error messages. */
export class SiteAppsPermissionError extends Error {
  constructor() { super("Site integration permission required"); this.name = "SiteAppsPermissionError"; }
}

type Status = GoogleAnalyticsState | TrackingTagState | SearchConsoleOwnershipState;
const labels: Record<Status, string> = {
  "not-connected": "未連携", checking: "確認中", connected: "連携済み", "permission-required": "権限が必要",
  "property-mismatch": "対象が不一致", "permission-revoked": "権限の再確認が必要", syncing: "同期中",
  "sync-delayed": "同期に遅れ", "quota-limited": "利用制限中", partial: "一部取得できません", failed: "失敗",
  "not-configured": "未設定", pending: "反映待ち", published: "公開済み", "not-verified": "未確認", verified: "確認済み",
};
function tone(status: Status): "good" | "warning" | "error" | "neutral" {
  if (["connected", "published", "verified"].includes(status)) return "good";
  if (status === "failed") return "error";
  if (["not-connected", "not-configured", "not-verified"].includes(status)) return "neutral";
  return "warning";
}
function Badge({ status }: { status: Status }) {
  return <span className="sa-badge" data-tone={tone(status)}>{labels[status]}</span>;
}
function reportHint(status: GoogleAnalyticsState): string {
  switch (status) {
    case "not-connected": return "接続すると、このサイトの分析画面にレポートを表示できます。";
    case "permission-required": case "permission-revoked": return "Google側の閲覧権限を管理者に確認し、「接続を確認」を押してください。";
    case "property-mismatch": return "公開サイトに対応するプロパティを設定してください。";
    case "failed": return "同期できませんでした。接続を確認してから再試行してください。";
    case "quota-limited": return "Google側の利用制限があります。時間をおいて再試行してください。";
    case "sync-delayed": case "partial": return "レポートが揃っていません。時間をおいて同期を再試行できます。";
    case "checking": case "syncing": return "処理中です。しばらくしてから再読込してください。";
    case "connected": return "このサイトのレポートに接続しています。";
  }
}
type Pending =
  | { readonly kind: "change"; readonly plan: SiteAnalyticsChangePlan }
  | { readonly kind: "verification"; readonly plan: SearchConsoleVerificationPlan; readonly currentProperty: string | null; readonly currentMethod: SearchConsoleVerificationMethod | null };
type Notice = { readonly error: boolean; readonly text: string };
type Operation = (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>;

function permissionFailure(error: unknown): boolean {
  return error instanceof SiteAppsPermissionError || (typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403));
}

/** A new target or adapter gets a new session before any old connection can render. */
export function SiteApps(props: SiteAppsProps) {
  const { target, adapter } = props;
  const [source, setSource] = useState({ adapter, projectId: target.projectId, siteId: target.siteId, siteOrigin: target.siteOrigin, generation: 0 });
  if (source.adapter !== adapter || source.projectId !== target.projectId || source.siteId !== target.siteId || source.siteOrigin !== target.siteOrigin) {
    setSource({ adapter, projectId: target.projectId, siteId: target.siteId, siteOrigin: target.siteOrigin, generation: source.generation + 1 });
    return null;
  }
  return <SiteAppsSession key={source.generation} {...props} />;
}

function SiteAppsSession({ target: inputTarget, adapter, projectName, siteName }: SiteAppsProps) {
  const target = useMemo(() => { try { return parseSiteAnalyticsTarget(inputTarget); } catch { return null; } }, [inputTarget.projectId, inputTarget.siteId, inputTarget.siteOrigin]);
  const [connection, setConnection] = useState<SiteAnalyticsConnection | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [forbidden, setForbidden] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [measurementId, setMeasurementId] = useState(""), [propertyId, setPropertyId] = useState("");
  const [propertyKind, setPropertyKind] = useState<SearchConsoleProperty["kind"]>("url-prefix");
  const [propertyValue, setPropertyValue] = useState(target ? `${target.siteOrigin}/` : "");
  const [method, setMethod] = useState<SearchConsoleVerificationMethod>("meta-tag");
  const active = useRef<AbortController | null>(null);
  const id = useId();

  const run = useCallback(async (operation: Operation, failure: string) => {
    if (active.current || !target) return;
    const controller = new AbortController();
    active.current = controller;
    const isCurrent = () => !controller.signal.aborted && active.current === controller;
    setBusy(true); setNotice(null);
    try { await operation(controller.signal, isCurrent); }
    catch (error) {
      if (isCurrent()) {
        if (permissionFailure(error)) { setForbidden(true); setPending(null); }
        setNotice({ error: true, text: permissionFailure(error) ? "このサイトの連携を表示・変更する権限がありません。管理者に確認してから再読込してください。" : failure });
      }
    } finally {
      if (isCurrent()) { active.current = null; setBusy(false); setLoading(false); }
    }
  }, [target]);

  const read = useCallback(async (signal: AbortSignal, isCurrent: () => boolean) => {
    if (!target || !isCurrent()) return;
    const response = await adapter.readConnection(target, signal);
    if (!isCurrent()) return;
    const value = parseSiteAnalyticsConnection(response, target);
    setConnection(value); setForbidden(false); setNeedsReload(false);
  }, [adapter, target]);

  const reload = useCallback(() => {
    setPending(null);
    void run(read, "連携情報を読み込めませんでした。再読込してください。前回取得した状態がある場合は、その状態を表示しています。");
  }, [read, run]);

  useEffect(() => {
    reload();
    return () => { active.current?.abort(); active.current = null; };
  }, [reload]);

  function prepare(action: SiteAnalyticsChangeAction) {
    if (!target || needsReload || forbidden) return;
    void run(async (signal, isCurrent) => {
      let response: unknown;
      switch (action) {
        case "publish-ga4-tag": response = await adapter.prepareGa4TrackingTag({ target, measurementId: measurementId.trim() }, signal); break;
        case "remove-ga4-tag": response = await adapter.prepareGa4TrackingTagRemoval(target, signal); break;
        case "connect-ga4": response = await adapter.prepareGa4ReportingConnection({ target, propertyId: propertyId.trim() }, signal); break;
        case "disconnect-ga4": response = await adapter.prepareGa4ReportingDisconnection(target, signal); break;
        case "connect-search-console": response = await adapter.prepareSearchConsoleReportingConnection({ target, property: selectedProperty() }, signal); break;
        case "disconnect-search-console": response = await adapter.prepareSearchConsoleReportingDisconnection(target, signal); break;
      }
      if (!isCurrent()) return;
      const plan = parseSiteAnalyticsChangePlan(response, target);
      if (plan.action !== action) throw new Error("Unexpected change action");
      setPending({ kind: "change", plan });
    }, "変更内容を確認できませんでした。入力と権限を確認してから、もう一度お試しください。");
  }
  function selectedProperty(): SearchConsoleProperty { return { kind: propertyKind, value: propertyValue }; }
  function prepareVerification() {
    if (!target || !connection || needsReload || forbidden) return;
    const property = selectedProperty(), requestedMethod = method;
    void run(async (signal, isCurrent) => {
      const response = await adapter.prepareSearchConsoleVerification({ target, property, method: requestedMethod }, signal);
      if (!isCurrent()) return;
      const plan = parseSearchConsoleVerificationPlan(response, target);
      if (plan.property.kind !== property.kind || plan.property.value !== property.value || plan.instructions.method !== requestedMethod) throw new Error("Unexpected verification plan");
      setPending({ kind: "verification", plan, currentProperty: connection.searchConsole.property?.value ?? null, currentMethod: connection.searchConsole.verificationMethod });
    }, "所有権の確認手順を取得できませんでした。プロパティと確認方法を確認して、もう一度お試しください。");
  }

  async function freshAfterOperation(signal: AbortSignal, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    // Mutation/verification return values are not state. Only a validated fresh read is authoritative.
    try {
      await read(signal, isCurrent);
      if (isCurrent()) setNotice({ error: false, text: "最新の連携状態を取得しました。" });
    } catch (error) {
      if (permissionFailure(error)) throw error;
      if (isCurrent()) { setNeedsReload(true); setNotice({ error: true, text: "処理後の状態を取得できませんでした。前回取得した状態を表示しています。再操作する前に再読込してください。" }); }
    } finally { if (isCurrent()) setPending(null); }
  }
  function apply() {
    if (!pending || !target || needsReload || forbidden) return;
    const confirmation = pending;
    void run(async (signal, isCurrent) => {
      try {
        // Revalidate expiry at confirmation time; never render the one-time confirmation token.
        const plan = confirmation.kind === "change" ? parseSiteAnalyticsChangePlan(confirmation.plan, target) : parseSearchConsoleVerificationPlan(confirmation.plan, target);
        const request = { target, confirmationToken: plan.confirmationToken };
        setNeedsReload(true);
        if (confirmation.kind === "verification") await adapter.applySearchConsoleVerification(request, signal);
        else switch (confirmation.plan.action) {
          case "publish-ga4-tag": await adapter.applyGa4TrackingTag(request, signal); break;
          case "remove-ga4-tag": await adapter.removeGa4TrackingTag(request, signal); break;
          case "connect-ga4": await adapter.applyGa4ReportingConnection(request, signal); break;
          case "disconnect-ga4": await adapter.disconnectGa4Reporting(request, signal); break;
          case "connect-search-console": await adapter.applySearchConsoleReportingConnection(request, signal); break;
          case "disconnect-search-console": await adapter.disconnectSearchConsoleReporting(request, signal); break;
        }
        await freshAfterOperation(signal, isCurrent);
      } catch (error) {
        if (isCurrent()) setPending(null);
        throw error;
      }
    }, "変更を完了できませんでした。最新状態を再読込し、必要なら変更内容を準備し直してください。");
  }
  function check(action: "ga4-verify" | "ga4-retry" | "ownership-verify" | "search-verify" | "search-retry") {
    if (!target || needsReload || forbidden) return;
    void run(async (signal, isCurrent) => {
      setNeedsReload(true);
      switch (action) {
        case "ga4-verify": await adapter.verifyGa4Reporting(target, signal); break;
        case "ga4-retry": await adapter.retryGa4Sync(target, signal); break;
        case "ownership-verify": await adapter.verifySearchConsoleOwnership(target, signal); break;
        case "search-verify": await adapter.verifySearchConsoleReporting(target, signal); break;
        case "search-retry": await adapter.retrySearchConsoleSync(target, signal); break;
      }
      await freshAfterOperation(signal, isCurrent);
    }, "確認・再試行を完了できませんでした。前回取得した状態を表示しています。時間をおいて再読込してください。");
  }
  const empty = connection && connection.ga4.trackingTagState === "not-configured" && connection.ga4.reportingState === "not-connected" && connection.searchConsole.ownershipState === "not-verified" && connection.searchConsole.reportingState === "not-connected";
  return <section className="nw-site-apps" aria-label="サイト設定の連携">
    <style dangerouslySetInnerHTML={{ __html: siteAppsCss }} />
    <div ref={(element) => { if (element) element.inert = pending !== null; }}>
      <header className="sa-header"><div><p className="sa-muted">サイト設定</p><h1>連携</h1>
        <p>{projectName ?? target?.projectId} / {siteName ?? target?.siteId}</p>
        {target && <p className="sa-origin">公開サイト {target.siteOrigin}</p>}</div>
        <button type="button" disabled={busy || !target || !!pending} onClick={reload}>再読込</button>
      </header>
      {!target ? <p role="alert">公開サイトの対象情報が正しくありません。設定画面を開き直してください。</p> : <>
        {notice && <div className="sa-notice" data-error={notice.error} role={notice.error ? "alert" : "status"}>{notice.text}</div>}
        <p role="status" aria-live="polite">{busy ? loading ? "連携情報を読み込んでいます。" : "処理しています。" : ""}</p>
        {loading && <div className="sa-skeleton" aria-hidden="true" />}
        {!loading && !forbidden && connection && <>
          {empty && <p className="sa-notice">まだ連携はありません。利用するサービスの設定を開いてください。</p>}
          <fieldset disabled={busy || !!pending || needsReload} aria-busy={busy}>
            <section className="sa-service" aria-labelledby={`${id}-ga4`}>
              <div className="sa-service-head"><h2 id={`${id}-ga4`}>Google Analytics</h2><Badge status={connection.ga4.reportingState} /></div>
              <p>公開サイトのアクセスを計測し、GA4レポートを分析画面に表示します。</p>
              <div className="sa-row"><div className="sa-row-head"><h3>計測タグ</h3><Badge status={connection.ga4.trackingTagState} /></div>
                <p className="sa-value">測定ID: {connection.ga4.measurementId ?? "未設定"}</p>
                <p className="sa-muted">公開サイトへ計測タグを設定します。レポート接続は別に設定します。</p>
                <details><summary>計測タグの設定</summary><form className="sa-form" onSubmit={(event) => { event.preventDefault(); prepare("publish-ga4-tag"); }}>
                  <label><span>GA4測定ID</span><input value={measurementId} onChange={(event) => setMeasurementId(event.target.value)} placeholder="G-XXXXXXXXXX" required pattern="G-[A-Za-z0-9]{4,24}" maxLength={26} autoComplete="off" /></label>
                  <div className="sa-actions"><button type="submit">タグの変更を確認</button>{connection.ga4.measurementId && <button type="button" className="sa-danger" onClick={() => prepare("remove-ga4-tag")}>タグを削除</button>}</div>
                </form></details>
              </div>
              <div className="sa-row"><div className="sa-row-head"><h3>レポート接続</h3><Badge status={connection.ga4.reportingState} /></div>
                <p className="sa-value">プロパティID: {connection.ga4.propertyId ?? "未設定"}</p><p className="sa-muted">{reportHint(connection.ga4.reportingState)}</p>
                <details><summary>レポートの設定</summary><form className="sa-form" onSubmit={(event) => { event.preventDefault(); prepare("connect-ga4"); }}>
                  <label><span>GA4プロパティID（数字）</span><input value={propertyId} onChange={(event) => setPropertyId(event.target.value)} inputMode="numeric" pattern="[0-9]{4,20}" maxLength={20} required autoComplete="off" /></label>
                  <div className="sa-actions"><button type="submit">接続内容を確認</button>{connection.ga4.propertyId && <button type="button" className="sa-danger" onClick={() => prepare("disconnect-ga4")}>レポートを解除</button>}</div>
                </form></details>
                {connection.ga4.propertyId && <div className="sa-actions"><button type="button" onClick={() => check("ga4-verify")}>接続を確認</button><button type="button" onClick={() => check("ga4-retry")}>同期を再試行</button></div>}
              </div>
            </section>
            <section className="sa-service" aria-labelledby={`${id}-gsc`}>
              <div className="sa-service-head"><h2 id={`${id}-gsc`}>Search Console</h2><Badge status={connection.searchConsole.reportingState} /></div>
              <p>Google検索での表示回数やクリックを分析画面に表示します。</p>
              <p className="sa-value">プロパティ: {connection.searchConsole.property?.value ?? "未設定"}</p>
              <div className="sa-row"><div className="sa-row-head"><h3>サイト所有権</h3><Badge status={connection.searchConsole.ownershipState} /></div>
                <p className="sa-muted">{connection.searchConsole.ownershipState === "verified" ? "公開サイトの所有権は確認済みです。" : connection.searchConsole.ownershipState === "failed" ? "所有権を確認できませんでした。確認コードの反映後に再確認してください。" : "公開サイトの確認コードまたはDNSで所有権を確認します。"}</p>
                {connection.searchConsole.verificationMethod && <p className="sa-value">確認方法: {methodLabel(connection.searchConsole.verificationMethod)}</p>}
                {connection.searchConsole.property && <div className="sa-actions"><button type="button" onClick={() => check("ownership-verify")}>所有権を確認</button></div>}
              </div>
              <div className="sa-row"><div className="sa-row-head"><h3>レポート接続</h3><Badge status={connection.searchConsole.reportingState} /></div>
                <p className="sa-muted">{reportHint(connection.searchConsole.reportingState)}</p>
                {connection.searchConsole.property && <div className="sa-actions"><button type="button" onClick={() => check("search-verify")}>接続を確認</button><button type="button" onClick={() => check("search-retry")}>同期を再試行</button><button type="button" className="sa-danger" onClick={() => prepare("disconnect-search-console")}>レポートを解除</button></div>}
              </div>
              <details><summary>Search Consoleの設定</summary><form className="sa-form" onSubmit={(event) => { event.preventDefault(); prepareVerification(); }}>
                <label><span>プロパティの種類</span><select value={propertyKind} onChange={(event) => { const kind = event.target.value as SearchConsoleProperty["kind"]; setPropertyKind(kind); setPropertyValue(kind === "url-prefix" ? `${target.siteOrigin}/` : `sc-domain:${new URL(target.siteOrigin).hostname}`); if (kind === "domain") setMethod("dns"); }}><option value="url-prefix">URLプレフィックス</option><option value="domain">ドメイン</option></select></label>
                <label><span>Search Consoleプロパティ</span><input value={propertyValue} onChange={(event) => setPropertyValue(event.target.value)} required maxLength={2048} autoComplete="off" spellCheck={false} /></label>
                <p className="sa-muted">Googleに表示される値をそのまま入力してください。レポートは {target.siteOrigin}/ に完全一致するURLプレフィックスを使います。</p>
                <label><span>所有権の確認方法</span><select value={method} onChange={(event) => setMethod(event.target.value as SearchConsoleVerificationMethod)}><option value="meta-tag" disabled={propertyKind === "domain"}>メタタグ</option><option value="dns">DNS TXTレコード</option></select></label>
                <div className="sa-actions"><button type="submit">所有権確認の準備</button><button type="button" disabled={propertyKind !== "url-prefix" || propertyValue !== `${target.siteOrigin}/`} onClick={() => prepare("connect-search-console")}>レポート接続の準備</button></div>
              </form></details>
            </section>
          </fieldset>
        </>}
      </>}
    </div>
    {pending && target && <Confirmation pending={pending} target={target} projectName={projectName ?? target.projectId} siteName={siteName ?? target.siteId} busy={busy} notice={notice} dismiss={() => setPending(null)} apply={apply} />}
  </section>;
}

function methodLabel(method: SearchConsoleVerificationMethod | null) { return method === "meta-tag" ? "メタタグ" : method === "dns" ? "DNS TXTレコード" : "未設定"; }
function Impact({ label, current, next }: { label: string; current: string | null; next: string | null }) {
  return <div><dt>{label}</dt><dd>現在: {current ?? "なし"}<br />変更後: {next ?? "なし"}</dd></div>;
}
function Confirmation({ pending, target, projectName, siteName, busy, notice, dismiss, apply }: {
  pending: Pending; target: SiteAnalyticsTarget; projectName: string; siteName: string; busy: boolean;
  notice: Notice | null; dismiss: () => void; apply: () => void;
}) {
  const root = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => { setTimeout(() => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }, 0); };
  }, []);
  let contents: ReactNode;
  if (pending.kind === "change") contents = <><p>{pending.plan.summary}</p><dl>{pending.plan.changes.map((change, index) => <Impact key={index} label={change.label} current={change.currentValue} next={change.nextValue} />)}</dl></>;
  else {
    const instructions = pending.plan.instructions;
    contents = <><dl><Impact label="Search Consoleプロパティ" current={pending.currentProperty} next={pending.plan.property.value} /><Impact label="所有権の確認方法" current={methodLabel(pending.currentMethod)} next={methodLabel(instructions.method)} /></dl>
      {instructions.method === "meta-tag" ? <><p>この公開サイトに所有権確認用のメタタグを設定します。</p><p className="sa-muted">公開確認コード</p><code>{instructions.content}</code></> : <><p>DNSに次のTXTレコードを設定してください。適用後に「所有権を確認」で反映を確認できます。</p><dl><div><dt>名前</dt><dd><code>{instructions.name}</code></dd></div><div><dt>種類</dt><dd>TXT</dd></div><div><dt>公開確認コード</dt><dd><code>{instructions.value}</code></dd></div></dl></>}
    </>;
  }
  const destructive = pending.kind === "change" && ["remove-ga4-tag", "disconnect-ga4", "disconnect-search-console"].includes(pending.plan.action);
  return <div className="sa-backdrop"><section ref={root} className="sa-confirm" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy} onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); dismiss(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current!.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); heading.current?.focus(); }
    else if (event.shiftKey && (event.target === first || event.target === heading.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (event.target === last || event.target === heading.current)) { event.preventDefault(); first.focus(); }
  }}>
    <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>変更内容の確認</h2>
    <dl><div><dt>プロジェクト</dt><dd>{projectName}（{target.projectId}）</dd></div><div><dt>サイト</dt><dd>{siteName}（{target.siteId}）</dd></div><div><dt>公開サイト</dt><dd>{target.siteOrigin}</dd></div></dl>
    {contents}
    {pending.kind === "change" && ["disconnect-ga4", "disconnect-search-console"].includes(pending.plan.action) && <p>このサイトのレポート接続と集計キャッシュを解除します。</p>}
    <p className="sa-muted">確認の有効期限: <time dateTime={pending.plan.expiresAt}>{new Date(pending.plan.expiresAt).toLocaleString("ja-JP")}</time></p>
    {notice && <p role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {busy && <p role="status">適用して最新状態を取得しています。</p>}
    <div className="sa-actions"><button type="button" disabled={busy} onClick={dismiss}>キャンセル</button><button type="button" disabled={busy} className={destructive ? "sa-danger" : "sa-primary"} onClick={apply}>{destructive ? "解除・削除を実行" : "この内容で適用"}</button></div>
  </section></div>;
}
