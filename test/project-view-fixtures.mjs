export const at = "2026-10-20T09:00:00Z";
export const project = (suffix = "one") => ({ id: `project_${suffix}`, name: `${suffix}の長い日本語プロジェクト名`, site: { id: `site_${suffix}`, name: `${suffix}のサイト`, domains: [`https://${suffix}.example.test`] }, members: [{ userId: "shared_member", displayName: "共通参加者（架空）" }] });
export const entry = (suffix = "one", updatedAt = at) => {
  const selected = project(suffix);
  return { project: selected, summary: { projectId: selected.id, siteId: selected.site.id, publicationStatus: "published", publishedUrl: selected.site.domains[0], thumbnail: { url: `https://assets.example.test/${suffix}.png`, alt: `${suffix}の合成プレビュー` }, updatedAt, lastAccessedAt: null } };
};
export const directory = () => ({ status: "ready", entries: [entry("one"), entry("two", "2026-10-21T09:00:00Z")] });
export const dashboard = (selected = project()) => ({
  status: "ready", projectId: selected.id, siteId: selected.site.id, fetchedAt: at,
  overview: { status: "ready", data: { publicationStatus: "published", publishedUrl: selected.site.domains[0], lastPublishedAt: at, publishedPageCount: 7, assetBytes: null, recentChanges: [{ id: "change_one", label: "合成ページを更新", changedAt: at }] } },
  analytics: { status: "ready", data: { period: { start: "2026-10-01T00:00:00Z", end: "2026-10-20T23:59:59Z" }, fetchedAt: at, uniqueVisitors: 0, pageViews: null } }
});
