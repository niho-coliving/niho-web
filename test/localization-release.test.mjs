import test from "node:test";
import assert from "node:assert/strict";
import {
  contentDigest, createLocalizedSitemap, createPublishedSiteLocaleSnapshot, createRevocationSafeRollback,
  createSiteLocaleReleasePreparation, deriveLocalizedPageSeo, localePath, parsePublishedSiteLocaleSnapshot,
  projectCurrentPublishedSiteLocaleSnapshot, resolveLanguageSwitch, resolveLocalizedInternalLink, siteLocaleReleaseCacheIdentity, validateLocaleRouteCatalogue,
  verifyPreparedSiteLocaleRelease, verifyPublishedSiteLocaleSnapshot
} from "@niho/web/localization-release";

const sha = (letter) => `sha256-${letter.repeat(64)}`;
const liveDependency = { version: "live-1", digest: sha("f") };
const config = (siteId, sourceLocale, defaultLocale = sourceLocale) => ({ schemaVersion: 1, siteId, sourceLocale, defaultLocale, enabledLocales: ["ja", "en"],
  documentLocales: { ja: "ja-JP", en: "en-US" }, glossaryVersion: "g1", contextVersion: "c1" });
const library = (siteId, revision = 1, color = "#123456") => ({ schemaVersion: 1, siteId, revision, tokens: { brand: { type: "color", value: color } }, components: [{
  id: "header", name: "Header", kind: "header", version: revision,
  root: { type: "element", id: "headerRoot", tag: "header", children: [{ type: "element", id: "navText", tag: "p", children: [{ type: "text", text: revision === 1 ? "Old nav" : "New nav" }] }] }
}] });
const page = (siteId, pageId, locale, title, revision = 1, extra = []) => ({ schemaVersion: 1, siteId, pageId, locale, revision, title,
  meta: { description: `${title} description` }, tokens: { spacing: { type: "length", value: revision === 1 ? "8px" : "16px" } }, body: [
    { type: "instance", id: `${pageId}Header`, component: "header" },
    { type: "element", id: `${pageId}Main`, tag: "main", children: [{ type: "element", id: `${pageId}Heading`, tag: "h1", children: [{ type: "text", text: title }] }, ...extra] }
  ] });
const manifest = (target = false, resourceVersion = "css-1") => ({ source: { version: "source-1", digest: sha("a") }, config: { version: "config-1", digest: sha("b") },
  ...(target ? { overlay: { version: "overlay-1", digest: sha("c") } } : {}), resources: [{ id: "siteCss", kind: "css", version: resourceVersion, digest: sha(resourceVersion === "css-1" ? "d" : "e") }] });
async function release({ siteId = "kamakura", sourceLocale = "ja", defaultLocale = sourceLocale, locale = sourceLocale, releaseId = "release-1", version = "v1", revision = 1,
  entries = [{ pageId: "home", path: "/", title: "Home" }, { pageId: "about", path: "/about/", title: "About" }], indexable = {}, nav = entries, resourceVersion = "css-1" } = {}) {
  const cfg = config(siteId, sourceLocale, defaultLocale), target = locale !== sourceLocale;
  return createPublishedSiteLocaleSnapshot({ config: cfg, locale, releaseId, version,
    pages: entries.map((entry) => ({ path: entry.path, document: page(siteId, entry.pageId, cfg.documentLocales[locale], entry.title, revision), indexable: indexable[entry.pageId] ?? true })),
    publicPageIds: entries.map((entry) => entry.pageId), components: library(siteId, revision, revision === 1 ? "#123456" : "#654321"),
    navigation: nav.map((entry) => ({ id: `nav_${entry.pageId}`, label: entry.title, pageId: entry.pageId })), manifest: manifest(target, resourceVersion), requiredResourceIds: ["siteCss"],
    completeness: { reviewedPageIds: target ? entries.map((entry) => entry.pageId) : [], sharedReviewed: target, unresolvedIssues: [] }, supportedBlocks: [] });
}

