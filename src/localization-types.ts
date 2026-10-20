import type { AssetReference, BlockContracts, ComponentLibrary, PageDocument } from "./types.js";

export type LocalizationLocale = "ja" | "en";

/** URL language keys and PageDocument locale spellings are deliberately separate. */
export type SiteLocalizationConfig = {
  schemaVersion: 1;
  siteId: string;
  sourceLocale: LocalizationLocale;
  defaultLocale: LocalizationLocale;
  enabledLocales: LocalizationLocale[];
  documentLocales: Record<LocalizationLocale, string>;
  glossaryVersion: string;
  contextVersion: string;
};

export type LocalizedRichTextNode =
  | { type: "text"; text: string }
  | { type: "element"; id: string; tag: "a" | "strong" | "em" | "b" | "i" | "small" | "span" | "br"; children: LocalizedRichTextNode[] };
export type LocalizedRichText = { kind: "rich-text"; children: LocalizedRichTextNode[] };
export type LocalizedAsset = { kind: "asset"; asset: AssetReference };
export type LocalizationValue = string | LocalizedRichText | LocalizedAsset;
export type LocalizationValueKind = "text" | "rich-text" | "asset";

export type LocalizationUnitScope = "page" | "shared-component";
export type LocalizationUnit = {
  unitId: string;
  scope: LocalizationUnitScope;
  ownerId: string;
  field: string;
  kind: LocalizationValueKind;
  /** Asset values are manually selected references and are never sent to a translation model. */
  translatable: boolean;
  /** False only for an optional source-preserving override, currently localized image assets. */
  required: boolean;
  sourceValue: LocalizationValue;
  sourceFingerprint: string;
  context: string;
  maxLength?: number;
  allowEmpty?: boolean;
  singleLine?: boolean;
};

export type LocalizationIssue = {
  code: "UNANCHORED_TEXT" | "UNSUPPORTED_RICH_TEXT";
  scope: LocalizationUnitScope;
  ownerId: string;
  nodeId?: string;
  message: string;
};

export type LocalizationCollection = {
  siteId: string;
  pageId: string;
  sourceLocale: LocalizationLocale;
  targetLocale: LocalizationLocale;
  units: LocalizationUnit[];
  issues: LocalizationIssue[];
};

export type BlockLocalizationSchema = Readonly<Record<string, { readonly props: readonly string[] }>>;
export type LocalizationExtractionOptions = {
  components?: ComponentLibrary;
  blocks?: BlockContracts;
  blockLocalization?: BlockLocalizationSchema;
};

export type TranslationCandidate = {
  candidateId: string;
  sourceFingerprint: string;
  value: LocalizationValue;
  version: number;
};
export type LocalizationDraftEntry = {
  unitId: string;
  kind: LocalizationValueKind;
  version: number;
  draftValue?: LocalizationValue;
  editOrigin?: "AUTO" | "MANUAL";
  reviewedSourceFingerprint?: string;
  candidate?: TranslationCandidate;
};
export type LocalizationOverlay = {
  schemaVersion: 1;
  siteId: string;
  pageId: string;
  sourceLocale: LocalizationLocale;
  targetLocale: LocalizationLocale;
  version: number;
  entries: LocalizationDraftEntry[];
};

/** Provider result envelope. baseVersion is the overlay version observed when the job started. */
export type TranslationResult = {
  schemaVersion: 1;
  resultId: string;
  siteId: string;
  pageId: string;
  sourceLocale: LocalizationLocale;
  targetLocale: LocalizationLocale;
  baseVersion: number;
  values: { unitId: string; sourceFingerprint: string; value: string | LocalizedRichText }[];
};

export type LocalizationUnitState = "source" | "missing" | "draft" | "review-needed" | "reviewed";
export type LocalizationStatus = {
  complete: boolean;
  units: number;
  reviewed: number;
  sourceFallback: number;
  missing: number;
  draft: number;
  reviewNeeded: number;
  candidates: number;
  obsolete: number;
  issues: number;
  details: { unitId: string; state: LocalizationUnitState; hasCandidate: boolean }[];
};

export type MaterializedLocalization = {
  document: PageDocument;
  components?: ComponentLibrary;
  status: LocalizationStatus;
};

/** Server-safe result for a translated draft save. Values contain only fields declared by the current collection. */
export type LocalizedDocumentSaveValidation = {
  document: PageDocument;
  collection: LocalizationCollection;
  values: Readonly<Record<string, LocalizationValue>>;
};
