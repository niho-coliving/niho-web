import type { CSSProperties, ReactNode } from "react";
import type { EditorBlockRegistry } from "../src/editor-types.js";
import type { BlockContract, BlockContracts, BlockSlot, PublicPropValue } from "../src/types.js";

type PreviewKind = "frame" | "form" | "list" | "articles" | "carousel" | "detail";
type PreviewProps = Record<string, PublicPropValue>;

const blockLabels: Readonly<Record<string, string>> = {
  KamakuraLegacyFrame: "外部機能の表示枠",
  KamakuraLegacyForm: "従来フォーム",
  KamakuraCmsList: "CMS一覧",
  KamakuraCompanyDirectory: "会社一覧",
  KamakuraRecentArticles: "新着記事一覧",
  KamakuraCarousel: "カルーセル",
  KamakuraDropInBooking: "体験予約フォーム",
  KamakuraCalendarEmbed: "カレンダー",
  KamakuraMapEmbed: "地図",
  KamakuraRentalForm: "貸切利用フォーム",
  KamakuraContactForm: "お問い合わせフォーム",
  KamakuraCmsDetail: "CMS詳細"
};

const previewKinds: Readonly<Record<string, PreviewKind>> = {
  KamakuraLegacyFrame: "frame",
  KamakuraLegacyForm: "form",
  KamakuraCmsList: "list",
  KamakuraCompanyDirectory: "list",
  KamakuraRecentArticles: "articles",
  KamakuraCarousel: "carousel",
  KamakuraDropInBooking: "form",
  KamakuraCalendarEmbed: "frame",
  KamakuraMapEmbed: "frame",
  KamakuraRentalForm: "form",
  KamakuraContactForm: "form",
  KamakuraCmsDetail: "detail"
};

const muted: CSSProperties = { color: "#67736d", fontSize: 13 };
const sampleImage: CSSProperties = { display: "grid", placeItems: "center", minHeight: 80, background: "#e8e6e0", color: "#67736d" };
const sampleField: CSSProperties = { minHeight: 40, padding: 10, border: "1px solid #cbc8c0", borderRadius: 6, color: "#67736d" };

function slotLabel(slots: Readonly<Record<string, BlockSlot>>, name: string): string {
  return slots[name]?.label ?? name;
}

function Slot({ name, slots, children, tag = "div" }: { name: string; slots: Readonly<Record<string, BlockSlot>>; children?: ReactNode; tag?: "article" | "div" | "span" }) {
  const Tag = tag;
  return slots[name] ? <Tag data-nw-slot={name}>{children ?? slotLabel(slots, name)}</Tag> : <Tag>{children}</Tag>;
}

function KamakuraBlockPreview({ block, contract, props }: { block: string; contract: BlockContract; props: PreviewProps }) {
  const slots = contract.slots ?? {};
  const label = blockLabels[block] ?? block;
  const kind = previewKinds[block];
  const image = (key: string) => <Slot key={key} name="image" slots={slots}><span style={sampleImage}>画像の表示例</span></Slot>;
  const card = (index: number, article: boolean) => <Slot key={index} name="card" slots={slots} tag="article">
    {image(`image-${index}`)}
    {article && <Slot name="date" slots={slots}><span style={muted}>日付の表示例</span></Slot>}
    <Slot name="title" slots={slots}><strong>タイトルの表示例</strong></Slot>
    <Slot name={article ? "excerpt" : "description"} slots={slots}><p style={muted}>{article ? "記事の抜粋の表示例です。" : "説明文の表示例です。"}</p></Slot>
  </Slot>;

  let content: ReactNode;
  if (kind === "form") {
    content = <Slot name="form" slots={slots}>
      <p>{label}{typeof props.formId === "string" ? ` · ${props.formId}` : ""}</p>
      <Slot name="field" slots={slots}><div style={sampleField}>入力欄の表示例</div></Slot>
      <Slot name="field" slots={slots}><div style={sampleField}>入力欄の表示例</div></Slot>
      <Slot name="submit" slots={slots}><span style={muted}>送信ボタンの表示例（送信しません）</span></Slot>
      {slots.frame && <Slot name="frame" slots={slots}><span style={muted}>フォーム枠の表示例（接続しません）</span></Slot>}
    </Slot>;
  } else if (kind === "list" || kind === "articles") {
    content = <Slot name="list" slots={slots}>{[0, 1, 2].map((index) => card(index, kind === "articles"))}</Slot>;
  } else if (kind === "carousel") {
    content = <Slot name="track" slots={slots}>{[0, 1, 2].map((index) => <Slot key={index} name="slide" slots={slots} tag="article">{image(`slide-${index}`)}<Slot name="caption" slots={slots}>スライドの表示例</Slot></Slot>)}</Slot>;
  } else if (kind === "detail") {
    content = <Slot name="content" slots={slots}>{image("detail-image")}<Slot name="title" slots={slots}><strong>詳細タイトルの表示例</strong></Slot><Slot name="description" slots={slots}>説明文の表示例</Slot><Slot name="body" slots={slots}>本文の表示例</Slot></Slot>;
  } else if (kind === "frame") {
    content = <Slot name="frame" slots={slots}><div style={sampleImage}>{label}の表示例<br />外部サービスは読み込みません</div></Slot>;
  } else {
    content = <div>{Object.keys(slots).map((name) => <Slot key={name} name={name} slots={slots} />)}</div>;
  }

  return <section aria-label={`${label}のプレビュー`} style={{ border: "1px dashed #aeb9b1", borderRadius: 10, padding: 14, color: "#34433a", background: "#f8faf8" }}>
    <strong>{label}</strong>
    <p style={muted}>安全な表示サンプルです。フォーム送信、予約、決済、CMS取得、埋め込み読み込みは行いません。</p>
    {content}
  </section>;
}

/** Build an editor registry from the site's validated schema, never remote code. */
export function createKamakuraEditorBlocks(contracts: BlockContracts): EditorBlockRegistry {
  return Object.fromEntries(Object.entries(contracts).map(([block, contract]) => {
    const render = (props: PreviewProps) => <KamakuraBlockPreview block={block} contract={contract} props={props} />;
    return [block, { ...contract, label: blockLabels[block] ?? block, component: render, preview: render }];
  }));
}