test("visibility projection preserves exposed shared href bindings and unrelated instance destinations", async () => {
  const shared = library("sharedLinks");
  shared.components[0].props = { destination: { label: "Link", node: "headerRoot", field: "href" } };
  shared.components[0].root = { type: "element", id: "headerRoot", tag: "a", attrs: { href: "/about/" }, children: [{ type: "text", text: "About" }] };
  const home = page("sharedLinks", "home", "en-US", "Home");
  home.body.push({ type: "instance", id: "externalLink", component: "header", props: { destination: "https://external.example/about/" } });
  home.body.push({ type: "instance", id: "removedLink", component: "header", props: { destination: "https://shared.example/en/about/" } });
  const old = await createPublishedSiteLocaleSnapshot({ config: config("sharedLinks", "ja"), locale: "en", releaseId: "old", version: "old-v1",
    pages: [{ path: "/", document: home }, { path: "/about/", document: page("sharedLinks", "about", "en-US", "About") }], publicPageIds: ["home", "about"],
    components: shared, navigation: [{ id: "about", label: "About", pageId: "about" }], manifest: manifest(true),
    completeness: { reviewedPageIds: ["home", "about"], sharedReviewed: true, unresolvedIssues: [] } });
  const visibility = { eligiblePageIds: ["home", "newSourceOnly"], revokedPageIds: ["about"], origins: ["https://shared.example"] };
  const projected = await projectCurrentPublishedSiteLocaleSnapshot({ snapshot: old, visibility });
  assert.equal(projected.components.components[0].root.tag, "a", "the exposed href still fits its canonical element");
  assert.equal(projected.components.components[0].root.attrs?.href, undefined);
  assert.equal(projected.pages[0].document.body.find((node) => node.id === "externalLink").props.destination, "https://external.example/about/");
  assert.equal(projected.pages[0].document.body.find((node) => node.id === "removedLink").props?.destination, undefined);
  assert.equal(old.components.components[0].root.attrs.href, "/about/");
  const rolled = await createRevocationSafeRollback({ previous: old, ...visibility, releaseId: "rolled", version: "rolled-v2" });
  assert.equal(rolled.components.components[0].root.attrs?.href, undefined);
  assert.deepEqual(rolled.pages.map((entry) => entry.pageId), ["home"]);
});

test("document noindex cannot be overridden by a route indexability flag", async () => {
  const document = page("noindex", "home", "en-US", "Private search visibility"); document.meta.noindex = true;
  const snapshot = await createPublishedSiteLocaleSnapshot({ config: config("noindex", "en"), locale: "en", releaseId: "r1", version: "v1",
    pages: [{ path: "/", document, indexable: true }], publicPageIds: ["home"], components: library("noindex"), navigation: [], manifest: manifest(false),
    completeness: { reviewedPageIds: [], sharedReviewed: false, unresolvedIssues: [] } });
  assert.equal(snapshot.pages[0].indexable, false);
  assert.deepEqual(createLocalizedSitemap([{ snapshot, origin: "https://noindex.example" }]), []);
  const tampered = structuredClone(snapshot);
  tampered.pages[0].indexable = tampered.routes[0].indexable = tampered.seo[0].indexable = true;
  assert.throws(() => parsePublishedSiteLocaleSnapshot(tampered), /noindex/);
});

test("locale routes are explicit in both directions and preserve exact source spelling", () => {
  const kamakura = config("kamakura", "ja"), experience = config("experience", "en");
  assert.equal(localePath(kamakura, "ja", "/About-Us/"), "/About-Us/");
  assert.equal(localePath(kamakura, "en", "/About-Us/"), "/en/About-Us/");
  assert.equal(localePath(kamakura, "en", "/about"), "/en/about");
  assert.equal(localePath(kamakura, "en", "/"), "/en/");
  assert.equal(localePath(experience, "en", "/"), "/");
  assert.equal(localePath(experience, "ja", "/"), "/ja/");
  const defaultNotSource = config("explicit", "en", "ja");
  assert.equal(localePath(defaultNotSource, "ja", "/story/"), "/story/");
  assert.equal(localePath(defaultNotSource, "en", "/story/"), "/en/story/");
  assert.throws(() => validateLocaleRouteCatalogue(["/about", "/en/existing"]), /locale prefix/);
  for (const bad of ["../x", "//evil", "/a/../b", "/a%2fb", "/a%ZZ", "/a?x=1"]) assert.throws(() => localePath(kamakura, "en", bad));
});

