import type { ElementNode, ElementTag, PageNode } from "./types.js";
import { isSafePublicLink } from "./validation-utils.js";

const inlineTags = new Set<ElementTag>(["a", "strong", "em", "span", "small", "br", "img"]);
const blockTags = new Set<ElementTag>(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol"]);
const id = () => `edit_${crypto.randomUUID().replaceAll("-", "")}`;

export function isDirectlyEditable(node: PageNode): node is ElementNode {
  return node.type === "element" && (/^(?:p|h[1-6]|span)$/.test(node.tag) ||
    (node.tag === "div" && node.attrs?.role === "group" && node.attrs?.["aria-label"] === "リッチテキスト"));
}

/** Browser contenteditable markup is only an input format; it is never saved as HTML. */
export function readEditableChildren(root: HTMLElement, original: ElementNode): PageNode[] {
  const old = new Map<string, ElementNode>(), claimed = new Set<string>();
  const visit = (node: PageNode): void => {
    if (node.type !== "element") return;
    old.set(node.id, node);
    node.children.forEach(visit);
  };
  original.children.forEach(visit);
  const compact = (nodes: PageNode[]): PageNode[] => nodes.reduce<PageNode[]>((result, node) => {
    const last = result.at(-1);
    if (last?.type === "text" && node.type === "text") last.text += node.text;
    else result.push(node);
    return result;
  }, []);
  const sourceFor = (element: Element, tag: ElementTag): ElementNode | undefined => {
    const nodeId = element.getAttribute("data-nw-node"), previous = nodeId ? old.get(nodeId) : undefined;
    const compatibleHeading = previous && /^(?:p|h[1-6])$/.test(previous.tag) && /^(?:p|h[1-6])$/.test(tag);
    const compatibleEmphasis = previous && (((previous.tag === "b" || previous.tag === "strong") && (tag === "b" || tag === "strong")) ||
      ((previous.tag === "i" || previous.tag === "em") && (tag === "i" || tag === "em")));
    if (!previous || previous.tag !== tag && !compatibleHeading && !compatibleEmphasis || claimed.has(previous.id)) return undefined;
    claimed.add(previous.id);
    return previous;
  };
  const elementNode = (element: Element, tag: ElementTag, children: PageNode[]): ElementNode => {
    const previous = sourceFor(element, tag), attrs = previous?.attrs ? { ...previous.attrs } : {};
    const preservedTag = previous && (((previous.tag === "b" || previous.tag === "strong") && (tag === "b" || tag === "strong")) ||
      ((previous.tag === "i" || previous.tag === "em") && (tag === "i" || tag === "em"))) ? previous.tag : tag;
    if (tag === "a") {
      const href = element.getAttribute("href") ?? "/";
      if (!isSafePublicLink(href)) throw new Error("リンク先には安全なHTTPS、サイト内URL、mailto、telを指定してください。");
      attrs.href = href;
    }
    return { type: "element", id: previous?.id ?? id(), tag: preservedTag, ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(previous?.style ? { style: previous.style } : {}), children };
  };
  const inline = (container: Node): PageNode[] => {
    const result: PageNode[] = [];
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 3) { result.push({ type: "text", text: child.textContent ?? "" }); continue; }
      if (child.nodeType !== 1) continue;
      const element = child as Element, raw = element.tagName.toLowerCase();
      const tag = (raw === "b" ? "strong" : raw === "i" ? "em" : raw) as ElementTag;
      if (tag === "br") result.push(elementNode(element, "br", []));
      else if (tag === "img") {
        const existingId = element.getAttribute("data-nw-node");
        if (existingId && old.get(existingId)?.tag === "img") result.push(elementNode(element, "img", []));
      }
      else if (inlineTags.has(tag)) result.push(elementNode(element, tag, inline(element)));
      else if (raw === "div" || raw === "p") {
        if (result.length) result.push({ type: "element", id: id(), tag: "br", children: [] });
        result.push(...inline(element));
      } else result.push(...inline(element));
    }
    return compact(result);
  };
  if (original.tag !== "div") {
    const children = inline(root);
    return children.length ? children : [{ type: "text", text: "" }];
  }
  const blocks: PageNode[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      if (child.textContent?.trim()) blocks.push({ type: "element", id: id(), tag: "p", children: [{ type: "text", text: child.textContent }] });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element, raw = element.tagName.toLowerCase();
    const tag = raw as ElementTag;
    if (tag === "ul" || tag === "ol") {
      const items = Array.from(element.children).filter((item) => item.tagName.toLowerCase() === "li")
        .map((item) => elementNode(item, "li", inline(item)));
      if (items.length) blocks.push(elementNode(element, tag, items));
    } else if (blockTags.has(tag)) blocks.push(elementNode(element, tag, inline(element)));
    else blocks.push(elementNode(element, "p", inline(element)));
  }
  return blocks.length ? blocks : [{ type: "element", id: id(), tag: "p", children: [{ type: "text", text: "" }] }];
}
