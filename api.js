/**
 * Browser client for the Slide Studio backend. The editor holds no storage of
 * its own: every read and write goes through here.
 */
(() => {
  // Loopback needs no token. Opening the editor from another machine does, so
  // the page keeps whatever `?token=` it was opened with.
  const STORAGE_KEY = "slide-studio-access";
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      /* Private windows can refuse storage. The in-memory value still works. */
    }
    history.replaceState({}, "", location.pathname);
  }
  let token = fromUrl;
  if (!token) {
    try {
      token = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      token = null;
    }
  }

  function authHeaders(extra = {}) {
    return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
  }

  async function call(path, { method = "GET", body = null } = {}) {
    const response = await fetch(path, {
      method,
      headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed with ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  window.slideApi = {
    health: () => call("/api/health"),

    listLibrary: ({ kind = null, query = "", limit = 200, sort = null } = {}) => {
      const search = new URLSearchParams();
      if (kind) search.set("kind", kind);
      if (query) search.set("q", query);
      if (sort) search.set("sort", sort);
      search.set("limit", String(limit));
      return call(`/api/library?${search}`);
    },
    getLibraryItem: (id) => call(`/api/library/${encodeURIComponent(id)}`),
    async uploadLibraryItem({ kind, file, name, description = "", usage = "", tags = "", width, height }) {
      const data = await fileToBase64(file);
      const result = await call("/api/library", {
        method: "POST",
        body: { kind, name: name || file.name.replace(/\.[^.]+$/, ""), description, usage, tags, contentType: file.type, data, width, height },
      });
      return result.item;
    },
    updateLibraryItem: (id, patch) => call(`/api/library/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }).then((r) => r.item),
    deleteLibraryItem: (id, { force = false } = {}) =>
      call(`/api/library/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, { method: "DELETE" }),

    listProjects: ({ status = null } = {}) =>
      call(`/api/projects${status ? `?status=${encodeURIComponent(status)}` : ""}`).then((r) => r.projects),
    setProjectStatus: (id, status) =>
      call(`/api/projects/${encodeURIComponent(id)}/status`, { method: "PATCH", body: { status } }).then((r) => r.project),
    getProject: (id) => call(`/api/projects/${encodeURIComponent(id)}`).then((r) => r.project),
    createProject: (name, document) => call("/api/projects", { method: "POST", body: { name, document } }).then((r) => r.project),
    saveProject: (id, { name, version, document }) =>
      call(`/api/projects/${encodeURIComponent(id)}`, { method: "PUT", body: { name, version, document } }).then((r) => r.project),
    deleteProject: (id) => call(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Reconnects on its own, because the browser retries an SSE stream by default. */
    subscribe(onEvent) {
      // EventSource cannot set headers, so a remote page passes the token in the
      // query string. The server accepts it there for this reason alone.
      const source = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events");
      source.onmessage = (event) => {
        try {
          onEvent(JSON.parse(event.data));
        } catch {
          /* Heartbeats and comments carry no payload. */
        }
      };
      return source;
    },
  };
})();