test("complete target snapshots bind whole pages, shared library, styles and external resources", async () => {
  const snapshot = await release({ locale: "en" });
  const verified = await verifyPublishedSiteLocaleSnapshot(snapshot);
  assert.equal(verified.pages.length, 2); assert.equal(verified.components.tokens.brand.value, "#123456");
  assert.equal(verified.manifest.resources[0].id, "siteCss"); assert.match(verified.contentDigest, /^sha256-/);
  const copy = structuredClone(snapshot); copy.pages[0].document.title = "altered";
  await assert.rejects(() => verifyPublishedSiteLocaleSnapshot(copy), /route or SEO|digest mismatch/);
  assert.throws(() => parsePublishedSiteLocaleSnapshot({ ...snapshot, unknown: true }), /unknown field/);
  await assert.rejects(() => createPublishedSiteLocaleSnapshot({ unknown: true, config: config("kamakura", "ja"), locale: "ja", releaseId: "x", version: "x", pages: [], publicPageIds: [], components: library("kamakura"), navigation: [], manifest: manifest(false), completeness: { reviewedPageIds: [], sharedReviewed: false, unresolvedIssues: [] } }), /unknown field/);
  let deep = null; for (let index = 0; index < 70; index++) deep = { deep }; await assert.rejects(() => contentDigest(deep), /structural limits/);
  await assert.rejects(() => createPublishedSiteLocaleSnapshot({ config: config("kamakura", "ja"), locale: "en", releaseId: "x", version: "x", pages: [{ path: "/", document: page("kamakura", "home", "en-US", "Home") }],
    publicPageIds: ["home"], components: library("kamakura"), navigation: [], manifest: manifest(true), completeness: { reviewedPageIds: ["home"], sharedReviewed: true, unresolvedIssues: [] }, requiredResourceIds: ["missing"] }), /resource binding/);
  await assert.rejects(() => createPublishedSiteLocaleSnapshot({ config: config("kamakura", "ja"), locale: "en", releaseId: "x", version: "x", pages: [{ path: "/", document: page("kamakura", "home", "en-US", "Home") }],
    publicPageIds: ["home"], components: library("kamakura"), navigation: [], manifest: manifest(true), completeness: { reviewedPageIds: ["home"], sharedReviewed: true, unresolvedIssues: [{ code: "UNANCHORED_TEXT", ownerId: "home" }] } }), /unresolved/);
});

test("unsupported blocks and missing shared references prevent a complete release", async () => {
  const booking = { props: { heading: { type: "string" } }, component: () => null };
  const bookingPage = page("blocks", "home", "ja-JP", "Home", 1, [{ type: "component", id: "booking", block: "Booking", props: { heading: "Book" } }]);
  await assert.rejects(() => createPublishedSiteLocaleSnapshot({ config: config("blocks", "ja"), locale: "ja", releaseId: "r", version: "v", pages: [{ path: "/", document: bookingPage }], publicPageIds: ["home"],
    components: library("blocks"), navigation: [], manifest: manifest(false), completeness: { reviewedPageIds: [], sharedReviewed: false, unresolvedIssues: [] }, supportedBlocks: [] }, { blocks: { Booking: booking } }), /unsupported block/);
  const missing = page("missing", "home", "ja-JP", "Home"); missing.body[0].component = "gone";
  await assert.rejects(() => createPublishedSiteLocaleSnapshot({ config: config("missing", "ja"), locale: "ja", releaseId: "r", version: "v", pages: [{ path: "/", document: missing }], publicPageIds: ["home"],
    components: library("missing"), navigation: [], manifest: manifest(false), completeness: { reviewedPageIds: [], sharedReviewed: false, unresolvedIssues: [] } }), /component/);
});

