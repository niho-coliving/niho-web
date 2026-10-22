import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function loadKamakuraCatalogContract() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-catalog.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

const contract = await loadKamakuraCatalogContract();
const communityDinnerTitle = "Kamakura: Community Dinner with Locals  | NIHO kamakura -- Shared living-room in Kamakura, where tourists and locals can get together";

function catalog(pageTitle = "NIHO Kamakura") {
  const site = { id: "kamakura", name: "鎌倉サイト（新サイト確認用）", domains: ["https://next-kamakura.niho.life"] };
  return {
    project: { id: "kamakura-site", name: "NIHO kamakura", site },
    sites: [site],
    pages: [{ siteId: "kamakura", pageId: "kamakura-community-dinner", locale: "ja", title: pageTitle }],
    legacy: [{ name: "home", path: "/" }],
    blockContracts: {
      KamakuraLegacyForm: {
        props: { formId: { type: "enum", values: ["community-dinner", "parenting", "remotework"] } },
        slots: {
          form: { label: "体験予約フォーム", style: ["backgroundColor", "color", "padding", "borderRadius"], data: { reason: "Kamakuraサイトの既存フォームが管理します。", source: "Kamakuraサイト" } },
          field: { label: "フォーム入力欄", style: ["backgroundColor", "color", "borderColor", "borderRadius", "padding"] },
          submit: { label: "送信ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"] }
        }
      }
    }
  };
}

test("shared catalog contract accepts the current 133-character page title", () => {
  assert.equal(communityDinnerTitle.length, 133);
  const result = contract.parseKamakuraCatalog(catalog(communityDinnerTitle));
  assert.equal(result.pages[0].title, communityDinnerTitle);
  assert.deepEqual(result.pages[0], {
    siteId: "kamakura",
    pageId: "kamakura-community-dinner",
    locale: "ja",
    title: communityDinnerTitle
  });
});

test("shared catalog contract normalizes known fields and rejects unsafe or mismatched data", () => {
  const extended = catalog();
  extended.unexpected = "ignored";
  extended.pages[0].untrusted = "ignored";
  const result = contract.parseKamakuraCatalog(extended);
  assert.equal("unexpected" in result, false);
  assert.equal("untrusted" in result.pages[0], false);
  assert.equal(result.blockContracts.KamakuraLegacyForm.props.formId.values[0], "community-dinner");

  for (const invalid of [
    { ...catalog(), project: { id: "other-project", name: "NIHO kamakura", site: catalog().project.site } },
    catalog("unsafe\nname"),
    { ...catalog(), pages: [catalog().pages[0], catalog().pages[0]] },
    { ...catalog(), legacy: [{ name: "home", path: "/../admin" }] },
    { ...catalog(), blockContracts: {} },
    { ...catalog(), blockContracts: { constructor: { props: {} } } },
    { ...catalog(), blockContracts: { unsafe: { props: { field: { type: "unknown" } } } } },
    { ...catalog(), blockContracts: { unsafe: { props: {}, slots: { item: { label: "Unsafe", style: ["backgroundImage"] } } } } },
    { ...catalog(), blockContracts: { unsafe: { props: {}, slots: { item: { label: "Unsafe", data: { reason: "missing source" } } } } } }
  ]) {
    assert.throws(
      () => contract.parseKamakuraCatalog(invalid),
      (error) => error instanceof contract.KamakuraCatalogContractError && error.code === contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE
    );
  }
  assert.equal(contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, 502);
});

test("shared catalog contract keeps collection limits at the bridge boundary", () => {
  const tooManyPages = { ...catalog(), pages: Array.from({ length: 501 }, (_, index) => ({ siteId: "kamakura", pageId: `page-${index}`, locale: "ja", title: "Page" })) };
  assert.throws(
    () => contract.parseKamakuraCatalog(tooManyPages),
    (error) => error instanceof contract.KamakuraCatalogContractError
  );
});
