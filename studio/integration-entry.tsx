import type { ComponentType } from "react";
import type { Project } from "../src/projects.js";
import { ExperienceEditor } from "./experience-editor.js";
import { integrationIdentity, type ResolvedTrustedIntegration } from "./integration-registry.mjs";
import { KamakuraEditor } from "./kamakura-editor.js";

export type TrustedEditorProps = { readonly project: Project; readonly environment: string };
type ClientIntegration = { readonly Editor: ComponentType<TrustedEditorProps>; readonly shellClass?: string; readonly contentClass?: string };

const CLIENT_INTEGRATIONS: ReadonlyMap<string, ClientIntegration> = new Map([
  [integrationIdentity("project-kamakura", "kamakura"), { Editor: KamakuraEditor, shellClass: "studio-editor-shell", contentClass: "studio-editor-content" }],
  [integrationIdentity("project-experience", "experience"), { Editor: ExperienceEditor, shellClass: "studio-editor-shell", contentClass: "studio-editor-content" }]
]);

export function resolveClientIntegration(resolved: ResolvedTrustedIntegration | null): ClientIntegration | null {
  if (!resolved) return null;
  return CLIENT_INTEGRATIONS.get(integrationIdentity(resolved.registration.projectId, resolved.registration.siteId)) ?? null;
}

export function TrustedIntegrationEditor({ resolved, project }: { readonly resolved: ResolvedTrustedIntegration; readonly project: Project }) {
  const integration = resolveClientIntegration(resolved);
  if (!integration) return null;
  const Editor = integration.Editor;
  return <Editor project={project} environment={resolved.environment} />;
}
