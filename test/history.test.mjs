import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBrowserRecoveryStore, diffDocuments, parseRevisionEntry, parseRevisionPage, RecoveryTooLargeError } from "@niho/web/history";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);
const paths = (changes) => changes.map((change) => change.path);

test("diffDocuments reports title, meta, tokens, text, attributes, props and styles with readable paths", () => {
  const before = doc(), after = doc();
  before.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "旧", count: 3 } });
  after.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "新", count: 3 } });
  after.title = "新しいタイトル";
  after.meta = { description: "説明", ogImage: { src: "/cover.png", alt: "海" }, favicon: "/icon.png", noindex: true, structuredData: ["organization", "localBusiness"] };
  after.tokens.ink = { type: "color", value: "#000000" }; delete after.tokens.space; after.tokens.accent = { type: "color", value: "#ff0000" };
  after.body[0].style.base.padding = 24;
  after.body[0].children[0].children[0].text = "新しい見出し";
  after.body[0].children[2].attrs.href = "/news";
  after.body[0].style.base.color = { token: "accent" };
  after.body[0].style.responsive[0].declarations.maxWidth = "72rem";
  const changes = diffDocuments(before, after);
  assert.deepEqual(paths(changes), [
    "ページタイトル", "説明文", "ソーシャルカバー", "ファビコン", "検索エンジンに表示しない", "構造化データ",
    "トークン @ink", "トークン @accent", "トークン @space",
    "section#hero の見た目（共通）: color", "section#hero の見た目（共通）: padding", "section#hero の見た目（768px以上）: maxWidth",
    "h1#heading のテキスト", "a#link の href", "Notice#notice の heading"
  ]);
  const by = Object.fromEntries(changes.map((change) => [change.path, change]));
  assert.deepEqual(by["説明文"], { path: "説明文", before: "（なし）", after: "説明" });
  assert.equal(by["ソーシャルカバー"].after, "/cover.png（海）");
  assert.deepEqual([by["検索エンジンに表示しない"].before, by["検索エンジンに表示しない"].after], ["表示する", "表示しない"]);
  assert.equal(by["構造化データ"].after, "organization, localBusiness");
  assert.deepEqual([by["トークン @ink"].before, by["トークン @ink"].after], ["#172d25", "#000000"]);
  assert.equal(by["トークン @space"].after, "（なし）");
  assert.deepEqual([by["section#hero の見た目（共通）: color"].before, by["section#hero の見た目（共通）: color"].after], ["@ink", "@accent"]);
  assert.deepEqual([by["section#hero の見た目（共通）: padding"].before, by["section#hero の見た目（共通）: padding"].after], ["@space", "24"]);
  assert.deepEqual([by["h1#heading のテキスト"].before, by["h1#heading のテキスト"].after], ["海のそばで過ごす", "新しい見出し"]);
  assert.deepEqual(diffDocuments(before, structuredClone(before)), []);
  assert.deepEqual(before.body.length, 2, "inputs are not mutated");
});

test("diffDocuments reports added, removed and moved nodes without noise from shifted siblings", () => {
  const before = doc(), after = doc();
  after.body[0].children.splice(0, 0, { type: "element", id: "intro", tag: "section", children: [{ type: "element", id: "intro_text", tag: "p", children: [{ type: "text", text: "はじめに" }] }] });
  after.body[0].children = after.body[0].children.filter((node) => node.id !== "lead");
  const added = diffDocuments(before, after);
  assert.deepEqual(added, [
    { path: "section#intro を追加", before: "（なし）", after: "はじめに" },
    { path: "p#lead を削除", before: "同じ文書を複数の公開サイトで描画できます。", after: "（なし）" }
  ]);
  const swapped = doc(); swapped.body[0].children.reverse();
  const moved = diffDocuments(before, swapped);
  assert.ok(paths(moved).includes("h1#heading の位置"));
  assert.deepEqual(moved.find((change) => change.path === "h1#heading の位置"), { path: "h1#heading の位置", before: "section#hero の 1 番目", after: "section#hero の 3 番目" });
  const outside = doc(); const [link] = outside.body[0].children.splice(2, 1); outside.body.push(link);
  assert.deepEqual(diffDocuments(before, outside), [{ path: "a#link の位置", before: "section#hero の 3 番目", after: "ページ直下の 2 番目" }]);
  const retagged = doc(); retagged.body[0].children[0].tag = "h2";
  assert.deepEqual(diffDocuments(before, retagged), [{ path: "h2#heading の種類", before: "h1", after: "h2" }]);
  const topText = doc(); topText.body.push({ type: "text", text: "直下" });
  assert.deepEqual(diffDocuments(before, topText), [{ path: "ページ直下のテキスト", before: "（なし）", after: "直下" }]);
});

