import type { ElementNode } from "./types.js";

/** JS を使わない安全なインタラクション部品。返すのは文書の検証を通る新しい部分木だけ。 */
export type IdFactory = () => string;
const text = (id: string, tag: "p" | "summary", value: string): ElementNode => ({ type: "element", id, tag, children: [{ type: "text", text: value }] });

/** 横スクロールで切り替える。容器はキーボードで届くよう tabIndex 0 と名前を持つ。 */
export function carouselPreset(id: IdFactory): ElementNode {
  return {
    type: "element", id: id(), tag: "div", attrs: { role: "region", "aria-label": "カルーセル", tabIndex: 0 },
    style: { base: { display: "flex", gap: 16, overflowX: "auto", scrollSnapType: "x mandatory", paddingBottom: 8 } },
    children: [1, 2, 3].map((index): ElementNode => ({
      type: "element", id: id(), tag: "div",
      style: { base: { flexBasis: "80%", flexShrink: 0, scrollSnapAlign: "start", padding: 24, borderRadius: 8, backgroundColor: "#eef3ef" } },
      children: [text(id(), "p", `スライド ${index}`)]
    }))
  };
}
/** details / summary の開閉。初期は閉じていて、見出しを押すと開く。 */
export function togglePreset(id: IdFactory): ElementNode {
  return {
    type: "element", id: id(), tag: "details", style: { base: { borderWidth: 1, borderStyle: "solid", borderColor: "#d5ded6", borderRadius: 8, padding: 16 } },
    children: [text(id(), "summary", "開閉する見出し"), text(id(), "p", "開いたときに表示する内容です。")]
  };
}