test("registered business blocks survive every release, route, SEO, cache and rollback boundary", async () => {
  const options = { blocks: {
    ExperienceGrid: { props: { heading: { type: "string", required: true } } },
    BookingPanel: { props: { bookingId: { type: "string", required: true } } }
  } };
  const blockRelease = async (locale, releaseId, version, revision) => {
    const cfg = config("blocks", "ja"), target = locale === "en";
    const documents = [
      page("blocks", "home", cfg.documentLocales[locale], locale === "ja" ? "体験" : "Experiences", revision, [{ type: "component", id: `grid${revision}`, block: "ExperienceGrid", props: { heading: "Featured" } }]),
      page("blocks", "booking", cfg.documentLocales[locale], locale === "ja" ? "予約" : "Booking", revision, [{ type: "component", id: `booking${revision}`, block: "BookingPanel", props: { bookingId: "booking-42" } }])
    ];
    return createPublishedSiteLocaleSnapshot({ config: cfg, locale, releaseId, version, pages: [{ path: "/", document: documents[0] }, { path: "/booking/", document: documents[1] }],
      publicPageIds: ["home", "booking"], components: library("blocks", revision), navigation: [{ id: "home", label: "Home", pageId: "home" }, { id: "booking", label: "Booking", pageId: "booking" }],
      manifest: manifest(target, revision === 1 ? "css-1" : "css-2"), requiredResourceIds: ["siteCss"], supportedBlocks: ["ExperienceGrid", "BookingPanel"],
      completeness: { reviewedPageIds: target ? ["home", "booking"] : [], sharedReviewed: target, unresolvedIssues: [] } }, options);
  };
  const source = await blockRelease("ja", "ja-blocks", "ja-blocks-v1", 1), current = await blockRelease("en", "en-blocks-1", "en-blocks-v1", 1), candidate = await blockRelease("en", "en-blocks-2", "en-blocks-v2", 2);
  await verifyPublishedSiteLocaleSnapshot(current, options);
  const preparation = createSiteLocaleReleasePreparation({ action: "publish", expectedCurrentVersion: current.version, candidate, liveDependency, expiresAt: "2030-01-01T00:00:00.000Z" }, options);
  await verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation, liveDependency, now: "2029-01-01T00:00:00.000Z" }, options);
  assert.equal(resolveLocalizedInternalLink({ href: "/booking/?a=1#form", current: source, target: candidate }, options).href, "/en/booking/?a=1#form");
  assert.equal(resolveLanguageSwitch(source, "booking", [candidate], { en: "https://blocks.example" }, options)[0].href, "https://blocks.example/en/booking/");
  assert.equal(deriveLocalizedPageSeo({ snapshot: candidate, pageId: "booking", origin: "https://blocks.example", counterparts: [{ snapshot: source, origin: "https://blocks-ja.example" }] }, options).hreflang.length, 2);
  assert.equal(createLocalizedSitemap([{ snapshot: candidate, origin: "https://blocks.example" }], options).length, 2);
  assert.match(siteLocaleReleaseCacheIdentity(candidate, "home", options), /^blocks:en:/);
  const rolled = await createRevocationSafeRollback({ previous: current, releaseId: "en-blocks-rollback", version: "en-blocks-v3", eligiblePageIds: ["home", "booking", "new-untranslated"], revokedPageIds: [], origins: ["https://blocks.example"] }, options);
  assert.deepEqual(rolled.supportedBlocks, ["ExperienceGrid", "BookingPanel"]);
  const rollbackPreparation = createSiteLocaleReleasePreparation({ action: "rollback", expectedCurrentVersion: current.version, candidate: rolled, liveDependency, expiresAt: "2030-01-01T00:00:00.000Z" }, options);
  await verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: rolled, preparation: rollbackPreparation, liveDependency, now: "2029-01-01T00:00:00.000Z" }, options);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: rolled, preparation: rollbackPreparation, liveDependency: { version: "changed", digest: sha("9") }, now: "2029-01-01T00:00:00.000Z" }, options), /dependencies changed/);
});

