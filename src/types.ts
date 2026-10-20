/** JSON の契約。実行可能コード、HTML、任意 CSS は保存しない。 */
export type TokenKind = "color" | "length" | "fontFamily" | "number";
export type DesignToken = { type: TokenKind; value: string | number };
export type TokenReference = { token: string };
export type StyleValue = string | number | TokenReference;
export type StyleProperty =
  | "color" | "backgroundColor" | "borderColor"
  | "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "textAlign"
  | "width" | "height" | "minWidth" | "maxWidth" | "minHeight" | "maxHeight"
  | "margin" | "marginTop" | "marginRight" | "marginBottom" | "marginLeft"
  | "padding" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft"
  | "display" | "flexDirection" | "flexWrap" | "justifyContent" | "alignItems" | "alignSelf"
  | "flexGrow" | "flexShrink" | "flexBasis" | "gap" | "rowGap" | "columnGap"
  | "gridTemplateColumns" | "gridTemplateRows" | "gridColumn" | "gridRow"
  | "position" | "top" | "right" | "bottom" | "left" | "zIndex"
  | "borderWidth" | "borderStyle" | "borderRadius" | "overflow" | "objectFit" | "opacity";
export type StyleDeclarations = Partial<Record<StyleProperty, StyleValue>>;
export type NodeStyle = {
  base?: StyleDeclarations;
  /** mobile first。minWidth は昇順・重複不可。 */
  responsive?: { minWidth: number; declarations: StyleDeclarations }[];
};
export type ElementTag =
  | "div" | "section" | "article" | "header" | "footer" | "main" | "nav" | "aside"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span"
  | "a" | "img" | "picture" | "source" | "ul" | "ol" | "li"
  | "dl" | "dt" | "dd" | "strong" | "em" | "b" | "i" | "small"
  | "blockquote" | "figure" | "figcaption" | "br" | "hr" | "time";
export type ElementAttributes = Record<string, string | number | boolean>;
export type TextNode = { type: "text"; text: string };
export type ElementNode = {
  type: "element";
  id: string;
  tag: ElementTag;
  attrs?: ElementAttributes;
  style?: NodeStyle;
  children: PageNode[];
};
export type PublicPropValue = string | number | boolean;
export type ComponentNode = {
  type: "component";
  id: string;
  block: string;
  props: Record<string, PublicPropValue>;
  style?: NodeStyle;
};
export type PageNode = TextNode | ElementNode | ComponentNode;
export type PageDocument = {
  schemaVersion: 1;
  siteId: string;
  pageId: string;
  locale: string;
  revision: number;
  title: string;
  tokens: Record<string, DesignToken>;
  body: PageNode[];
};

export type PropRule =
  | { type: "string"; required?: boolean; maxLength?: number }
  | { type: "url"; required?: boolean }
  | { type: "number"; required?: boolean; min?: number; max?: number }
  | { type: "boolean"; required?: boolean }
  | { type: "enum"; required?: boolean; values: readonly string[] };
export type BlockContract = { props: Readonly<Record<string, PropRule>> };
export type BlockContracts = Readonly<Record<string, BlockContract>>;
