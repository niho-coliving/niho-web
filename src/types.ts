/** JSON の契約。実行可能コード、HTML、任意 CSS は保存しない。 */
export type TokenKind = "color" | "length" | "fontFamily" | "number";
export type DesignToken = { type: TokenKind; value: string | number; /** 編集画面の表示名（任意）。 */ label?: string };
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
  | "borderWidth" | "borderStyle" | "borderRadius" | "overflow" | "objectFit" | "opacity"
  | "backgroundSize" | "backgroundPosition" | "backgroundRepeat"
  | "fontStyle" | "textDecorationLine"
  | "translate" | "rotate" | "scale" | "transformOrigin"
  | "transitionDuration" | "transitionDelay" | "transitionTimingFunction"
  | "overflowX" | "scrollSnapType" | "scrollSnapAlign";
/** 素材ライブラリの参照。URL はホストが描画時に解決し、文書には保存しない。 */
export type AssetReference = { provider: string; id: string };
export type BackgroundImageValue = { asset: AssetReference };
export type StyleDeclarations = Partial<Record<StyleProperty, StyleValue>> & { backgroundImage?: BackgroundImageValue };
/** 文字スタイルで共通化できる見た目。色はカラーの token で共通化する。 */
export type TextStyleProperty = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "fontStyle" | "textDecorationLine";
export type TextStyleDeclarations = Partial<Record<TextStyleProperty, StyleValue>>;
export type TextStyle = {
  label?: string;
  base: TextStyleDeclarations;
  responsive?: { minWidth: number; declarations: TextStyleDeclarations }[];
};
/** 状態スタイルで変えられる見た目。レイアウトを動かさないものだけ。 */
export type StateProperty = "color" | "backgroundColor" | "borderColor" | "opacity" | "textDecorationLine" | "translate" | "rotate" | "scale";
export type StateName = "hover" | "focus" | "active";
export type StateDeclarations = Partial<Record<StateProperty, StyleValue>>;
export type MotionEasing = "ease" | "ease-in" | "ease-out" | "ease-in-out" | "linear";
export type AppearEffect = "fade" | "fade-up" | "fade-down" | "fade-left" | "fade-right" | "zoom";
/** 登場の演出。動きを減らす設定の利用者と未対応ブラウザでは動かさず、内容はそのまま見える。 */
export type Appear = {
  effect: AppearEffect;
  /** load: ページを開いたとき。view: 画面に入ったとき（スクロール量に合わせて動く）。 */
  trigger: "load" | "view";
  /** ms。100〜3000。view では使わない。 */
  duration: number;
  /** ms。0〜3000。view では使わない。 */
  delay: number;
  easing?: MotionEasing;
};
/** この幅の範囲で非表示。minWidth は 0 または 320〜3840、maxWidth は範囲の最後の幅（含む）。 */
export type HiddenRange = { minWidth: number; maxWidth?: number };
export type NodeStyle = {
  /** 文書の textStyles のキー。ノード個別の指定が優先する。 */
  textStyle?: string;
  base?: StyleDeclarations;
  /** mobile first。minWidth は昇順・重複不可。 */
  responsive?: { minWidth: number; declarations: StyleDeclarations }[];
  /** hover は (hover:hover) の中、focus は :focus-visible、active は :active。 */
  states?: Partial<Record<StateName, StateDeclarations>>;
  appear?: Appear;
  /** 昇順・重なりなし・最大 12。 */
  hidden?: HiddenRange[];
};
export type ElementTag =
  | "div" | "section" | "article" | "header" | "footer" | "main" | "nav" | "aside"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span"
  | "a" | "img" | "picture" | "source" | "ul" | "ol" | "li"
  | "dl" | "dt" | "dd" | "strong" | "em" | "b" | "i" | "small"
  | "blockquote" | "figure" | "figcaption" | "br" | "hr" | "time"
  | "details" | "summary";
export type ElementAttributes = Record<string, string | number | boolean>;
export type TextNode = { type: "text"; text: string };
export type ElementNode = {
  type: "element";
  id: string;
  tag: ElementTag;
  /** img だけが持てる。持つ場合 attrs.src は持たない。 */
  asset?: AssetReference;
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
  /** registry が宣言した表示領域ごとの見た目。ブロックが描画する同じ領域（繰り返すカード等）すべてに適用する。 */
  slots?: Record<string, NodeStyle>;
};
/** 共通部品の参照。公開前に resolvePageDocument で element へ展開する。 */
export type InstanceNode = {
  type: "instance";
  id: string;
  component: string;
  /** 部品が公開した props の値。公開をやめた名前の値も保持する。 */
  props?: Record<string, string>;
  /** 部品の root だけに重ねる見た目。 */
  style?: NodeStyle;
};
export type PageNode = TextNode | ElementNode | ComponentNode | InstanceNode;
export type PageImage = { src: string; alt: string };
/** 公開メタ情報。値が無い項目は保存しない。 */
export type PageMeta = {
  description?: string;
  ogImage?: PageImage;
  favicon?: string;
  noindex?: boolean;
  /** ホストが許可した構造化データの ID。JSON-LD はホストが生成する。 */
  structuredData?: string[];
};
export type PageDocument = {
  schemaVersion: 1;
  siteId: string;
  pageId: string;
  locale: string;
  revision: number;
  title: string;
  meta?: PageMeta;
  tokens: Record<string, DesignToken>;
  textStyles?: Record<string, TextStyle>;
  body: PageNode[];
};

export type ComponentKind = "header" | "footer" | "navigation" | "section" | "part";
export type ComponentPropField = "text" | "href" | "src" | "alt";
export type ComponentPropDefinition = { label: string; node: string; field: ComponentPropField };
export type ComponentDefinition = {
  id: string;
  name: string;
  kind: ComponentKind;
  /** 定義を変更するたびに増える。 */
  version: number;
  root: ElementNode;
  props?: Record<string, ComponentPropDefinition>;
};
/** サイトごとに1つ。部品の内側は文書と同じノード規則で検証する。 */
export type ComponentLibrary = {
  schemaVersion: 1;
  siteId: string;
  revision: number;
  tokens: Record<string, DesignToken>;
  components: ComponentDefinition[];
};

export type PropRule =
  | { type: "string"; required?: boolean; maxLength?: number }
  | { type: "url"; required?: boolean }
  | { type: "number"; required?: boolean; min?: number; max?: number }
  | { type: "boolean"; required?: boolean }
  | { type: "enum"; required?: boolean; values: readonly string[] };
/** ブロックの内側で、スタッフが見た目を整えられる領域。値はホストの props・データが正本のまま。 */
export type BlockSlot = {
  /** スタッフに見せる領域名（例: カードの見出し、予約ボタン）。 */
  label: string;
  /** この領域で変更できる見た目。省略・空なら見た目も変更できない。 */
  style?: readonly StyleProperty[];
  /** この領域の文字を変える表示用の string prop。 */
  text?: string;
  /** 値がホストのデータ（価格・在庫・予約可否・送信先など）から来る場合の理由と正本。 */
  data?: { reason: string; source: string };
};
export type BlockContract = { props: Readonly<Record<string, PropRule>>; slots?: Readonly<Record<string, BlockSlot>> };
export type BlockContracts = Readonly<Record<string, BlockContract>>;