test("source-first publication leaves the previous target whole snapshot untouched, then target switches atomically", async () => {
  const targetV1 = await release({ locale: "en", releaseId: "en-1", version: "en-v1" });
  const sourceV2 = await release({ releaseId: "ja-2", version: "ja-v2", revision: 2, resourceVersion: "css-2",
    entries: [{ pageId: "home", path: "/", title: "ホーム2" }, { pageId: "about", path: "/about-new/", title: "About2" }, { pageId: "newPage", path: "/new/", title: "New" }] });
  assert.equal(targetV1.pages.length, 2); assert.equal(targetV1.pages[1].sourcePath, "/about/"); assert.equal(targetV1.components.tokens.brand.value, "#123456");
  assert.equal(targetV1.navigation.length, 2); assert.equal(targetV1.manifest.resources[0].version, "css-1");
  assert.equal(sourceV2.pages.length, 3); assert.equal(sourceV2.components.tokens.brand.value, "#654321");
  assert.equal(createLocalizedSitemap([{ snapshot: targetV1, origin: "https://en.example" }]).some((entry) => entry.pageId === "newPage"), false);
  assert.deepEqual(resolveLanguageSwitch(sourceV2, "newPage", [targetV1], { en: "https://en.example" }), []);
  const targetV2 = await release({ locale: "en", releaseId: "en-2", version: "en-v2", revision: 2, resourceVersion: "css-2",
    entries: [{ pageId: "home", path: "/", title: "Home2" }, { pageId: "about", path: "/about-new/", title: "About2" }, { pageId: "newPage", path: "/new/", title: "New" }] });
  assert.deepEqual(targetV2.pages.map((entry) => entry.pageId), ["home", "about", "newPage"]); assert.equal(targetV2.components.revision, 2); assert.equal(targetV2.navigation.length, 3);
});

test("route resolver rewrites only exact released pages and exposes source-only pages", async () => {
  const source = await release({ releaseId: "ja-2", version: "ja-v2", entries: [{ pageId: "home", path: "/", title: "Home" }, { pageId: "about", path: "/about-new/", title: "About" }, { pageId: "newPage", path: "/new/", title: "New" }] });
  const target = await release({ locale: "en", releaseId: "en-1", version: "en-v1" });
  assert.deepEqual(resolveLocalizedInternalLink({ href: "/about/?ref=nav#team", current: target, target: source, known: [target] }), { status: "localized", href: "/about-new/?ref=nav#team", pageId: "about" });
  assert.deepEqual(resolveLocalizedInternalLink({ href: "/about?ref=nav", current: target, target: source }), { status: "unaffected" }, "trailing-slash spelling is exact");
  assert.deepEqual(resolveLocalizedInternalLink({ href: "/new/?q=1#x", current: source, target, known: [source] }), { status: "unresolved-known", pageId: "newPage" });
  for (const href of ["https://external.example/about/", "/api/book", "/assets/logo.svg", "/embed/map", "mailto:a@example.com", "/draft-only/"]) assert.deepEqual(resolveLocalizedInternalLink({ href, current: source, target }), { status: "unaffected" });
  const foreign = await release({ siteId: "experience", sourceLocale: "en", locale: "en", releaseId: "other", version: "other" });
  assert.throws(() => resolveLocalizedInternalLink({ href: "/about/", current: source, target, known: [foreign] }), /another site/);
});