test("diffDocuments truncates long values and summarizes changes over the limit", () => {
  const before = doc(), after = doc();
  after.title = "あ".repeat(300);
  const [title] = diffDocuments(before, after);
  assert.equal(title.after.length, 200); assert.ok(title.after.endsWith("…"));
  for (let index = 0; index < 20; index++) after.body.push({ type: "element", id: `extra_${index}`, tag: "p", children: [{ type: "text", text: `段落 ${index}` }] });
  const limited = diffDocuments(before, after, { limit: 5 });
  assert.equal(limited.length, 6);
  assert.deepEqual(limited.at(-1), { path: "ほかの変更", before: "", after: "16 件" });
  assert.equal(diffDocuments(before, after).length, 21);
});

test("revision entries and pages are validated and copied with known fields only", () => {
  const entry = { id: "rev_1", revision: 2, kind: "snapshot", createdAt: "2026-10-21T01:02:03.000Z", actor: "編集者", label: "公開前" };
  const page = parseRevisionPage({ entries: [entry, { id: "rev_0", revision: 1, kind: "publish", createdAt: "2026-10-20T00:00:00Z" }], next: "cursor-2" });
  assert.deepEqual(page.entries[0], entry); assert.notEqual(page.entries[0], entry); assert.equal(page.next, "cursor-2");
  assert.deepEqual(parseRevisionPage({ entries: [] }), { entries: [] });
  for (const bad of [
    { ...entry, id: "" }, { ...entry, id: "a".repeat(201) }, { ...entry, id: "a\nb" }, { ...entry, revision: 0 }, { ...entry, revision: 1.5 },
    { ...entry, kind: "merge" }, { ...entry, createdAt: "not a date" }, { ...entry, createdAt: "2026-10-21T01:02:03.000000000000000000000000Z" },
    { ...entry, actor: "a".repeat(121) }, { ...entry, label: "a\u0007" }, { ...entry, email: "staff@example.test" }
  ]) assert.throws(() => parseRevisionEntry(bad), Error, JSON.stringify(bad));
  for (const bad of [null, [], { entries: "x" }, { entries: Array.from({ length: 101 }, (_, index) => ({ ...entry, id: `rev_${index}` })) },
    { entries: [], next: "a".repeat(501) }, { entries: [], next: "a\nb" }, { entries: [], extra: true }, { entries: [{ ...entry, kind: "unknown" }] }]) assert.throws(() => parseRevisionPage(bad), Error);
});

function memoryStorage() {
  const data = new Map();
  return {
    data,
    get length() { return data.size; },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); }
  };
}
const target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
const entryFor = (overrides = {}) => ({ target, baseVersion: "v1", baseRevision: 1, document: doc(), updatedAt: new Date(1_000_000).toISOString(), ...overrides });

test("browser recovery store round-trips only documented fields and isolates scopes", () => {
  const storage = memoryStorage(), now = () => 1_000_000;
  const staff = createBrowserRecoveryStore({ scope: "staff:a", storage, now }), other = createBrowserRecoveryStore({ scope: "staff:b", storage, now });
  staff.write({ ...entryFor(), target: { ...target, extra: "ignored" }, token: "secret" });
  const key = "niho-web:recovery:v1:staff%3Aa:demo/home/ja-JP";
  assert.deepEqual([...storage.data.keys()], [key]);
  assert.deepEqual(Object.keys(JSON.parse(storage.data.get(key))), ["v", "target", "baseVersion", "baseRevision", "document", "updatedAt"]);
  assert.ok(!storage.data.get(key).includes("secret"));
  assert.deepEqual(staff.read(target), entryFor());
  assert.equal(other.read(target), null);
  assert.equal(staff.read({ ...target, pageId: "about" }), null);
  other.write(entryFor()); staff.clear();
  assert.deepEqual([...storage.data.keys()], ["niho-web:recovery:v1:staff%3Ab:demo/home/ja-JP"]);
  storage.setItem("unrelated", "keep"); other.remove(target);
  assert.deepEqual([...storage.data.keys()], ["unrelated"]);
  for (const scope of ["", "a".repeat(129), "a\nb"]) assert.throws(() => createBrowserRecoveryStore({ scope, storage }));
});

