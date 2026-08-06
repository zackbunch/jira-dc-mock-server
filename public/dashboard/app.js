(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const elements = {
    authBanner: $("#auth-banner"),
    tokenForm: $("#token-form"),
    tokenInput: $("#token-input"),
    serverStatus: $("#server-status"),
    serverStatusLabel: $(".server-status-label"),
    projectList: $("#project-list"),
    projectSelect: $("#project-select"),
    statusSelect: $("#status-select"),
    assigneeSelect: $("#assignee-select"),
    searchInput: $("#search-input"),
    filterForm: $("#filter-form"),
    clearFilters: $("#clear-filters"),
    issuesBody: $("#issues-body"),
    tableRegion: $("#table-region"),
    emptyState: $("#empty-state"),
    errorState: $("#error-state"),
    errorMessage: $("#error-message"),
    resultSummary: $("#result-summary"),
    pageRange: $("#page-range"),
    pageLabel: $("#page-label"),
    previousPage: $("#previous-page"),
    nextPage: $("#next-page"),
    issuePanel: $("#issue-panel"),
    issuePanelEmpty: $("#issue-panel-empty"),
    issuePanelContent: $("#issue-panel-content"),
    resetDialog: $("#reset-dialog"),
    confirmReset: $("#confirm-reset"),
    toastRegion: $("#toast-region"),
  };

  const state = {
    token: readSessionToken(),
    projects: [],
    projectCounts: new Map(),
    statuses: [],
    users: [],
    issues: [],
    total: 0,
    startAt: 0,
    maxResults: 25,
    project: "",
    status: "",
    assignee: "",
    search: "",
    selectedKey: "",
    selectedIssue: null,
    searchSequence: 0,
    issueSequence: 0,
  };

  elements.tokenInput.value = state.token;

  function readSessionToken() {
    try {
      return sessionStorage.getItem("jira-mock-token") || "local-test-token";
    } catch {
      return "local-test-token";
    }
  }

  function saveSessionToken(token) {
    try {
      sessionStorage.setItem("jira-mock-token", token);
    } catch {
      // The dashboard still works when session storage is unavailable.
    }
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      throw new ApiError("The Jira Mock server could not be reached.", 0);
    }

    if (response.status === 401) {
      elements.authBanner.hidden = false;
      throw new ApiError("Authentication failed. Check the bearer token and try again.", 401);
    }

    if (response.status === 204) return null;

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const messages = body && typeof body === "object"
        ? [
            ...(Array.isArray(body.errorMessages) ? body.errorMessages : []),
            ...Object.values(body.errors || {}),
          ]
        : [];
      throw new ApiError(messages.filter(Boolean).join(" ") || `Request failed with status ${response.status}.`, response.status);
    }
    elements.authBanner.hidden = true;
    return body;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeJql(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  function initials(name) {
    return String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function compactProjectKey(key) {
    const letters = String(key || "").replace(/[^A-Za-z0-9]/g, "");
    return letters.length <= 3 ? letters.toUpperCase() : `${letters[0]}${letters.at(-1)}`.toUpperCase();
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return String(value || "—");
    const elapsed = Date.now() - date.valueOf();
    if (elapsed >= 0 && elapsed < 60_000) return "Just now";
    if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
    if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    if (elapsed >= 0 && elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
  }

  function prioritySymbol(name) {
    const level = String(name || "").toLowerCase();
    if (level === "highest" || level === "high") return "↑";
    if (level === "lowest" || level === "low") return "↓";
    return "–";
  }

  function statusChip(status) {
    const category = status?.statusCategory?.key || "new";
    return `<span class="status-chip" data-category="${escapeHtml(category)}">${escapeHtml(status?.name || "Unknown")}</span>`;
  }

  function priorityMarkup(priority) {
    const name = priority?.name || "Unknown";
    const level = name.toLowerCase();
    return `<span class="priority" data-level="${escapeHtml(level)}"><span class="priority-symbol" aria-hidden="true">${prioritySymbol(name)}</span><span>${escapeHtml(name)}</span></span>`;
  }

  function showToast(message, kind = "success") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.kind = kind;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.textContent = message;
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  async function loadHealth() {
    try {
      const response = await fetch("/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error();
      const health = await response.json();
      elements.serverStatus.dataset.state = "healthy";
      elements.serverStatusLabel.textContent = health.status === "ok" ? "Server healthy" : "Server responding";
    } catch {
      elements.serverStatus.dataset.state = "error";
      elements.serverStatusLabel.textContent = "Server unavailable";
    }
  }

  async function loadMetadata() {
    const [projects, statuses, users] = await Promise.all([
      api("/rest/api/2/project"),
      api("/rest/api/2/status"),
      api("/rest/api/2/user/assignable/search?maxResults=100"),
    ]);
    state.projects = projects;
    state.statuses = statuses;
    state.users = users;

    const countResults = await Promise.all(
      projects.map(async (project) => {
        const result = await api("/rest/api/2/search", {
          method: "POST",
          body: JSON.stringify({ jql: `project = ${project.key}`, maxResults: 1, fields: ["summary"] }),
        });
        return [project.key, result.total];
      }),
    );
    state.projectCounts = new Map(countResults);
    renderProjectNavigation();
    renderFilterOptions();
  }

  function renderProjectNavigation() {
    const total = [...state.projectCounts.values()].reduce((sum, count) => sum + count, 0);
    const allButton = `
      <button class="project-button" type="button" data-project="" ${state.project ? "" : 'aria-current="page"'}>
        <span class="project-avatar" aria-hidden="true">All</span>
        <span class="project-name">All projects</span>
        <span class="project-count">${total}</span>
      </button>`;
    const projectButtons = state.projects.map((project) => `
      <button class="project-button" type="button" data-project="${escapeHtml(project.key)}" ${state.project === project.key ? 'aria-current="page"' : ""} title="${escapeHtml(project.name)}">
        <span class="project-avatar" aria-hidden="true">${escapeHtml(compactProjectKey(project.key))}</span>
        <span class="project-name">${escapeHtml(project.key)}</span>
        <span class="project-count">${state.projectCounts.get(project.key) ?? 0}</span>
      </button>`).join("");
    elements.projectList.innerHTML = allButton + projectButtons;

    elements.projectList.querySelectorAll(".project-button").forEach((button) => {
      button.addEventListener("click", () => {
        state.project = button.dataset.project || "";
        state.startAt = 0;
        elements.projectSelect.value = state.project;
        renderProjectNavigation();
        updateClearButton();
        void loadIssues();
      });
    });
  }

  function replaceSelectOptions(select, baseLabel, items, value, getValue, getLabel) {
    select.replaceChildren();
    const base = document.createElement("option");
    base.value = "";
    base.textContent = baseLabel;
    select.append(base);
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = getValue(item);
      option.textContent = getLabel(item);
      select.append(option);
    });
    select.value = value;
  }

  function renderFilterOptions() {
    replaceSelectOptions(elements.projectSelect, "All projects", state.projects, state.project, (project) => project.key, (project) => `${project.key} — ${project.name}`);
    replaceSelectOptions(elements.statusSelect, "All statuses", state.statuses, state.status, (status) => status.name, (status) => status.name);
    replaceSelectOptions(elements.assigneeSelect, "Anyone", state.users, state.assignee, (user) => user.name, (user) => user.displayName);
  }

  function buildJql() {
    const clauses = [];
    if (state.project) clauses.push(`project = ${state.project}`);
    if (state.status) clauses.push(`status = "${escapeJql(state.status)}"`);
    if (state.assignee) clauses.push(`assignee = "${escapeJql(state.assignee)}"`);
    if (state.search) {
      const query = state.search.trim();
      if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(query)) {
        clauses.push(`key = "${escapeJql(query)}"`);
      } else {
        clauses.push(`text ~ "${escapeJql(query)}"`);
      }
    }
    if (clauses.length === 0 && state.projects.length > 0) {
      clauses.push(`project IN (${state.projects.map((project) => project.key).join(", ")})`);
    }
    return `${clauses.join(" AND ")}${clauses.length ? " " : ""}ORDER BY updated DESC`;
  }

  function renderLoadingRows() {
    elements.issuesBody.innerHTML = Array.from({ length: 9 }, () => `
      <tr aria-hidden="true">
        <td><div class="skeleton-cell"></div></td>
        <td><div class="skeleton-cell"></div></td>
        <td><div class="skeleton-cell"></div></td>
        <td class="column-assignee"><div class="skeleton-cell"></div></td>
        <td class="column-priority"><div class="skeleton-cell"></div></td>
        <td class="column-updated"><div class="skeleton-cell"></div></td>
      </tr>`).join("");
  }

  async function loadIssues() {
    const sequence = ++state.searchSequence;
    elements.tableRegion.setAttribute("aria-busy", "true");
    elements.emptyState.hidden = true;
    elements.errorState.hidden = true;
    renderLoadingRows();
    elements.resultSummary.textContent = "Loading issues…";

    try {
      const result = await api("/rest/api/2/search", {
        method: "POST",
        body: JSON.stringify({
          jql: buildJql(),
          startAt: state.startAt,
          maxResults: state.maxResults,
          fields: ["project", "issuetype", "summary", "description", "status", "priority", "assignee", "reporter", "labels", "created", "updated", "comment"],
        }),
      });
      if (sequence !== state.searchSequence) return;
      state.issues = result.issues;
      state.total = result.total;
      renderIssues();
      renderPagination();

      const selectedStillVisible = state.issues.some((issue) => issue.key === state.selectedKey);
      if (!selectedStillVisible) {
        state.selectedKey = state.issues[0]?.key || "";
        state.selectedIssue = null;
        renderIssues();
        if (state.selectedKey) void loadIssueDetail(state.selectedKey, false);
        else clearIssuePanel();
      }
    } catch (error) {
      if (sequence !== state.searchSequence) return;
      state.issues = [];
      state.total = 0;
      elements.issuesBody.replaceChildren();
      elements.errorMessage.textContent = error instanceof Error ? error.message : "The server returned an unexpected response.";
      elements.errorState.hidden = false;
      elements.resultSummary.textContent = "Issues unavailable";
      renderPagination();
    } finally {
      if (sequence === state.searchSequence) elements.tableRegion.setAttribute("aria-busy", "false");
    }
  }

  function renderIssues() {
    elements.emptyState.hidden = state.issues.length > 0;
    elements.errorState.hidden = true;
    elements.resultSummary.textContent = `${state.total.toLocaleString()} ${state.total === 1 ? "issue" : "issues"}`;
    elements.issuesBody.innerHTML = state.issues.map((issue) => {
      const fields = issue.fields;
      const selected = state.selectedKey === issue.key;
      const assignee = fields.assignee;
      return `
        <tr class="issue-row" data-key="${escapeHtml(issue.key)}" data-selected="${selected}" ${selected ? 'aria-selected="true"' : ""}>
          <td><span class="issue-key">${escapeHtml(issue.key)}</span></td>
          <td><button class="issue-link" type="button" ${selected ? 'aria-current="true"' : ""}>${escapeHtml(fields.summary)}</button></td>
          <td>${statusChip(fields.status)}</td>
          <td class="column-assignee">
            <span class="person-cell">
              <span class="avatar" aria-hidden="true">${escapeHtml(initials(assignee?.displayName))}</span>
              <span class="person-name">${escapeHtml(assignee?.displayName || "Unassigned")}</span>
            </span>
          </td>
          <td class="column-priority">${priorityMarkup(fields.priority)}</td>
          <td class="column-updated updated-cell">${escapeHtml(formatDate(fields.updated))}</td>
        </tr>`;
    }).join("");

    elements.issuesBody.querySelectorAll(".issue-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        selectIssue(row.dataset.key);
      });
      row.querySelector(".issue-link").addEventListener("click", () => selectIssue(row.dataset.key));
    });
  }

  function renderPagination() {
    const first = state.total ? state.startAt + 1 : 0;
    const last = Math.min(state.startAt + state.maxResults, state.total);
    const currentPage = state.total ? Math.floor(state.startAt / state.maxResults) + 1 : 1;
    const totalPages = Math.max(1, Math.ceil(state.total / state.maxResults));
    elements.pageRange.textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${state.total.toLocaleString()}`;
    elements.pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
    elements.previousPage.disabled = state.startAt <= 0;
    elements.nextPage.disabled = state.startAt + state.maxResults >= state.total;
  }

  function selectIssue(key) {
    if (!key) return;
    state.selectedKey = key;
    state.selectedIssue = null;
    renderIssues();
    void loadIssueDetail(key, true);
  }

  function renderPanelLoading() {
    elements.issuePanelEmpty.hidden = true;
    elements.issuePanelContent.hidden = false;
    elements.issuePanelContent.innerHTML = `
      <div class="panel-loading" aria-label="Loading issue details">
        <div class="skeleton-cell"></div>
        <div class="skeleton-cell"></div>
        <div class="skeleton-cell"></div>
        <div class="skeleton-cell"></div>
        <div class="skeleton-cell"></div>
      </div>`;
  }

  async function loadIssueDetail(key, openOnMobile) {
    const sequence = ++state.issueSequence;
    renderPanelLoading();
    if (openOnMobile) elements.issuePanel.dataset.open = "true";
    try {
      const issue = await api(`/rest/api/2/issue/${encodeURIComponent(key)}`);
      if (sequence !== state.issueSequence || key !== state.selectedKey) return;
      state.selectedIssue = issue;
      renderIssuePanel(issue);
    } catch (error) {
      if (sequence !== state.issueSequence) return;
      elements.issuePanelContent.innerHTML = `
        <div class="error-state panel-error" role="alert">
          <svg aria-hidden="true"><use href="#icon-alert"></use></svg>
          <h2>Issue could not be loaded</h2>
          <p>${escapeHtml(error instanceof Error ? error.message : "The server returned an unexpected response.")}</p>
          <button class="button button-secondary" id="retry-issue" type="button">Try again</button>
        </div>`;
      $("#retry-issue", elements.issuePanelContent)?.addEventListener("click", () => void loadIssueDetail(key, true));
    }
  }

  function renderIssuePanel(issue) {
    const fields = issue.fields;
    const comments = fields.comment?.comments || [];
    const labels = fields.labels || [];
    elements.issuePanelEmpty.hidden = true;
    elements.issuePanelContent.hidden = false;
    elements.issuePanelContent.innerHTML = `
      <header class="panel-header">
        <div class="panel-header-row">
          <span class="panel-key">${escapeHtml(issue.key)}</span>
          <div class="panel-actions">
            <button class="icon-button" id="copy-issue-key" type="button" aria-label="Copy ${escapeHtml(issue.key)}">
              <svg aria-hidden="true"><use href="#icon-copy"></use></svg>
            </button>
            <button class="icon-button panel-close" id="close-issue-panel" type="button" aria-label="Close issue details">
              <svg aria-hidden="true"><use href="#icon-close"></use></svg>
            </button>
          </div>
        </div>
        <h2 id="issue-panel-title">${escapeHtml(fields.summary)}</h2>
      </header>
      <div class="panel-body">
        <section class="detail-section" aria-labelledby="details-heading">
          <h3 id="details-heading">Details</h3>
          <dl class="detail-grid">
            <div class="detail-item"><dt>Status</dt><dd>${statusChip(fields.status)}</dd></div>
            <div class="detail-item"><dt>Project</dt><dd><span class="issue-key">${escapeHtml(fields.project?.key)}</span> · ${escapeHtml(fields.project?.name)}</dd></div>
            <div class="detail-item"><dt>Issue type</dt><dd>${escapeHtml(fields.issuetype?.name || "—")}</dd></div>
            <div class="detail-item"><dt>Priority</dt><dd>${priorityMarkup(fields.priority)}</dd></div>
            <div class="detail-item"><dt>Assignee</dt><dd>${escapeHtml(fields.assignee?.displayName || "Unassigned")}</dd></div>
            <div class="detail-item"><dt>Reporter</dt><dd>${escapeHtml(fields.reporter?.displayName || "—")}</dd></div>
            <div class="detail-item"><dt>Created</dt><dd>${escapeHtml(formatDate(fields.created))}</dd></div>
            <div class="detail-item"><dt>Updated</dt><dd>${escapeHtml(formatDate(fields.updated))}</dd></div>
          </dl>
        </section>
        <section class="detail-section" aria-labelledby="description-heading">
          <h3 id="description-heading">Description</h3>
          <p class="description">${escapeHtml(fields.description || "No description provided.")}</p>
        </section>
        <section class="detail-section" aria-labelledby="labels-heading">
          <h3 id="labels-heading">Labels</h3>
          <div class="label-list">${labels.length ? labels.map((label) => `<span class="label-chip">${escapeHtml(label)}</span>`).join("") : '<span class="comment-empty">No labels</span>'}</div>
        </section>
        <section class="detail-section" aria-labelledby="comments-heading">
          <h3 id="comments-heading">Comments · ${comments.length}</h3>
          <div class="comment-list">
            ${comments.length ? comments.map((comment) => `
              <article class="comment">
                <div class="comment-meta">
                  <span class="avatar" aria-hidden="true">${escapeHtml(initials(comment.author?.displayName))}</span>
                  <strong>${escapeHtml(comment.author?.displayName || "Unknown user")}</strong>
                  <time datetime="${escapeHtml(comment.created)}">${escapeHtml(formatDate(comment.created))}</time>
                </div>
                <p class="comment-body">${escapeHtml(comment.body)}</p>
              </article>`).join("") : '<p class="comment-empty">No comments on this issue.</p>'}
          </div>
        </section>
        <details class="detail-section raw-details">
          <summary>Raw JSON</summary>
          <pre class="raw-json"><code></code></pre>
        </details>
      </div>`;

    $(".raw-json code", elements.issuePanelContent).textContent = JSON.stringify(issue, null, 2);
    $("#copy-issue-key", elements.issuePanelContent).addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(issue.key);
        showToast(`${issue.key} copied`);
      } catch {
        showToast("Issue key could not be copied", "error");
      }
    });
    $("#close-issue-panel", elements.issuePanelContent)?.addEventListener("click", closeMobilePanel);
  }

  function clearIssuePanel() {
    state.selectedKey = "";
    state.selectedIssue = null;
    elements.issuePanel.dataset.open = "false";
    elements.issuePanelContent.hidden = true;
    elements.issuePanelContent.replaceChildren();
    elements.issuePanelEmpty.hidden = false;
  }

  function closeMobilePanel() {
    elements.issuePanel.dataset.open = "false";
    const selectedLink = elements.issuesBody.querySelector('[aria-current="true"]');
    selectedLink?.focus();
  }

  function updateClearButton() {
    elements.clearFilters.hidden = !(state.project || state.status || state.assignee || state.search);
  }

  function clearAllFilters() {
    state.project = "";
    state.status = "";
    state.assignee = "";
    state.search = "";
    state.startAt = 0;
    elements.projectSelect.value = "";
    elements.statusSelect.value = "";
    elements.assigneeSelect.value = "";
    elements.searchInput.value = "";
    renderProjectNavigation();
    updateClearButton();
    void loadIssues();
  }

  let searchTimer;
  elements.searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.search = elements.searchInput.value.trim();
      state.startAt = 0;
      updateClearButton();
      void loadIssues();
    }, 280);
  });

  elements.filterForm.addEventListener("submit", (event) => event.preventDefault());
  elements.projectSelect.addEventListener("change", () => {
    state.project = elements.projectSelect.value;
    state.startAt = 0;
    renderProjectNavigation();
    updateClearButton();
    void loadIssues();
  });
  elements.statusSelect.addEventListener("change", () => {
    state.status = elements.statusSelect.value;
    state.startAt = 0;
    updateClearButton();
    void loadIssues();
  });
  elements.assigneeSelect.addEventListener("change", () => {
    state.assignee = elements.assigneeSelect.value;
    state.startAt = 0;
    updateClearButton();
    void loadIssues();
  });

  elements.clearFilters.addEventListener("click", clearAllFilters);
  $("#empty-clear").addEventListener("click", clearAllFilters);
  $("#retry-load").addEventListener("click", () => void loadIssues());
  $("#refresh-issues").addEventListener("click", () => void loadIssues());
  $("#refresh-projects").addEventListener("click", async () => {
    try {
      await loadMetadata();
      await loadIssues();
      showToast("Projects refreshed");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Projects could not be refreshed", "error");
    }
  });

  elements.previousPage.addEventListener("click", () => {
    state.startAt = Math.max(0, state.startAt - state.maxResults);
    void loadIssues();
  });
  elements.nextPage.addEventListener("click", () => {
    state.startAt += state.maxResults;
    void loadIssues();
  });

  elements.tokenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.token = elements.tokenInput.value.trim();
    saveSessionToken(state.token);
    elements.authBanner.hidden = true;
    try {
      await loadMetadata();
      await loadIssues();
      showToast("Bearer token applied");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The token could not be applied", "error");
    }
  });

  $("#open-reset").addEventListener("click", () => elements.resetDialog.showModal());
  elements.confirmReset.addEventListener("click", async (event) => {
    event.preventDefault();
    elements.confirmReset.disabled = true;
    elements.confirmReset.textContent = "Resetting…";
    try {
      await api("/__admin/reset", { method: "POST" });
      clearIssuePanel();
      state.startAt = 0;
      await loadMetadata();
      await loadIssues();
      elements.resetDialog.close("confirm");
      showToast("Seed data restored");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Seed data could not be restored", "error");
    } finally {
      elements.confirmReset.disabled = false;
      elements.confirmReset.textContent = "Reset now";
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "/" && !typing) {
      event.preventDefault();
      elements.searchInput.focus();
    }
    if (event.key === "Escape" && elements.issuePanel.dataset.open === "true" && !elements.resetDialog.open) {
      closeMobilePanel();
    }
  });

  async function initialize() {
    void loadHealth();
    try {
      await loadMetadata();
      await loadIssues();
    } catch (error) {
      elements.projectList.innerHTML = '<p class="comment-empty">Projects unavailable</p>';
      elements.issuesBody.replaceChildren();
      elements.errorMessage.textContent = error instanceof Error ? error.message : "The dashboard could not be loaded.";
      elements.errorState.hidden = false;
      elements.tableRegion.setAttribute("aria-busy", "false");
      elements.resultSummary.textContent = "Issues unavailable";
    }
  }

  void initialize();
})();