test("prepare verification rejects drift, expiry, altered scope and preserves the caller current value", async () => {
  const current = await release({ locale: "en", releaseId: "en-1", version: "v1" }), candidate = await release({ locale: "en", releaseId: "en-2", version: "v2", revision: 2, resourceVersion: "css-2" });
  const preparation = createSiteLocaleReleasePreparation({ action: "publish", expectedCurrentVersion: current.version, candidate, liveDependency, expiresAt: "2030-01-01T00:00:00.000Z" });
  const applied = await verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation, liveDependency, now: "2029-01-01T00:00:00.000Z" });
  assert.equal(applied.releaseId, "en-2"); assert.equal(current.releaseId, "en-1");
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current: { ...current, version: "changed" }, recomputedCandidate: candidate, preparation, liveDependency, now: "2029-01-01T00:00:00.000Z" }), /version changed|digest mismatch/);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation, liveDependency, now: "2030-01-01T00:00:00.000Z" }), /expired/);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation: { ...preparation, locale: "ja" }, liveDependency, now: "2029-01-01T00:00:00.000Z" }), /identity mismatch/);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation: { ...preparation, siteId: "experience" }, liveDependency, now: "2029-01-01T00:00:00.000Z" }), /identity mismatch/);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: candidate, preparation, liveDependency: { version: "live-2", digest: sha("1") }, now: "2029-01-01T00:00:00.000Z" }), /dependencies changed/);
  const foreignCurrent = await release({ siteId: "experience", sourceLocale: "en", locale: "en", releaseId: "foreign", version: "v1" });
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current: foreignCurrent, recomputedCandidate: candidate, preparation, liveDependency, now: "2029-01-01T00:00:00.000Z" }), /identity mismatch/);
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: current, preparation: createSiteLocaleReleasePreparation({ action: "publish", expectedCurrentVersion: current.version, candidate: current, liveDependency, expiresAt: "2030-01-01T00:00:00.000Z" }), liveDependency, now: "2029-01-01T00:00:00.000Z" }), /new immutable identity/);
  const changed = structuredClone(candidate); changed.manifest.source.version = "source-2";
  await assert.rejects(() => verifyPreparedSiteLocaleRelease({ current, recomputedCandidate: changed, preparation, liveDependency, now: "2029-01-01T00:00:00.000Z" }));
  assert.equal(current.releaseId, "en-1", "failed apply validation must not mutate current");
});

