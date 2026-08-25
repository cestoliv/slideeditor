/** The editor URL an agent opens to see a slideshow. Ported from server/api.mjs:144-146. */
export function editUrl(base: string, projectId: string): string {
  return `${base}/projects/${projectId}`;
}
