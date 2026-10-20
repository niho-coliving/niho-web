"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicationStatus } from "./project-read-model.js";

type ReadState<T> = { status: "loading" } | { status: "error" } | { status: "complete"; value: T };

/** Reader参照が変わったrenderから旧データを隠す。abort非対応adapterの遅延応答も世代で捨てる。 */
export function useProjectRead<T>(reader: (signal: AbortSignal) => Promise<T>) {
  const [stored, setStored] = useState<{ reader: typeof reader; state: ReadState<T> }>({ reader, state: { status: "loading" } });
  const active = useRef<AbortController | null>(null), generation = useRef(0);
  const reload = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    active.current = controller;
    setStored({ reader, state: { status: "loading" } });
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return reader(controller.signal);
    }).then((value) => {
      if (!controller.signal.aborted && current === generation.current) setStored({ reader, state: { status: "complete", value: value! } });
    }).catch(() => {
      if (!controller.signal.aborted && current === generation.current) setStored({ reader, state: { status: "error" } });
    });
  }, [reader]);
  useEffect(() => {
    reload();
    return () => { generation.current++; active.current?.abort(); };
  }, [reload]);
  return { state: stored.reader === reader ? stored.state : { status: "loading" as const }, reload };
}

export function ReadNotice({ status, retry, noun }: { status: "loading" | "error" | "forbidden"; retry: () => void; noun: string }) {
  return <section className="pv-notice" aria-busy={status === "loading"}>
    <p role={status === "error" || status === "forbidden" ? "alert" : "status"}>{status === "loading" ? `${noun}を読み込んでいます。` : status === "forbidden" ? "この情報を表示する権限がありません。参加資格を管理者に確認してください。" : `${noun}を読み込めませんでした。再試行してください。`}</p>
    {status !== "loading" && <button type="button" onClick={retry}>再試行</button>}
    {status === "loading" && <div className="pv-skeleton" aria-hidden="true" />}
  </section>;
}
export function PublicationBadge({ status }: { status: PublicationStatus }) {
  return <span className={`pv-badge pv-${status}`}>{status === "published" ? "公開中" : status === "unpublished" ? "未公開" : "公開状態未取得"}</span>;
}
export function dateLabel(value: string | null): string {
  return value === null ? "未取得" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(new Date(value));
}
export function Timestamp({ value }: { value: string | null }) {
  return value === null ? <>未取得</> : <time dateTime={value}>{dateLabel(value)}</time>;
}