test("current visibility projection and rollback remove revoked pages, links, navigation and metadata without joining new source pages", async () => {
  const old = await release({ locale: "en", releaseId: "en-old", version: "old" });
  old.pages[0].document.body[1].children.push({ type: "element", id: "toAbout", tag: "a", attrs: { href: "/en/about/?from=body#top" }, children: [{ type: "text", text: "About" }] });
  old.components.components[0].root = { type: "element", id: "headerRoot", tag: "a", attrs: { href: "https://en.example/en/about/" }, children: [{ type: "text", text: "Old nav" }] };
  old.navigation.push({ id: "hrefAbout", label: "About link", href: "https://en.example/en/about/" }, { id: "hrefAboutRelative", label: "About relative", href: "/en/about/" },
    { id: "externalAbout", label: "External", href: "https://external.example/en/about/" });
  const { contentDigest: _oldDigest, ...oldPayload } = old; old.contentDigest = await contentDigest(oldPayload);
  const visibility = { eligiblePageIds: ["home", "newSourceOnly"], revokedPageIds: ["about"], origins: ["https://en.example"] };
  const projected = await projectCurrentPublishedSiteLocaleSnapshot({ snapshot: old, visibility });
  assert.deepEqual(projected.pages.map((entry) => entry.pageId), ["home"]); assert.equal(projected.pages[0].document.body[1].children.at(-1).tag, "span");
  assert.equal(projected.components.components[0].root.tag, "span"); assert.deepEqual(projected.navigation.map((entry) => entry.id), ["nav_home", "externalAbout"]);
  assert.deepEqual(createLocalizedSitemap([{ snapshot: projected, origin: "https://en.example" }]).map((entry) => entry.pageId), ["home"]);
  assert.deepEqual(resolveLanguageSwitch(projected, "about", [projected], { en: "https://en.example" }), []);
  assert.throws(() => deriveLocalizedPageSeo({ snapshot: projected, pageId: "about", origin: "https://en.example" }), /not published/);
  assert.notEqual(siteLocaleReleaseCacheIdentity(projected, "home"), siteLocaleReleaseCacheIdentity(old, "home"));
  assert.equal(old.pages.length, 2); assert.equal(old.components.components[0].root.tag, "a", "stored immutable release remains unchanged");
  const rolled = await createRevocationSafeRollback({ previous: old, releaseId: "en-rollback", version: "new", ...visibility });
  assert.deepEqual(rolled.pages.map((entry) => entry.pageId), ["home"]); assert.equal(rolled.releaseId, "en-rollback");
  const linkOptions = { blocks: { BookingLink: { props: { href: { type: "url", required: true } } } } };
  const linked = await createPublishedSiteLocaleSnapshot({ config: config("linked", "ja"), locale: "en", releaseId: "linked-1", version: "linked-v1",
    pages: [{ path: "/", document: page("linked", "home", "en-US", "Home", 1, [{ type: "component", id: "requiredLink", block: "BookingLink", props: { href: "/en/about/" } }]) },
      { path: "/about/", document: page("linked", "about", "en-US", "About") }], publicPageIds: ["home", "about"], components: library("linked"), navigation: [], manifest: manifest(true),
    completeness: { reviewedPageIds: ["home", "about"], sharedReviewed: true, unresolvedIssues: [] }, supportedBlocks: ["BookingLink"] }, linkOptions);
  await assert.rejects(() => createRevocationSafeRollback({ previous: linked, releaseId: "linked-2", version: "linked-v2", eligiblePageIds: ["home"], revokedPageIds: ["about"], origins: [] }, linkOptions), /required/);
  await assert.rejects(() => projectCurrentPublishedSiteLocaleSnapshot({ snapshot: old, visibility: { eligiblePageIds: ["newSourceOnly"], revokedPageIds: ["home", "about"], origins: ["https://en.example"] } }), /no public pages/);
});

test("SEO, switch, sitemap and cache identity use actual current published releases only", async () => {
  const source = await release({ releaseId: "ja-new", version: "ja-new", entries: [{ pageId: "home", path: "/", title: "Home" }, { pageId: "about", path: "/about-new/", title: "About" }] });
  const target = await release({ locale: "en", releaseId: "en-old", version: "en-old", indexable: { about: false } });
  const seo = deriveLocalizedPageSeo({ snapshot: source, pageId: "about", origin: "https://ja.example", counterparts: [{ snapshot: target, origin: "https://en.example" }] });
  assert.equal(seo.canonical, "https://ja.example/about-new/"); assert.equal(seo.hreflang.length, 1); assert.equal(seo.xDefault, "https://ja.example/about-new/");
  const preview = deriveLocalizedPageSeo({ snapshot: source, pageId: "home", origin: "https://ja.example", counterparts: [{ snapshot: target, origin: "https://en.example" }], preview: true });
  assert.equal(preview.robots, "noindex, nofollow"); assert.equal(preview.canonical, undefined); assert.deepEqual(preview.hreflang, []);
  assert.deepEqual(resolveLanguageSwitch(source, "about", [source, target], { ja: "https://ja.example", en: "https://en.example" }), [
    { locale: "ja", href: "https://ja.example/about-new/" }, { locale: "en", href: "https://en.example/en/about/" }
  ]);
  const sitemap = createLocalizedSitemap([{ snapshot: source, origin: "https://ja.example" }, { snapshot: target, origin: "https://en.example" }]);
  assert.equal(sitemap.some((entry) => entry.locale === "en" && entry.pageId === "about"), false);
  assert.match(siteLocaleReleaseCacheIdentity(source, "home"), /^kamakura:ja:ja-new:home:sha256-/);
});
