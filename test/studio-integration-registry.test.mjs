import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTrustedIntegrationRegistry, resolveTrustedEditorApi, resolveTrustedEditorPage, resolveTrustedIntegration, trustedEditorPath
} from "../studio/integration-registry.mjs";
import { parseProjectAliasPath, projectRoutePath } from "../studio/project-routes.mjs";

test("trusted Studio integrations resolve canonical, alias and environment routes from one registration", () => {
  assert.equal(resolveTrustedIntegration("project-kamakura", "kamakura")?.environment, "production");
  assert.equal(resolveTrustedIntegration("project-experience", "experience", "staging")?.config.apiPrefix, "/editor-staging");
  assert.equal(resolveTrustedEditorPage("/projects/project-experience/sites/experience/editor/staging/")?.environment, "staging");
  assert.equal(resolveTrustedEditorPage("/projects/niho-experience/admin/editor/staging")?.environment, "staging");
  assert.equal(resolveTrustedEditorApi("project-experience", "experience", "/editor-staging/sites")?.environment, "staging");
  assert.equal(resolveTrustedEditorApi("project-experience", "experience", "/editor/sites")?.environment, "production");
  assert.equal(trustedEditorPath("project-kamakura", "kamakura"), "/projects/project-kamakura/sites/kamakura/editor");
  assert.deepEqual(parseProjectAliasPath("/projects/kamakura-site/admin/editor"), { slug: "kamakura-site", projectId: "project-kamakura", siteId: "kamakura", page: "editor" });
  assert.equal(projectRoutePath("/projects/kamakura-site/admin", "project-kamakura", "kamakura", "editor"), "/projects/kamakura-site/admin/editor");
});

test("a new trusted site round-trips without adding a resolver branch and longer API prefixes win", () => {
  const registry = createTrustedIntegrationRegistry([{
    projectId: "project-atelier",
    siteId: "atelier",
    aliases: ["atelier-site"],
    environments: {
      production: { editorPathSuffix: "", apiPrefix: "/editor" },
      preview: { editorPathSuffix: "/preview", apiPrefix: "/editor/preview" }
    }
  }]);
  const path = registry.editorPath("project-atelier", "atelier", "preview");
  assert.equal(path, "/projects/project-atelier/sites/atelier/editor/preview");
  assert.equal(registry.resolvePage(path)?.environment, "preview");
  assert.equal(registry.resolvePage("/projects/atelier-site/admin/editor/preview/")?.registration.siteId, "atelier");
  assert.equal(registry.resolveApi("project-atelier", "atelier", "/editor/preview/pages")?.environment, "preview");
  assert.equal(registry.resolveApi("project-atelier", "atelier", "/editor/pages")?.environment, "production");
});

test("unknown, mismatched and ambiguous integration definitions fail closed", () => {
  assert.equal(resolveTrustedIntegration("project-kamakura", "experience"), null);
  assert.equal(resolveTrustedIntegration("project-experience", "experience", "unknown"), null);
  assert.equal(resolveTrustedEditorPage("/projects/project-kamakura/sites/experience/editor"), null);
  assert.equal(resolveTrustedEditorPage("/projects/unknown/admin/editor"), null);
  assert.equal(resolveTrustedEditorApi("project-experience", "kamakura", "/editor/sites"), null);
  assert.equal(resolveTrustedEditorApi("project-experience", "experience", "/external/editor"), null);
  assert.throws(() => createTrustedIntegrationRegistry([
    { projectId: "project-one", siteId: "site-one", aliases: ["same"], environments: { production: { editorPathSuffix: "", apiPrefix: "/editor" } } },
    { projectId: "project-two", siteId: "site-two", aliases: ["same"], environments: { production: { editorPathSuffix: "", apiPrefix: "/editor" } } }
  ]), /duplicate or invalid/);
  assert.throws(() => createTrustedIntegrationRegistry([{
    projectId: "project-one", siteId: "site-one", aliases: [],
    environments: { production: { editorPathSuffix: "", apiPrefix: "/editor" }, preview: { editorPathSuffix: "", apiPrefix: "/editor-preview" } }
  }]), /duplicate trusted integration route/);
  assert.throws(() => createTrustedIntegrationRegistry([{
    projectId: "project-one", siteId: "site-one", aliases: [],
    environments: { production: { editorPathSuffix: "", apiPrefix: "/editor" }, preview: { editorPathSuffix: "/preview", apiPrefix: "/editor" } }
  }]), /duplicate trusted integration route/);
});