test("browser recovery store purges expired and invalid entries, rejects oversized entries and cleans mismatched targets", () => {
  const storage = memoryStorage();
  let time = 1_000_000;
  const store = createBrowserRecoveryStore({ scope: "staff", storage, now: () => time, maxAgeMs: 1000, maxBytes: 200_000 });
  store.write(entryFor());
  time += 1001;
  assert.equal(store.read(target), null); assert.equal(storage.length, 0);
  time = 1_000_000; store.write(entryFor()); storage.setItem("niho-web:recovery:v1:staff:demo/about/ja-JP", "{broken");
  storage.setItem("niho-web:recovery:v1:other:demo/home/ja-JP", JSON.stringify({ v: 1, target, baseVersion: "v1", baseRevision: 1, document: {}, updatedAt: new Date(0).toISOString() }));
  time += 5000; createBrowserRecoveryStore({ scope: "staff", storage, now: () => time, maxAgeMs: 1000 });
  assert.deepEqual([...storage.data.keys()], ["niho-web:recovery:v1:other:demo/home/ja-JP"], "only this scope's expired and broken keys are purged");
  const big = doc(); big.body[0].children[0].children[0].text = "あ".repeat(120_000);
  assert.throws(() => store.write(entryFor({ document: big })), RecoveryTooLargeError);
  const mismatched = "niho-web:recovery:v1:staff:demo/home/ja-JP";
  storage.setItem(mismatched, JSON.stringify({ v: 1, target: { ...target, pageId: "other" }, baseVersion: "v1", baseRevision: 1, document: doc(), updatedAt: new Date(time).toISOString() }));
  assert.equal(store.read(target), null); assert.equal(storage.getItem(mismatched), null);
  const quota = { ...memoryStorage(), setItem: () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); } };
  assert.throws(() => createBrowserRecoveryStore({ scope: "staff", storage: quota }).write(entryFor()), /quota/);
});

test("browser recovery store tolerates an inaccessible localStorage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    const store = createBrowserRecoveryStore({ scope: "staff" });
    assert.equal(store.read(target), null);
    store.remove(target); store.clear();
    assert.throws(() => store.write(entryFor()), /recovery storage unavailable/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage;
  }
});

test("diffDocuments covers component instances, image assets, block slots and text styles", () => {
  const base = { schemaVersion: 1, siteId: "demo", pageId: "home", locale: "ja-JP", revision: 1, title: "t", tokens: {}, textStyles: { lead: { label: "リード", base: { fontSize: 18 } } }, body: [
    { type: "instance", id: "nav", component: "header", props: { title: "NIHO" } },
    { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "海" }, children: [] },
    { type: "component", id: "cards", block: "Cards", props: { count: 3 }, slots: { card: { base: { padding: 8 } } } },
    { type: "element", id: "lead", tag: "p", style: { textStyle: "lead" }, children: [{ type: "text", text: "a" }] }] };
  const next = structuredClone(base);
  next.textStyles.lead.base.fontSize = 20; next.body[0].component = "header2"; next.body[0].props.title = "NIHO Web";
  next.body[1].asset = { provider: "uploads", id: "wave" }; next.body[2].slots.card.base.padding = 12; delete next.body[3].style.textStyle;
  const changes = diffDocuments(base, next);
  assert.deepEqual(paths(changes), ["文字スタイル リード", "部品 header2#nav の部品", "部品 header2#nav の title", "img#photo の素材", "Cards#cards の領域 card の見た目（共通）: padding", "p#lead の文字スタイル"]);
  assert.deepEqual(changes[3], { path: "img#photo の素材", before: '{"provider":"uploads","id":"sea"}', after: '{"provider":"uploads","id":"wave"}' });
  assert.deepEqual(paths(diffDocuments(base, { ...base, body: [] })), ["部品 header#nav を削除", "img#photo を削除", "Cards#cards を削除", "p#lead を削除"]);
});
