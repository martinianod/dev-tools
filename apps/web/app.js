const DEFAULT_API_BASE = (() => {
  if (window.location.protocol.startsWith("http") && window.location.port && window.location.port !== "18000") {
    return window.location.origin;
  }
  if (window.location.protocol.startsWith("http") && window.location.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:18080`;
  }
  return "http://localhost:18080";
})();
const API_BASE = window.localStorage.getItem("qualityHubApiBase") || window.QUALITY_HUB_API_BASE || DEFAULT_API_BASE;
const AUTH_TOKEN_KEY = "qualityHubSessionToken";

const state = {
  projects: [],
  selectedProject: null,
  selectedTab: "overview",
  detailOpen: false,
  activeJobSource: null,
  runtimeLogTimer: null,
  runtimeLogText: "",
  bulkOperation: null,
  bulkTimer: null,
  platformStatus: null,
  localAgent: null,
  observabilityByProject: {},
  qualitySecurityByProject: {},
  infrastructureByProject: {},
  versionsByProject: {},
  testingByProject: {},
  deploymentsByProject: {},
  livingDocsByProject: {},
  improvements: null,
  improvementError: "",
  improvementScope: "all",
  improvementProjectId: "",
  improvementSeverity: "all",
  improvementCategory: "all",
  filter: "all",
  query: "",
  commandQuery: "",
  expandedProjectId: null
};

const els = {
  projectList: document.querySelector("#projectList"),
  nextActionsList: document.querySelector("#nextActionsList"),
  localAgentPanel: document.querySelector("#localAgentPanel"),
  projectDetail: document.querySelector("#project-detail"),
  dashboardTitle: document.querySelector("#dashboardTitle"),
  dashboardStack: document.querySelector("#dashboardStack"),
  dashboardMeta: document.querySelector("#dashboardMeta"),
  tabContent: document.querySelector("#tabContent"),
  projectsRootLabel: document.querySelector("#projectsRootLabel"),
  projectDialog: document.querySelector("#projectDialog"),
  projectForm: document.querySelector("#projectForm"),
  setupChecklist: document.querySelector("#setupChecklist"),
  discoverPreview: document.querySelector("#discoverPreview"),
  commandDialog: document.querySelector("#commandDialog"),
  commandSearch: document.querySelector("#commandSearch"),
  commandList: document.querySelector("#commandList"),
  globalSearch: document.querySelector("#globalSearch"),
  toast: document.querySelector("#toast"),
  jobDrawer: document.querySelector("#jobDrawer"),
  jobTitle: document.querySelector("#jobTitle"),
  jobStages: document.querySelector("#jobStages"),
  jobSummary: document.querySelector("#jobSummary"),
  jobLogs: document.querySelector("#jobLogs"),
  closeProjectDetail: document.querySelector("#closeProjectDetail"),
  platformSidebarState: document.querySelector("#platformSidebarState"),
  platformSidebarMeta: document.querySelector("#platformSidebarMeta"),
  summaryProjects: document.querySelector("#summaryProjects"),
  summaryHealthy: document.querySelector("#summaryHealthy"),
  summaryWarnings: document.querySelector("#summaryWarnings"),
  summaryCritical: document.querySelector("#summaryCritical"),
  summaryPending: document.querySelector("#summaryPending"),
  summaryServices: document.querySelector("#summaryServices"),
  startAllRuntimeButton: document.querySelector("#startAllRuntimeButton"),
  rebuildAllRuntimeButton: document.querySelector("#rebuildAllRuntimeButton"),
  stopAllRuntimeButton: document.querySelector("#stopAllRuntimeButton"),
  improvementScope: document.querySelector("#improvementScope"),
  improvementProjectSelector: document.querySelector("#improvementProjectSelector"),
  improvementSeverityFilter: document.querySelector("#improvementSeverityFilter"),
  improvementCategoryFilter: document.querySelector("#improvementCategoryFilter"),
  regenerateImprovementPrompt: document.querySelector("#regenerateImprovementPrompt"),
  copyImprovementPrompt: document.querySelector("#copyImprovementPrompt"),
  downloadImprovementPrompt: document.querySelector("#downloadImprovementPrompt"),
  improvementCritical: document.querySelector("#improvementCritical"),
  improvementWarning: document.querySelector("#improvementWarning"),
  improvementInfo: document.querySelector("#improvementInfo"),
  improvementCategories: document.querySelector("#improvementCategories"),
  improvementGeneratedAt: document.querySelector("#improvementGeneratedAt"),
  improvementList: document.querySelector("#improvementList"),
  improvementPrompt: document.querySelector("#improvementPrompt"),
  securitySessionStatus: document.querySelector("#securitySessionStatus"),
  securityTokenForm: document.querySelector("#securityTokenForm"),
  securityTokenInput: document.querySelector("#securityTokenInput"),
  clearSecurityToken: document.querySelector("#clearSecurityToken")
};

document.querySelector("#refreshButton").addEventListener("click", loadAll);
document.querySelector("#openRegisterButton").addEventListener("click", openProjectDialog);
els.startAllRuntimeButton?.addEventListener("click", () => runBulkRuntimeAction("start"));
els.rebuildAllRuntimeButton?.addEventListener("click", () => runBulkRuntimeAction("rebuild-changed"));
els.stopAllRuntimeButton?.addEventListener("click", () => runBulkRuntimeAction("stop"));
els.improvementScope?.addEventListener("change", () => {
  state.improvementScope = els.improvementScope.value === "project" ? "project" : "all";
  if (state.improvementScope === "project" && !state.improvementProjectId) {
    state.improvementProjectId = state.selectedProject?.id || state.projects[0]?.id || "";
  }
  loadImprovements();
});
els.improvementProjectSelector?.addEventListener("change", () => {
  state.improvementProjectId = els.improvementProjectSelector.value;
  state.improvementScope = state.improvementProjectId ? "project" : "all";
  if (els.improvementScope) els.improvementScope.value = state.improvementScope;
  loadImprovements();
});
els.improvementSeverityFilter?.addEventListener("change", () => {
  state.improvementSeverity = els.improvementSeverityFilter.value || "all";
  renderImprovements();
});
els.improvementCategoryFilter?.addEventListener("change", () => {
  state.improvementCategory = els.improvementCategoryFilter.value || "all";
  renderImprovements();
});
els.regenerateImprovementPrompt?.addEventListener("click", () => loadImprovements());
els.copyImprovementPrompt?.addEventListener("click", copyImprovementPrompt);
els.downloadImprovementPrompt?.addEventListener("click", downloadImprovementPrompt);
document.querySelector("#closeJobDrawer").addEventListener("click", closeJobDrawer);
els.closeProjectDetail?.addEventListener("click", closeProjectDetail);
document.querySelector("#discoverButton").addEventListener("click", discoverProject);
document.querySelector("#commandMenuButton").addEventListener("click", openCommandDialog);
document.querySelector("#closeCommandDialog").addEventListener("click", closeCommandDialog);
els.projectForm.addEventListener("submit", saveProject);
els.securityTokenForm?.addEventListener("submit", saveSecurityToken);
els.clearSecurityToken?.addEventListener("click", clearSecurityToken);
els.globalSearch.addEventListener("input", () => {
  state.query = els.globalSearch.value.trim().toLowerCase();
  renderWorkspace();
});
els.commandSearch.addEventListener("input", () => {
  state.commandQuery = els.commandSearch.value.trim().toLowerCase();
  renderCommandPalette();
});

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => startExecution(button.dataset.action));
}

for (const button of document.querySelectorAll(".dashboard-header [data-runtime-action]")) {
  button.addEventListener("click", () => runRuntimeAction(button.dataset.runtimeAction));
}

for (const tab of document.querySelectorAll("[role='tab'][data-tab]")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

for (const button of document.querySelectorAll("[data-filter]")) {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    for (const item of document.querySelectorAll("[data-filter]")) {
      item.classList.toggle("active", item === button);
    }
    renderWorkspace();
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandDialog();
  }
  if (event.key === "Escape" && els.commandDialog.open) {
    closeCommandDialog();
  }
  if (event.key === "Escape") {
    closeProjectMenus();
  }
  if (event.key === "Escape" && state.detailOpen && !els.commandDialog.open && els.jobDrawer.hidden) {
    closeProjectDetail();
  }
});

renderSetupChecklist();
loadAll();
setInterval(() => loadProjects().catch(() => {}), 8000);

async function api(path, options = {}) {
  const token = window.sessionStorage.getItem(AUTH_TOKEN_KEY) || "";
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const suffix = response.status === 401 ? " Configura el token local en Configuracion." : "";
    throw new Error(`${data?.detail || data?.title || `HTTP ${response.status}`}${suffix}`);
  }
  return data;
}

async function loadAll() {
  try {
    await Promise.all([loadPlatformStatus(), loadSecuritySession(), loadLocalAgent(), loadProjects()]);
    await loadImprovements({ silent: true });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadSecuritySession() {
  if (!els.securitySessionStatus) return;
  try {
    const session = await api("/api/v1/security/session");
    els.securitySessionStatus.textContent = session.authenticated
      ? `${session.actor} · ${session.role} · ejecucion ${session.privilegedExecution.toLowerCase()}`
      : "Modo lectura: las mutaciones requieren token";
  } catch (error) {
    els.securitySessionStatus.textContent = error.message;
  }
}

async function saveSecurityToken(event) {
  event.preventDefault();
  const token = String(els.securityTokenInput?.value || "").trim();
  if (!token) {
    toast("Ingresá el token local configurado en el backend", "error");
    return;
  }
  window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  if (els.securityTokenInput) els.securityTokenInput.value = "";
  await loadSecuritySession();
  toast("Credencial cargada para esta sesion");
}

async function clearSecurityToken() {
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  if (els.securityTokenInput) els.securityTokenInput.value = "";
  await loadSecuritySession();
  toast("Credencial eliminada de la sesion");
}

async function loadPlatformStatus() {
  const status = await api("/api/v1/platform/status");
  state.platformStatus = status;
  els.projectsRootLabel.textContent = status.projectsRoot || "/workspace/projects";
  const required = status.services.filter((service) => service.required !== false);
  const requiredUp = required.filter((service) => service.status === "UP").length;
  const optionalDown = status.services.filter((service) => service.required === false && service.status !== "UP");
  els.summaryServices.textContent = `${requiredUp}/${required.length}`;
  els.platformSidebarState.textContent = requiredUp === required.length ? "Core operativo" : `${requiredUp}/${required.length} core UP`;
  const requiredDown = required.filter((service) => service.status !== "UP");
  els.platformSidebarMeta.textContent = requiredDown.length
    ? requiredDown.map((service) => service.name).join(", ")
    : optionalDown.length
      ? `Modo liviano: ${optionalDown.length} servicios opcionales apagados.`
      : "Servicios principales y opcionales disponibles.";
}

async function loadProjects() {
  const data = await api("/api/v1/projects");
  state.projects = data.items || [];
  if (!state.selectedProject && state.projects.length) {
    state.selectedProject = state.projects[0];
  } else if (state.selectedProject) {
    state.selectedProject = state.projects.find((project) => project.id === state.selectedProject.id) || state.projects[0] || null;
  }
  renderWorkspace();
  renderDashboard();
  renderCommandPalette();
  renderImprovementProjectOptions();
}

async function loadLocalAgent(options = {}) {
  try {
    const data = await api("/api/v1/agents/overview");
    state.localAgent = { data, loadedAt: Date.now() };
  } catch (error) {
    state.localAgent = { error: error.message, loadedAt: Date.now() };
  }
  if (!options.silent) renderWorkspace();
}

async function loadImprovements(options = {}) {
  if (!els.improvementList || !els.improvementPrompt) return;
  const projectId = state.improvementScope === "project"
    ? state.improvementProjectId || state.selectedProject?.id || state.projects[0]?.id || ""
    : "";
  if (state.improvementScope === "project" && !projectId) {
    state.improvements = null;
    renderImprovements();
    return;
  }
  const params = new URLSearchParams({ scope: state.improvementScope });
  if (projectId) params.set("projectId", projectId);
  if (!options.silent) {
    els.improvementList.innerHTML = `<article class="empty-state"><strong>Generando reporte...</strong><p class="muted">Leyendo estado del hub y proyectos.</p></article>`;
  }
  try {
    state.improvementError = "";
    state.improvements = await api(`/api/v1/improvements?${params.toString()}`);
    renderImprovements();
  } catch (error) {
    state.improvements = null;
    state.improvementError = error.message;
    renderImprovements();
    toast(error.message, "error");
  }
}

function renderImprovementProjectOptions() {
  if (!els.improvementProjectSelector) return;
  const current = state.improvementScope === "project"
    ? state.improvementProjectId || state.selectedProject?.id || state.projects[0]?.id || ""
    : "";
  if (state.improvementScope === "project" && !state.improvementProjectId && current) state.improvementProjectId = current;
  els.improvementProjectSelector.innerHTML = [
    `<option value="">Todos los proyectos</option>`,
    ...state.projects.map((project) => `<option value="${escapeHtml(project.id)}"${project.id === current ? " selected" : ""}>${escapeHtml(project.displayName)}</option>`)
  ].join("");
}

function renderImprovements() {
  const report = state.improvements;
  if (!els.improvementList || !els.improvementPrompt) return;
  if (els.improvementScope) els.improvementScope.value = state.improvementScope;
  renderImprovementProjectOptions();
  if (!report) {
    els.improvementCritical.textContent = "0";
    els.improvementWarning.textContent = "0";
    els.improvementInfo.textContent = "0";
    els.improvementCategories.textContent = "0";
    els.improvementGeneratedAt.textContent = "Sin reporte";
    els.improvementList.innerHTML = state.improvementError ? `
      <article class="empty-state danger-soft">
        <strong>No se pudo generar el reporte.</strong>
        <p class="muted">${escapeHtml(state.improvementError)}</p>
        <p class="muted">Si el error es 404, reiniciar o reconstruir control-api para que cargue la version que incluye /api/v1/improvements.</p>
      </article>
    ` : `<article class="empty-state"><strong>Sin reporte generado.</strong><p class="muted">Usa Regenerar para crear el diagnostico y el prompt maestro.</p></article>`;
    els.improvementPrompt.value = "";
    return;
  }
  const items = report.items || [];
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].sort();
  renderImprovementCategoryOptions(categories);
  els.improvementCritical.textContent = String(report.counts?.critical || 0);
  els.improvementWarning.textContent = String(report.counts?.warning || 0);
  els.improvementInfo.textContent = String(report.counts?.info || 0);
  els.improvementCategories.textContent = String(categories.length);
  els.improvementGeneratedAt.textContent = formatDate(report.generatedAt);
  els.improvementPrompt.value = report.promptMarkdown || "";

  const filtered = filteredImprovementItems(items);
  els.improvementList.innerHTML = filtered.length ? groupedImprovementList(filtered) : `
    <article class="empty-state">
      <strong>No hay hallazgos para estos filtros.</strong>
      <p class="muted">Cambia severidad o categoria para ampliar el resultado.</p>
    </article>
  `;
  for (const button of els.improvementList.querySelectorAll("[data-improvement-project]")) {
    button.addEventListener("click", () => {
      const projectId = button.dataset.improvementProject;
      const tab = button.dataset.improvementTab || "overview";
      if (projectId) openProjectTab(projectId, tab);
    });
  }
}

function renderImprovementCategoryOptions(categories) {
  if (!els.improvementCategoryFilter) return;
  const current = categories.includes(state.improvementCategory) ? state.improvementCategory : "all";
  if (current !== state.improvementCategory) state.improvementCategory = current;
  els.improvementCategoryFilter.innerHTML = [
    `<option value="all">Todas</option>`,
    ...categories.map((category) => `<option value="${escapeHtml(category)}"${category === current ? " selected" : ""}>${escapeHtml(titleFromSlug(category))}</option>`)
  ].join("");
}

function filteredImprovementItems(items) {
  return items.filter((item) => {
    if (state.improvementSeverity !== "all" && item.severity !== state.improvementSeverity) return false;
    if (state.improvementCategory !== "all" && item.category !== state.improvementCategory) return false;
    return true;
  });
}

function groupedImprovementList(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.projectSlug || "platform";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([group, groupItems]) => `
    <section class="improvement-group">
      <div class="improvement-group-header">
        <strong>${escapeHtml(group === "platform" ? "Plataforma" : group)}</strong>
        <span class="status ${statusClass(groupItems[0]?.severity)}">${escapeHtml(groupItems.length)} hallazgos</span>
      </div>
      ${groupItems.map(improvementFindingCard).join("")}
    </section>
  `).join("");
}

function improvementFindingCard(item) {
  const tab = item.targetTab || categoryDefaultTab(item.category);
  const projectAction = item.projectId
    ? `<button class="button secondary compact-button" type="button" data-improvement-project="${escapeHtml(item.projectId)}" data-improvement-tab="${escapeHtml(tab)}">${escapeHtml(tabActionLabel(tab))}</button>`
    : "";
  return `
    <article class="improvement-card ${escapeHtml(item.severity)}">
      <div class="improvement-card-header">
        <span class="status ${statusClass(item.severity)}">${escapeHtml(item.severity)}</span>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <p class="muted">${escapeHtml(`${titleFromSlug(item.category)} · ${item.source || "hub"}`)}</p>
        </div>
      </div>
      <p>${escapeHtml(item.detail || "Sin detalle.")}</p>
      ${item.evidence ? `<code>${escapeHtml(item.evidence)}</code>` : ""}
      <div class="improvement-action-row">
        <span>${escapeHtml(item.suggestedAction || "Analizar y corregir causa raiz.")}</span>
        <div class="toolbar">
          ${projectAction}
          ${(item.links || []).slice(0, 2).map((link) => `<a class="button ghost compact-button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function categoryDefaultTab(category) {
  if (category === "runtime") return "terminal";
  if (category === "quality" || category === "observability") return "quality";
  if (category === "ci" || category === "configuration" || category === "source-control") return "configuration";
  return "overview";
}

function tabActionLabel(tab) {
  if (tab === "terminal") return "Ver logs";
  if (tab === "configuration") return "Configurar";
  if (tab === "quality") return "Ver calidad";
  if (tab === "environment") return "Ver entorno";
  if (tab === "executions") return "Ver ejecuciones";
  return "Abrir proyecto";
}

function renderWorkspace() {
  const models = state.projects.map(projectModel);
  const counts = summaryCounts(models);
  els.summaryProjects.textContent = String(models.length);
  els.summaryHealthy.textContent = String(counts.healthy);
  els.summaryWarnings.textContent = String(counts.warning);
  els.summaryCritical.textContent = String(counts.critical);
  els.summaryPending.textContent = String(counts.pending);

  const visible = models.filter(matchesCurrentFilters);
  if (state.expandedProjectId && !visible.some((model) => model.project.id === state.expandedProjectId)) {
    state.expandedProjectId = null;
  }
  renderLocalAgentPanel();
  renderProjects(visible);
  renderNextActions(models);
}

function renderLocalAgentPanel() {
  if (!els.localAgentPanel) return;
  const record = state.localAgent;
  if (!record) {
    els.localAgentPanel.innerHTML = `
      <article class="empty-state compact">
        <strong>Cargando agente local...</strong>
        <p class="muted">Verificando identidad, heartbeat y discovery local.</p>
      </article>
    `;
    return;
  }
  if (record.error) {
    els.localAgentPanel.innerHTML = `
      <article class="empty-state compact danger-soft">
        <strong>No se pudo consultar el agente local.</strong>
        <p class="muted">${escapeHtml(record.error)}</p>
      </article>
    `;
    return;
  }
  const report = record.data || {};
  const agent = report.agents?.[0] || {};
  const discovery = agent.latestDiscovery || report.latestDiscovery || null;
  els.localAgentPanel.innerHTML = `
    <section class="focus-panel ${agent.status === "CONNECTED" ? "" : "danger-soft"}">
      <div>
        <span class="label">Fase 9 · Agente local</span>
        <h3>${escapeHtml(`${agent.status || "UNKNOWN"} · ${agent.version || "sin version"}`)}</h3>
        <p>${escapeHtml(`${report.counts?.projectsDetected || agent.projectsDetected || 0} proyectos detectados · ${report.counts?.discoveryErrors || agent.discoveryErrors || 0} errores · heartbeat ${agent.heartbeatAgeSeconds ?? 0}s`)}</p>
      </div>
      <div class="toolbar">
        ${statusBadge(statusMeta(agent.status || "UNKNOWN", agent.status || "UNKNOWN", agent.security?.permissions || "", agent.status === "CONNECTED" ? "ok" : "error", 1))}
        <button class="button secondary compact-button" type="button" data-agent-action="heartbeat">Heartbeat</button>
        <button class="button primary compact-button" type="button" data-agent-action="refresh">Refrescar discovery</button>
      </div>
    </section>
    <div class="integration-grid">
      <article class="integration-card">
        <span class="label">Identidad</span>
        <strong>${escapeHtml(agent.name || "Local Agent")}</strong>
        <p class="muted">${escapeHtml(`device=${agent.deviceId || "sin device"} · type=${agent.type || "embedded"}`)}</p>
        <code>${escapeHtml(agent.hostRoot || "")}</code>
      </article>
      <article class="integration-card">
        <span class="label">Seguridad</span>
        <strong>${escapeHtml(agent.security?.secretValues || "never_read_or_returned")}</strong>
        <p class="muted">${escapeHtml(`Permisos: ${agent.security?.permissions || "minimum-local-workspace-read"}`)}</p>
        <code>${escapeHtml(`commands=${agent.security?.arbitraryCommands || "blocked"}`)}</code>
      </article>
      <article class="integration-card">
        <span class="label">Discovery</span>
        <strong>${escapeHtml(discovery?.status || "Sin snapshot")}</strong>
        <p class="muted">${escapeHtml(discovery ? `${discovery.projectCount || 0} proyectos · ${discovery.errorCount || 0} errores · ${formatDate(discovery.generatedAt)}` : "Ejecuta refresh para generar snapshot.")}</p>
        <code>${escapeHtml(discovery?.sourceHashShort ? `hash=${discovery.sourceHashShort}` : "sin hash")}</code>
      </article>
      <article class="integration-card">
        <span class="label">Capacidades</span>
        <strong>${escapeHtml(`${(agent.capabilities || []).length} declaradas`)}</strong>
        <p class="muted">${escapeHtml((agent.capabilities || []).slice(0, 5).join(", ") || "sin capacidades")}</p>
      </article>
    </div>
  `;
  for (const button of els.localAgentPanel.querySelectorAll("[data-agent-action]")) {
    button.addEventListener("click", () => runAgentAction(button.dataset.agentAction));
  }
}

function renderProjects(models) {
  if (!models.length) {
    els.projectList.innerHTML = `
      <article class="empty-state">
        <strong>No hay proyectos para este filtro.</strong>
        <p class="muted">Ajusta la busqueda o registra un proyecto nuevo.</p>
      </article>
    `;
    return;
  }

  els.projectList.innerHTML = models.map(renderProjectAccordion).join("");

  for (const button of els.projectList.querySelectorAll("[data-open-project]")) {
    button.addEventListener("click", () => openProject(button.dataset.openProject));
  }
  for (const button of els.projectList.querySelectorAll("[data-toggle-project]")) {
    button.addEventListener("click", () => toggleProjectAccordion(button.dataset.toggleProject));
  }
  for (const button of els.projectList.querySelectorAll("[data-open-project-tab]")) {
    button.addEventListener("click", () => openProjectTab(button.dataset.openProjectTab, button.dataset.tabName || "overview"));
  }
  for (const button of els.projectList.querySelectorAll("[data-project-menu-action]")) {
    button.addEventListener("click", () => runProjectMenuAction(button.dataset.projectId, button.dataset.projectMenuAction));
  }
  for (const button of els.projectList.querySelectorAll("[data-copy-fingerprint]")) {
    button.addEventListener("click", () => copyFingerprint(button.dataset.copyFingerprint));
  }
}

function renderProjectAccordion(model) {
  const project = model.project;
  const stack = project.detectedStack || [];
  const runtime = project.localRuntime || {};
  const expanded = state.expandedProjectId === project.id;
  const bodyId = `project-accordion-${project.id}`;
  const stackOverflow = Math.max(0, stack.length - 3);
  return `
    <article class="project-card project-accordion ${model.selected ? "selected" : ""} ${expanded ? "expanded" : ""}">
      <div class="project-accordion-header">
        <span class="health-dot ${statusClass(model.status.tone || model.status.label)}" title="${escapeHtml(model.status.label)}" aria-label="${escapeHtml(model.status.label)}"></span>
        <button class="project-summary-button" type="button" data-toggle-project="${project.id}" aria-expanded="${expanded}" aria-controls="${bodyId}">
          <span class="project-summary-main">
            <strong>${escapeHtml(project.displayName)}</strong>
            ${runtimeStatusBadge(runtime)}
          </span>
          <span class="project-summary-meta">${escapeHtml(runtime.explanation || model.status.explanation)}</span>
        </button>
        <div class="stack-list compact" aria-label="Stack tecnologico">
          ${stack.slice(0, 3).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("") || `<span class="chip">stack pendiente</span>`}
          ${stackOverflow ? `<span class="chip muted-chip">+${stackOverflow}</span>` : ""}
        </div>
        ${projectMenu(project)}
        <button class="icon-button expand-button" type="button" data-toggle-project="${project.id}" aria-expanded="${expanded}" aria-controls="${bodyId}" aria-label="${expanded ? "Colapsar" : "Expandir"} ${escapeHtml(project.displayName)}">
          ${expanded ? "^" : "v"}
        </button>
      </div>
      <div class="project-accordion-body" id="${bodyId}" ${expanded ? "" : "hidden"}>
        ${expanded ? projectAccordionBody(model) : ""}
      </div>
    </article>
  `;
}

function projectAccordionBody(model) {
  const project = model.project;
  const runtime = project.localRuntime || {};
  const git = runtime.git || project.git || {};
  const hints = projectSetupHints(project);
  const primaryHint = hints.find((hint) => hint.level === "warn") || hints[0] || null;
  const currentFingerprint = fingerprintShort(runtime.freshness?.current || runtime.sourceFingerprint?.value || runtime.sourceFingerprint?.short);
  const lastDeploymentFingerprint = fingerprintShort(runtime.freshness?.expected || runtime.lastDeployment?.expectedFingerprint || runtime.lastDeployment?.sourceFingerprint);
  return `
    <div class="accordion-grid">
      <section class="accordion-column">
        <span class="label">Codigo y repositorio</span>
        ${catalogDatum("ID / Directorio", project.repositoryPath)}
        ${catalogDatum("Git", gitLine(git))}
        ${catalogDatum("Cambios locales", git?.isGit ? localChangeSummary(git) : "No aplica")}
        <div class="catalog-link-row">
          ${catalogToolLink(project, "github", "Repositorio")}
          ${catalogToolLink(project, "github", "Branches")}
          ${catalogToolLink(project, "github", "Pull requests")}
        </div>
      </section>
      <section class="accordion-column">
        <span class="label">Calidad y CI/CD</span>
        ${catalogDatum("Ultimo analisis Sonar", model.lastAnalysis)}
        ${catalogDatum("Metricas", qualitySignalSummary(project, model))}
        ${primaryHint ? `
          <article class="catalog-warning ${escapeHtml(primaryHint.level || "info")}">
            <strong>${escapeHtml(primaryHint.title)}</strong>
            <p>${escapeHtml(primaryHint.detail)}</p>
          </article>
        ` : `<p class="muted">Sin brechas accionables abiertas.</p>`}
        <div class="catalog-link-row">
          ${catalogToolLink(project, "sonarqube", "SonarQube overview", "Sonar")}
          ${catalogToolLink(project, "jenkins", "Jenkins")}
        </div>
      </section>
      <section class="accordion-column">
        <span class="label">Infraestructura y control</span>
        <div class="fingerprint-row">
          ${catalogDatum("Fingerprint", currentFingerprint || "Sin datos")}
          <button class="button ghost compact-button" type="button" data-copy-fingerprint="${escapeHtml(currentFingerprint)}" ${currentFingerprint ? "" : "disabled"}>Copiar</button>
        </div>
        ${catalogDatum("Ultimo deploy", lastDeploymentFingerprint || "Sin deploy registrado")}
        ${catalogDatum("Contenedores", runtimeResourceSummary(runtime))}
        <div class="catalog-actions">
          <button class="button primary" type="button" data-open-project="${project.id}">Abrir proyecto</button>
          <button class="button secondary" type="button" data-open-project-tab="${project.id}" data-tab-name="configuration">Configurar variables</button>
          <button class="button secondary" type="button" data-open-project-tab="${project.id}" data-tab-name="quality">Ver brechas</button>
        </div>
      </section>
    </div>
  `;
}

function projectMenu(project) {
  return `
    <details class="project-menu">
      <summary class="icon-button" aria-label="Acciones rapidas de ${escapeHtml(project.displayName)}">⋮</summary>
      <div class="project-menu-panel" role="menu">
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="start">Start</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="restart">Restart</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="rebuild-changed">Rebuild changed components</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="clean-rebuild">Clean rebuild</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="pull-rebuild">Pull and rebuild</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="stop">Stop</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="view-changes">View detected changes</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="terminal">Ver logs</button>
        <button type="button" role="menuitem" data-project-id="${project.id}" data-project-menu-action="configuration">Configurar</button>
      </div>
    </details>
  `;
}

function catalogDatum(label, value) {
  return `
    <div class="catalog-datum">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Sin datos")}</strong>
    </div>
  `;
}

function catalogToolLink(project, provider, label, displayLabel = label) {
  const link = (project.toolLinks || []).find((item) => item.provider === provider && item.label === label);
  if (!link?.url) return "";
  const status = toolLinkStatus(link);
  return `
    <a class="catalog-tool-link ${status.tone}" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(link.hint || status.label)}">
      <span>${escapeHtml(displayLabel)}</span>
      <small>${escapeHtml(status.label)}</small>
    </a>
  `;
}

function qualitySignalSummary(project, model) {
  const healthSignals = project.instrumentation?.health?.length || 0;
  const metricsSignals = project.instrumentation?.metrics?.length || 0;
  const present = healthSignals + metricsSignals;
  const pending = [
    model.qualityGate === "Sin datos",
    model.coverage === "Sin datos",
    !healthSignals,
    !metricsSignals
  ].filter(Boolean).length;
  return `${present} senales / ${pending} pendientes`;
}

function runtimeResourceSummary(runtime = {}) {
  const resources = runtime.resources || [];
  const running = resources.filter((resource) => resource.state === "running").length;
  const ports = runtime.ports || [];
  if (!resources.length) return "No hay contenedores activos.";
  return `${running}/${resources.length} corriendo · ${ports.length} puertos`;
}

function toggleProjectAccordion(projectId) {
  state.expandedProjectId = state.expandedProjectId === projectId ? null : projectId;
  renderWorkspace();
}

function openProjectTab(projectId, tabName) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.selectedProject = project;
  state.selectedTab = tabName;
  state.detailOpen = true;
  renderWorkspace();
  renderDashboard();
  els.projectDetail.focus?.();
}

function closeProjectMenus() {
  for (const menu of els.projectList?.querySelectorAll(".project-menu[open]") || []) {
    menu.removeAttribute("open");
  }
}

function renderNextActions(models) {
  const bulk = state.bulkOperation;
  const bulkItem = bulk && ["RUNNING", "FAILED", "SUCCEEDED"].includes(bulk.status) ? `
    <article class="action-item">
      <div>
        ${statusBadge(statusMeta("bulk-runtime", bulk.status === "RUNNING" ? "Bulk en curso" : `Bulk ${bulk.status}`, bulk.currentProjectSlug || "", bulk.status === "FAILED" ? "error" : bulk.status === "RUNNING" ? "info" : "ok", bulk.status === "FAILED" ? 5 : 2))}
        <strong>${escapeHtml(runtimeActionDisplayLabel(bulk.action))}</strong>
        <p class="muted">${escapeHtml(bulkRuntimeSummary(bulk))}</p>
      </div>
      <button class="button secondary" type="button" data-bulk-refresh="${escapeHtml(bulk.id)}">Actualizar progreso</button>
    </article>
  ` : "";

  const ordered = [...models]
    .map((model) => ({ model, action: actionCenterItem(model) }))
    .filter((item) => item.action)
    .sort((a, b) => b.model.status.rank - a.model.status.rank || a.model.project.displayName.localeCompare(b.model.project.displayName))
    .slice(0, 6);

  if (!ordered.length && !bulkItem) {
    els.nextActionsList.innerHTML = `
      <article class="empty-state compact">
        <strong>Sin prioridades abiertas</strong>
        <p class="muted">Los proyectos visibles no reportan riesgos bloqueantes.</p>
      </article>
    `;
    return;
  }

  els.nextActionsList.innerHTML = `${bulkItem}${ordered.map(({ model, action }) => `
    <article class="action-item">
      <div>
        ${statusBadge(action.status || model.status)}
        <strong>${escapeHtml(model.project.displayName)}</strong>
        <p class="muted">${escapeHtml(action.reason)}</p>
      </div>
      <button class="button secondary" type="button" data-project-intent="${model.project.id}" data-intent-kind="${model.intent.kind}" data-intent-value="${model.intent.value}">
        ${escapeHtml(action.button || model.intent.button)}
      </button>
    </article>
  `).join("")}`;

  for (const button of els.nextActionsList.querySelectorAll("[data-project-intent]")) {
    button.addEventListener("click", () => runProjectIntent(button.dataset.projectIntent, button.dataset.intentKind, button.dataset.intentValue));
  }
  for (const button of els.nextActionsList.querySelectorAll("[data-bulk-refresh]")) {
    button.addEventListener("click", () => refreshBulkRuntimeOperation(button.dataset.bulkRefresh));
  }
}

function renderDashboard() {
  const project = state.selectedProject;
  if (!project || !state.detailOpen) {
    els.projectDetail.hidden = true;
    stopRuntimeLogPolling();
    return;
  }

  const model = projectModel(project);
  els.projectDetail.hidden = false;
  els.dashboardTitle.textContent = project.displayName;
  els.dashboardStack.textContent = (project.detectedStack || []).join(" / ") || "Stack no detectado";
  els.dashboardMeta.textContent = `${project.repositoryPath} · ${project.defaultBranch || "main"} · ${model.status.label}`;

  const renderers = {
    overview: renderOverview,
    environment: renderEnvironment,
    quality: renderQualityAndObservability,
    terminal: renderTerminal,
    executions: renderExecutions,
    docs: renderLivingDocs,
    configuration: renderConfiguration
  };
  const renderer = renderers[state.selectedTab] || renderers.overview;
  els.tabContent.innerHTML = renderer(project, model);
  bindDashboardActions();
  if (state.selectedTab === "terminal") startRuntimeLogPolling();
  else stopRuntimeLogPolling();
}

function renderOverview(project, model) {
  const failure = project.latestJob ? jobDigest(project.latestJob) : null;
  return `
    <div class="answer-grid">
      ${answerCard("Esta levantado?", model.runtimeState, "Runtime")}
      ${answerCard("Esta saludable?", model.status.label, model.status.explanation)}
      ${answerCard("Quality Gate", model.qualityGate, "Ultimo resultado importado desde SonarQube")}
      ${answerCard("Ultimo analisis", model.lastAnalysis, "Jobs locales y snapshot Sonar")}
    </div>
    ${runtimeFreshnessPanel(project)}
    ${localStatePanel(project)}
    ${toolLinksPanel(project)}
    <section class="focus-panel">
      <div>
        <span class="label">Que revisar primero</span>
        <h3>${escapeHtml(model.intent.label)}</h3>
        <p>${escapeHtml(model.intent.reason)}</p>
      </div>
      <button class="button primary" type="button" data-project-intent="${project.id}" data-intent-kind="${model.intent.kind}" data-intent-value="${model.intent.value}">
        ${escapeHtml(model.intent.button)}
      </button>
    </section>
    ${failure && project.latestJob?.status === "FAILED" ? `
      <section class="focus-panel danger-soft">
        <div>
          <span class="label">Ultimo error destacado</span>
          <h3>${escapeHtml(failure.title)}</h3>
          <p>${escapeHtml(`${failure.errors || 0} errores · ${failure.warnings || 0} advertencias · ${failure.logLines || 0} lineas capturadas`)}</p>
        </div>
        <button class="button secondary" type="button" data-job="${project.latestJob.id}">Ver traduccion del log</button>
      </section>
    ` : ""}
    <h3>Riesgos y brechas</h3>
    ${gapList(project)}
    <h3>Configuration Doctor</h3>
    ${doctorList(project.doctor || [])}
  `;
}

function renderEnvironment(project) {
  const runtime = project.localRuntime || {};
  const runtimeManifests = (project.manifests || []).filter((item) => /docker|compose|Dockerfile|gradle|pom\.xml|package\.json/i.test(item));
  const versions = state.versionsByProject[project.id] || null;
  const infrastructure = state.infrastructureByProject[project.id] || null;
  const deployments = state.deploymentsByProject[project.id] || null;
  if (!versions) queueMicrotask(() => loadProjectVersions(project.id));
  if (!infrastructure) queueMicrotask(() => loadProjectInfrastructure(project.id));
  if (!deployments) queueMicrotask(() => loadProjectDeployments(project.id));
  return `
    ${runtimeControlPanel(project)}
    ${versionManagementPanel(project, versions)}
    <div class="metric-grid">
      ${metric("Estado local", runtime.label || "Sin datos", runtime.explanation || "Sin runtime detectado")}
      ${metric("Freshness", freshnessLabel(runtime.freshness?.status), runtime.freshness?.message || "Sin evidencia de fingerprint")}
      ${metric("Git activo", gitLine(runtime.git || project.git), "Rama y commit capturados por el hub")}
      ${metric("Fingerprint", runtime.sourceFingerprint?.short || "Sin datos", runtime.sourceFingerprint ? `${runtime.sourceFingerprint.filesHashed || 0} archivos hasheados` : "Sin fingerprint")}
      ${metric("Compose activo", runtime.composeFile || "Sin datos", runtime.composeProject || "Proyecto Docker no detectado")}
      ${metric("Servicios", String((runtime.resources || []).length), "Contenedores asociados por labels Docker")}
      ${metric("Puertos publicados", String((runtime.ports || []).length), "Host ports activos/asignados")}
    </div>
    ${runtimeFreshnessPanel(project)}
    <h3>Despliegues Fase 6</h3>
    ${deploymentPanel(project, deployments)}
    <h3>Infraestructura y cloud</h3>
    ${infrastructurePanel(project, infrastructure)}
    <h3>Recursos activos</h3>
    ${resourceTable(runtime.resources || [])}
    <h3>Inventario de componentes</h3>
    ${componentInventory(project)}
    <h3>Perfiles aprobados</h3>
    ${runtimeProfileList(runtime.profiles || [])}
    <h3>Manifests y configuracion de entorno</h3>
    ${pathList(runtimeManifests, "No se detectaron manifests de infraestructura.")}
  `;
}

async function loadProjectVersions(projectId, options = {}) {
  const current = state.versionsByProject[projectId];
  if (!options.force && current?.loading) return;
  if (!options.force && current?.loadedAt && Date.now() - current.loadedAt < 15000) return;
  state.versionsByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/versions/overview`);
    state.versionsByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.versionsByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "environment") renderDashboard();
}

function versionManagementPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando Git y versiones...</strong><p class="muted">Refrescando branch, commit, remoto, fingerprint y deploy registrado.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar Fase 11.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  const repository = report.repository || {};
  const current = report.current || {};
  const deployed = report.deployed || {};
  const remote = report.remote || {};
  const diff = report.differences || {};
  const envDiff = diff.localVsEnvironment || {};
  const changes = report.changes || {};
  const stale = Boolean(envDiff.deployedMismatch || report.status === "DEPLOYED_VERSION_STALE");
  return `
    <section class="focus-panel ${stale ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 11 · Git y versiones</span>
        <h3>${escapeHtml(report.status || "Sin datos")}</h3>
        <p>${escapeHtml(`Probando ${current.branch || "sin rama"} @ ${current.shortCommit || "sin commit"} · deploy ${deployed.shortCommit || "sin deploy"} · ${changes.summary || "sin cambios detectados"}`)}</p>
      </div>
      <div class="toolbar">
        ${statusBadge(statusMeta(report.status || "UNKNOWN", report.status || "UNKNOWN", "", statusClass(report.status || "UNKNOWN"), 1))}
        <button class="button secondary compact-button" type="button" data-version-action="view-changes">View detected changes</button>
      </div>
    </section>
    <div class="metric-grid">
      ${metric("Repositorio Git", repository.isGit ? "Si" : "No", repository.clean ? "Limpio" : "Con cambios")}
      ${metric("Rama activa", current.branch || "Sin rama", `commit ${current.shortCommit || "sin commit"}${current.tag ? ` · tag ${current.tag}` : ""}`)}
      ${metric("Remote", remote.provider || "Sin remote", remote.upstream || remote.remote || "Sin upstream")}
      ${metric("Diff remoto", remote.status || "Sin datos", `ahead ${remote.ahead || 0} · behind ${remote.behind || 0}`)}
      ${metric("Commit desplegado", deployed.shortCommit || "Sin deploy", deployed.branch ? `rama ${deployed.branch}` : "sin rama de origen")}
      ${metric("Ultimo pull", formatDate(repository.lastPullAt), repository.pullEvidence || "sin FETCH_HEAD")}
      ${metric("Ultimo build", formatDate(deployed.lastBuildAt), deployed.strategy || "sin build registrado")}
      ${metric("Version desplegada", envDiff.deployedMismatch ? "No coincide" : deployed.exists ? "Coincide" : "Sin deploy", envDiff.summary || "sin comparacion")}
    </div>
    ${versionActionsPanel(report.actions || [], project.localRuntime || {})}
    ${versionDifferencesPanel(diff)}
    ${versionChangesPanel(changes)}
    ${versionGuardrailsPanel(report.guardrails || {}, report.runtime?.volumePolicy || {})}
  `;
}

function versionActionsPanel(actions, runtime = {}) {
  const busy = ["starting", "stopping", "restarting", "checking"].includes(runtime.status);
  if (!actions.length) return "";
  return `
    <h3>Acciones de version</h3>
    <div class="toolbar version-action-toolbar">
      ${actions.map((action) => `
        <button class="button ${action.id === "start" || action.id === "rebuild-changed" ? "primary" : "secondary"} compact-button" type="button" data-version-action="${escapeHtml(action.id)}" ${busy || !action.enabled ? "disabled" : ""} title="${escapeHtml(action.summary || "")}">
          ${escapeHtml(action.label || action.id)}
        </button>
      `).join("")}
    </div>
  `;
}

function versionDifferencesPanel(diff = {}) {
  const localRemote = diff.localVsRemote || {};
  const localEnvironment = diff.localVsEnvironment || {};
  return `
    <h3>Diferencias</h3>
    <div class="integration-grid">
      ${integrationCard("Local vs remoto", localRemote.status || "Sin datos", localRemote.summary || "Sin comparacion.")}
      ${integrationCard("Local vs ambiente", localEnvironment.status || "Sin datos", localEnvironment.summary || "Sin deploy registrado.")}
      ${integrationCard("Version desplegada", localEnvironment.deployedMismatch ? "No coincide" : "Sin drift", `commit=${yesNo(localEnvironment.commitMismatch)} · fingerprint=${yesNo(localEnvironment.fingerprintMismatch)} · branch=${yesNo(localEnvironment.branchMismatch)}`)}
    </div>
  `;
}

function versionChangesPanel(changes = {}) {
  const files = changes.files || [];
  return `
    <h3>Cambios detectados</h3>
    <section class="focus-panel ${changes.rebuildRequired ? "danger-soft" : ""}">
      <div>
        <span class="label">${escapeHtml(changes.status || "Sin datos")}</span>
        <h3>${escapeHtml(changes.rebuildRequired ? "Rebuild requerido" : "Sin rebuild pendiente")}</h3>
        <p>${escapeHtml(changes.summary || "Sin cambios locales detectados.")}</p>
      </div>
      <code>${escapeHtml(`local=${changes.currentFingerprint || "sin fp"} deploy=${changes.deployedFingerprint || "sin fp"}`)}</code>
    </section>
    ${files.length ? `
      <div class="stage-list">
        ${files.slice(0, 12).map((file) => `
          <article class="stage">
            <span class="status ${statusClass(file.change)}">${escapeHtml(file.change || file.status)}</span>
            <strong>${escapeHtml(file.path)}</strong>
            <p class="muted">${escapeHtml(file.status || "changed")}</p>
          </article>
        `).join("")}
      </div>
      ${files.length > 12 ? `<p class="muted">+${files.length - 12} cambios adicionales en la API.</p>` : ""}
    ` : `<article class="empty-state compact"><strong>Sin archivos cambiados</strong><p class="muted">El worktree no reporta cambios locales en Git.</p></article>`}
  `;
}

function versionGuardrailsPanel(guardrails = {}, volumePolicy = {}) {
  return `
    <h3>Politica de rebuild y volumenes</h3>
    <div class="integration-grid">
      ${integrationCard("Rebuild", guardrails.rebuildScope || "source-fingerprint-driven", guardrails.obsoleteImages || "Build forzado cuando cambia la huella.")}
      ${integrationCard("Pull", guardrails.pullMode || "ff-only", "Bloqueado si el worktree esta dirty o no hay upstream.")}
      ${integrationCard("Volumenes", guardrails.defaultVolumePolicy || volumePolicy.default || "preserve", `delete=${guardrails.volumeDeletion || "requires_explicit_confirmation"} · confirm=${volumePolicy.confirmationText || guardrails.volumeConfirmationText || "sin token"}`)}
    </div>
  `;
}

async function loadProjectInfrastructure(projectId) {
  const current = state.infrastructureByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 30000) return;
  state.infrastructureByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/infrastructure/overview`);
    state.infrastructureByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.infrastructureByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "environment") renderDashboard();
}

function infrastructurePanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando infraestructura...</strong><p class="muted">Inspeccionando manifests, adaptadores y drift local.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar infraestructura.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  const counts = report.counts || {};
  return `
    <section class="focus-panel ${counts.critical ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 10</span>
        <h3>${escapeHtml(report.status || "Sin datos")}</h3>
        <p>${escapeHtml(`${counts.resources || 0} recursos · ${counts.findings || 0} drift/findings · ${counts.critical || 0} criticos · ${counts.warning || 0} warnings`)}</p>
      </div>
      <div class="toolbar">
        ${statusBadge(statusMeta(report.status || "UNKNOWN", report.status || "UNKNOWN", "", statusToneFromIntegration(report.status), 1))}
        <button class="button secondary compact-button" type="button" data-infrastructure-action="refresh">Refrescar discovery</button>
      </div>
    </section>
    ${infrastructureDiscoveryPanel(report)}
    <div class="integration-grid">
      ${Object.values(report.adapters || {}).map(infrastructureAdapterCard).join("")}
    </div>
    ${infrastructureResourcePanel(report)}
    ${infrastructureDriftPanel(report)}
    <p class="muted">Ultima verificacion: ${escapeHtml(formatDate(report.generatedAt))}. Discovery read-only sobre ${escapeHtml(project.repositoryPath)}.</p>
  `;
}

function infrastructureAdapterCard(adapter = {}) {
  const status = adapter.status || "NOT_CONFIGURED";
  return `
    <article class="integration-card">
      <span class="label">${escapeHtml(adapter.mode || "adapter")}</span>
      <strong>${escapeHtml((adapter.name || "adapter").toUpperCase())}</strong>
      <p>${statusBadge(statusMeta(status, status, adapter.summary || "", statusToneFromIntegration(status), 1))}</p>
      <p class="muted">${escapeHtml(adapter.summary || "Sin evidencia.")}</p>
      <code>${escapeHtml(`resources=${adapter.resourceCount || 0}, manifests=${adapter.manifestCount || 0}, findings=${adapter.findingCount || 0}, credentials=${adapter.credentialState || "unknown"}`)}</code>
      <code>${escapeHtml(`validation=${adapter.validation?.status || "unknown"}, connectivity=${adapter.connectivity?.status || "unknown"}`)}</code>
      <p class="muted">${escapeHtml(`capabilities: ${(adapter.capabilities || []).slice(0, 3).join(", ") || "sin capacidades declaradas"}`)}</p>
    </article>
  `;
}

function infrastructureDiscoveryPanel(report) {
  const cache = report.discoveryCache || {};
  const policy = report.adapterPolicy || {};
  return `
    <h3>Discovery y cache</h3>
    <div class="integration-grid">
      <article class="integration-card">
        <span class="label">Cache</span>
        <strong>${escapeHtml(cache.status || "SIN SNAPSHOT")}</strong>
        <p class="muted">${escapeHtml(`TTL ${cache.ttlSeconds || policy.cacheTtlSeconds || 0}s · edad ${cache.ageSeconds ?? 0}s`)}</p>
        <code>${escapeHtml(cache.sourceHashShort ? `hash=${cache.sourceHashShort}` : "sin hash")}</code>
      </article>
      <article class="integration-card">
        <span class="label">Guardrails</span>
        <strong>${escapeHtml(`${policy.phase || "Fase 10"} · ${policy.liveCloudCalls || "disabled"}`)}</strong>
        <p class="muted">${escapeHtml(`Refresh auditado: ${policy.refreshAudit || "infrastructure.discovery.refresh"}`)}</p>
        <code>${escapeHtml(`scope=${policy.cacheScope || "static-manifests"}`)}</code>
      </article>
    </div>
  `;
}

function infrastructureResourcePanel(report) {
  const resources = report.resources || [];
  if (!resources.length) return `<article class="empty-state compact"><strong>Sin recursos declarados</strong><p class="muted">No se detectaron manifests de infraestructura soportados.</p></article>`;
  return `
    <h3>Recursos detectados</h3>
    <div class="stage-list">
      ${resources.slice(0, 18).map((resource) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(resource.status)}">${escapeHtml(resource.provider)}</span>
          <strong>${escapeHtml(`${resource.type}: ${resource.name}`)}</strong>
          <p class="muted">${escapeHtml(`${resource.source}${resource.namespace ? ` · ns=${resource.namespace}` : ""}${resource.parent ? ` · parent=${resource.parent}` : ""}`)}</p>
          ${resource.path ? `<code>${escapeHtml(`${resource.path}${resource.line ? `:${resource.line}` : ""}`)}</code>` : ""}
        </article>
      `).join("")}
    </div>
    ${resources.length > 18 ? `<p class="muted">+${resources.length - 18} recursos adicionales en la API.</p>` : ""}
  `;
}

function infrastructureDriftPanel(report) {
  const findings = report.drift?.findings || report.findings || [];
  if (!findings.length) return `<article class="empty-state compact"><strong>Sin drift abierto</strong><p class="muted">No se detectaron brechas entre descriptor, manifests y runtime local.</p></article>`;
  return `
    <h3>Drift y brechas</h3>
    <div class="stage-list">
      ${findings.slice(0, 12).map((finding) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <strong>${escapeHtml(finding.title || finding.code)}</strong>
          <p class="muted">${escapeHtml(finding.detail || finding.code)}</p>
          ${finding.path ? `<code>${escapeHtml(`${finding.path}${finding.line ? `:${finding.line}` : ""}`)}</code>` : ""}
          ${finding.evidence ? `<p class="muted">${escapeHtml(finding.evidence)}</p>` : ""}
        </article>
      `).join("")}
    </div>
    ${findings.length > 12 ? `<p class="muted">+${findings.length - 12} findings adicionales en la API.</p>` : ""}
  `;
}

async function loadProjectDeployments(projectId) {
  const current = state.deploymentsByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 15000) return;
  state.deploymentsByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/deployments/overview`);
    state.deploymentsByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.deploymentsByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "environment") renderDashboard();
}

function deploymentPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando despliegues...</strong><p class="muted">Calculando ambientes, planes, aprobaciones, auditoria y rollback.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar Fase 6.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  const counts = report.counts || {};
  const latestPlan = report.latestPlan || null;
  const latestRecord = report.latestRecord || null;
  const approvalStatus = latestPlan?.approval?.status || "SIN_PLAN";
  const canApprove = approvalStatus === "PENDING";
  const canApply = latestPlan?.status === "READY" && approvalStatus === "APPROVED";
  const canRollback = Boolean(latestRecord);
  return `
    <section class="focus-panel ${counts.failed || counts.findings?.critical ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 6</span>
        <h3>${escapeHtml(report.status || "Sin datos")}</h3>
        <p>${escapeHtml(`Plan / Apply / Verify / Rollback · ${counts.plans || 0} planes · ${counts.records || 0} registros · ${counts.pendingApprovals || 0} aprobaciones pendientes`)}</p>
      </div>
      <div class="toolbar">
        <button class="button secondary compact-button" type="button" data-deployment-action="plan-smart">Plan</button>
        <button class="button secondary compact-button" type="button" data-deployment-action="approve" ${canApprove ? "" : "disabled"}>Aprobar</button>
        <button class="button primary compact-button" type="button" data-deployment-action="apply" ${canApply ? "" : "disabled"}>Apply</button>
        <button class="button secondary compact-button" type="button" data-deployment-action="verify">Verify</button>
        <button class="button secondary compact-button" type="button" data-deployment-action="rollback" ${canRollback ? "" : "disabled"}>Rollback</button>
      </div>
    </section>
    ${deploymentGuardrailPanel(report.guardrails || {})}
    ${deploymentEnvironmentPanel(report)}
    ${deploymentPlanPanel(report)}
    ${deploymentRecordPanel(report)}
    ${deploymentAuditPanel(report)}
    ${deploymentFindingPanel(report)}
    <p class="muted">Ultima verificacion: ${escapeHtml(formatDate(report.generatedAt))}. Proyecto: ${escapeHtml(project.slug)}.</p>
  `;
}

function deploymentGuardrailPanel(guardrails) {
  const production = guardrails.production || {};
  const local = guardrails.local || {};
  return `
    <div class="integration-grid">
      ${integrationCard("Perfiles aprobados", "Ejecucion", guardrails.execution || "approved-local-runtime-profiles")}
      ${integrationCard("Apply local", "Aprobacion", local.apply || "requires_approval")}
      ${integrationCard("Produccion", "Guardrail", `modo=${production.defaultMode || "read-only"}, apply=${production.apply || "blocked"}`)}
      ${integrationCard("Comandos arbitrarios", "Bloqueado", guardrails.arbitraryCommands || "blocked")}
    </div>
  `;
}

function deploymentEnvironmentPanel(report) {
  const environments = report.environments || [];
  if (!environments.length) return `<article class="empty-state compact"><strong>Sin ambientes registrados</strong><p class="muted">El descriptor no declara ambientes para este proyecto.</p></article>`;
  return `
    <h3>Ambientes y capacidades</h3>
    <div class="stage-list">
      ${environments.map((environment) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(environment.status)}">${escapeHtml(environment.name)}</span>
          <strong>${escapeHtml(`${environment.provider || "local"} · ${environment.status || "UNKNOWN"}`)}</strong>
          <p class="muted">${escapeHtml(`plan=${yesNo(environment.canPlan)} · apply=${yesNo(environment.canApply)} · verify=${yesNo(environment.canVerify)} · rollback=${yesNo(environment.canRollback)} · protected=${yesNo(environment.protected)}`)}</p>
          <code>${escapeHtml(environment.evidence || "sin evidencia")}</code>
        </article>
      `).join("")}
    </div>
  `;
}

function deploymentPlanPanel(report) {
  const plan = report.latestPlan || null;
  if (!plan) {
    return `<article class="empty-state compact"><strong>Sin plan de despliegue</strong><p class="muted">Genera un plan local para revisar fingerprint, runtime, blockers y aprobacion requerida.</p></article>`;
  }
  const blockers = plan.blockers || [];
  const warnings = plan.warnings || [];
  return `
    <h3>Ultimo plan</h3>
    <div class="stage-list">
      <article class="stage finding-stage">
        <span class="status ${statusClass(plan.status)}">${escapeHtml(plan.status)}</span>
        <strong>${escapeHtml(`${plan.environment} · ${plan.strategy} · ${plan.runtimeAction}`)}</strong>
        <p class="muted">${escapeHtml(`fingerprint=${plan.target?.expectedFingerprintShort || plan.sourceFingerprint?.short || "sin datos"} · approval=${plan.approval?.status || "sin aprobacion"} · ${formatDate(plan.createdAt)}`)}</p>
        ${plan.git ? `<code>${escapeHtml(gitLine(plan.git))}</code>` : ""}
        ${(blockers.length || warnings.length) ? `<ul class="compact-list">${[...blockers, ...warnings].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      </article>
      ${(plan.steps || []).map((step) => `
        <article class="stage">
          <span class="status ${statusClass(step.status)}">${escapeHtml(step.status)}</span>
          <strong>${escapeHtml(step.name)}</strong>
          <p class="muted">${escapeHtml(step.detail || "")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function deploymentRecordPanel(report) {
  const records = report.records || [];
  if (!records.length) {
    return `<article class="empty-state compact"><strong>Sin registros de apply/rollback</strong><p class="muted">Apply y rollback generan registros auditables con verificacion y errores sanitizados.</p></article>`;
  }
  return `
    <h3>Registros recientes</h3>
    <div class="stage-list">
      ${records.slice(0, 6).map((record) => {
        const verification = record.verification || null;
        return `
          <article class="stage finding-stage">
            <span class="status ${statusClass(record.status)}">${escapeHtml(record.status)}</span>
            <strong>${escapeHtml(`${record.operation} · ${record.environment} · ${record.strategy}`)}</strong>
            <p class="muted">${escapeHtml(`${formatDate(record.startedAt)} -> ${formatDate(record.finishedAt)} · runtime=${record.runtimeAction || "sin accion"} · verify=${verification?.status || "sin verify"}`)}</p>
            ${verification ? `<p class="muted">${escapeHtml(verification.summary || verification.status)}</p>` : ""}
            ${record.error ? `<code>${escapeHtml(`${record.error.code}: ${record.error.message}`)}</code>` : ""}
          </article>
        `;
      }).join("")}
      ${records[0]?.verification?.checks?.length ? records[0].verification.checks.map((check) => `
        <article class="stage">
          <span class="status ${statusClass(check.status)}">${escapeHtml(check.status)}</span>
          <strong>${escapeHtml(check.name)}</strong>
          <p class="muted">${escapeHtml(check.evidence || "")}</p>
        </article>
      `).join("") : ""}
    </div>
  `;
}

function deploymentAuditPanel(report) {
  const events = report.audit || [];
  if (!events.length) {
    return `<article class="empty-state compact"><strong>Sin auditoria de despliegues</strong><p class="muted">Los eventos deployment.* aparecen despues de plan, aprobacion, apply, verify o rollback.</p></article>`;
  }
  return `
    <h3>Auditoria de despliegues</h3>
    <div class="stage-list">
      ${events.slice(0, 8).map((event) => `
        <article class="stage">
          <span class="status ${statusClass(event.result)}">${escapeHtml(event.result || "UNKNOWN")}</span>
          <strong>${escapeHtml(event.action || "deployment.event")}</strong>
          <p class="muted">${escapeHtml(`${formatDate(event.timestamp)} · ${event.target || ""}`)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function deploymentFindingPanel(report) {
  const findings = report.findings || [];
  if (!findings.length) {
    return `<article class="empty-state compact"><strong>Sin findings de despliegue abiertos</strong><p class="muted">Los guardrails de Fase 6 no detectan brechas abiertas con la evidencia actual.</p></article>`;
  }
  return `
    <h3>Findings de despliegue</h3>
    <div class="stage-list">
      ${findings.slice(0, 10).map((finding) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <strong>${escapeHtml(finding.title || finding.code)}</strong>
          <p class="muted">${escapeHtml(finding.detail || finding.code)}</p>
          ${finding.evidence ? `<code>${escapeHtml(finding.evidence)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function yesNo(value) {
  return value ? "si" : "no";
}

function localStatePanel(project) {
  const localState = project.localState || {};
  const declaredStatus = phaseStatusMeta(localState.declared?.status || "NOT_CONFIGURED");
  const detectedStatus = phaseStatusMeta(localState.detected?.status || "NOT_CONFIGURED");
  const verifiedStatus = phaseStatusMeta(localState.verified?.status || "CONFIGURED_NOT_VERIFIED");
  const gaps = localState.gaps || [];
  return `
    <section class="focus-panel">
      <div>
        <span class="label">Estado local Fase 1</span>
        <h3>Declarado / Detectado / Verificado</h3>
        <p>${escapeHtml(localStateSummary(localState))}</p>
      </div>
      <div class="toolbar">
        ${statusBadge(declaredStatus)}
        ${statusBadge(detectedStatus)}
        ${statusBadge(verifiedStatus)}
      </div>
    </section>
    ${gaps.length ? `
      <div class="stage-list">
        ${gaps.slice(0, 4).map((gap) => `
          <article class="stage">
            <span class="status ${statusClass(gap.severity)}">${escapeHtml(gap.severity)}</span>
            <strong>${escapeHtml(gap.code)}</strong>
            <p class="muted">${escapeHtml(gap.message)}</p>
          </article>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function localStateSummary(localState) {
  const declared = localState.declared?.components?.length || 0;
  const detected = localState.detected?.components?.length || 0;
  const verified = localState.verified?.docker?.resources?.length || 0;
  const descriptor = localState.descriptor?.projectDeclared ? "descriptor YAML activo" : "descriptor YAML pendiente";
  return `${descriptor}. Componentes: ${declared} declarados, ${detected} detectados, ${verified} recursos verificados.`;
}

function phaseStatusMeta(status) {
  const label = String(status || "NOT_CONFIGURED");
  const tone = label === "CONFIGURED_AND_VERIFIED"
    ? "ok"
    : label === "ERROR"
      ? "error"
      : label === "NOT_CONFIGURED"
        ? "warn"
        : "info";
  return statusMeta(label, label, label, tone, tone === "error" ? 5 : tone === "warn" ? 3 : 1);
}

function componentInventory(project) {
  const components = project.components || {};
  const sections = [
    ["Declarados", components.declared || []],
    ["Detectados", components.detected || []],
    ["Verificados", components.verified || []]
  ];
  return `
    <div class="integration-grid">
      ${sections.map(([title, items]) => `
        <article class="integration-card">
          <span class="label">${escapeHtml(title)}</span>
          <strong>${escapeHtml(String(items.length))}</strong>
          ${items.length ? `
            <ul class="compact-list">
              ${items.slice(0, 6).map(componentListItem).join("")}
            </ul>
          ` : `<p class="muted">Sin componentes en este estado.</p>`}
          ${items.length > 6 ? `<p class="muted">+${items.length - 6} componentes adicionales.</p>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function componentListItem(component) {
  const pathLabel = component.path || component.evidence || component.source || "";
  const status = component.status ? ` · ${component.status}` : "";
  const detail = `${component.type || "component"}${status}${pathLabel ? ` · ${pathLabel}` : ""}`;
  return `<li><strong>${escapeHtml(component.name || component.service || "component")}</strong><span class="muted"> ${escapeHtml(detail)}</span></li>`;
}

function renderQualityAndObservability(project, model) {
  const snapshot = project.latestSnapshot;
  const instrumentation = project.instrumentation || {};
  const observability = state.observabilityByProject[project.id] || null;
  const qualitySecurity = state.qualitySecurityByProject[project.id] || null;
  if (!observability) queueMicrotask(() => loadProjectObservability(project.id));
  if (!qualitySecurity) queueMicrotask(() => loadProjectQualitySecurity(project.id));
  return `
    <div class="metric-grid">
      ${metric("Quality Gate", model.qualityGate, "SonarQube")}
      ${metric("Coverage", model.coverage, "LCOV / JaCoCo")}
      ${metric("Bugs", snapshot?.metrics?.bugs ?? "Sin datos", "SonarQube")}
      ${metric("Vulnerabilities", snapshot?.metrics?.vulnerabilities ?? "Sin datos", "SonarQube")}
      ${metric("Health", instrumentation.health?.length ? "Detectado" : "Sin datos", (instrumentation.health || []).join("; ") || "No detectado")}
      ${metric("Traces", instrumentation.traces?.length ? "Detectado" : "Sin datos", (instrumentation.traces || []).join("; ") || "OpenTelemetry no detectado")}
    </div>
    <div class="toolbar">
      <button class="button secondary" type="button" data-action="tests">Ejecutar tests</button>
      <button class="button secondary" type="button" data-action="coverage">Generar coverage</button>
      <button class="button secondary" type="button" data-action="sonar">Ejecutar Sonar</button>
      <a class="button secondary" href="${escapeHtml(project.links?.overview || "#")}" target="_blank" rel="noreferrer">Abrir Sonar</a>
      <a class="button secondary" href="http://localhost:13000" target="_blank" rel="noreferrer">Abrir Grafana</a>
    </div>
    ${toolLinksPanel(project, "quality")}
    <h3>Calidad y seguridad verificada</h3>
    ${qualitySecurityPanel(project, qualitySecurity)}
    <h3>Artefactos de cobertura</h3>
    ${pathList(project.coverageArtifacts || [], "Sin reportes de cobertura detectados todavia.")}
    <h3>Observabilidad verificada</h3>
    ${observabilityPanel(project, observability)}
  `;
}

async function loadProjectQualitySecurity(projectId) {
  const current = state.qualitySecurityByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 30000) return;
  state.qualitySecurityByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/quality-security/overview`);
    state.qualitySecurityByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.qualitySecurityByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "quality") renderDashboard();
}

function qualitySecurityPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando calidad y seguridad...</strong><p class="muted">Escaneando tests, SonarQube, dependencias, secretos y contenedores.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar calidad/seguridad.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  return `
    <section class="focus-panel ${report.counts?.critical ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 3</span>
        <h3>${escapeHtml(report.status || "Sin datos")}</h3>
        <p>${escapeHtml(qualitySecuritySummary(report))}</p>
      </div>
      <div class="toolbar">
        ${statusBadge(statusMeta(report.status || "UNKNOWN", report.status || "UNKNOWN", "", statusToneFromIntegration(report.status), 1))}
      </div>
    </section>
    <div class="integration-grid">
      ${qualitySecuritySignalCard("Tests", "Local", report.tests)}
      ${qualitySecuritySignalCard("SonarQube", "Quality Gate", report.sonarqube)}
      ${qualitySecuritySignalCard("Dependencias", "Manifests", report.dependencies)}
      ${qualitySecuritySignalCard("Secret scanning", "Redaccion", report.secretScanning)}
      ${qualitySecuritySignalCard("Container scanning", "Docker", report.containerScanning)}
    </div>
    ${qualitySecurityArtifacts(report)}
    ${qualitySecurityFindings(report)}
    <p class="muted">Ultima verificacion: ${escapeHtml(formatDate(report.generatedAt))}. Proyecto: ${escapeHtml(project.slug)}.</p>
  `;
}

function qualitySecuritySummary(report) {
  const counts = report.counts || {};
  const parts = [
    `${counts.critical || 0} criticos`,
    `${counts.warning || 0} warnings`,
    `${counts.info || 0} info`
  ];
  return `${parts.join(" · ")}. Scanners: tests, SonarQube, dependencias, secretos y contenedores.`;
}

function qualitySecuritySignalCard(title, label, signal = {}) {
  const status = signal.status || "NOT_CONFIGURED";
  const counts = [
    hasValue(signal.packageCount) ? `packages=${signal.packageCount}` : "",
    hasValue(signal.scannedFiles) ? `files=${signal.scannedFiles}` : "",
    hasValue(signal.skippedFiles) ? `skipped=${signal.skippedFiles}` : "",
    hasValue(signal.dockerfiles?.length) ? `dockerfiles=${signal.dockerfiles.length}` : "",
    hasValue(signal.composeFiles?.length) ? `compose=${signal.composeFiles.length}` : "",
    hasValue(signal.findings?.length) ? `findings=${signal.findings.length}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <article class="integration-card">
      <span class="label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${statusBadge(statusMeta(status, status, signal.summary || "", statusToneFromIntegration(status), 1))}</p>
      <p class="muted">${escapeHtml(signal.summary || counts || "Sin evidencia.")}</p>
      ${signal.evidence ? `<code>${escapeHtml(signal.evidence)}</code>` : ""}
      ${counts ? `<p class="muted">${escapeHtml(counts)}</p>` : ""}
      <div class="toolbar">
        ${(signal.links || []).slice(0, 2).map((link) => `<a class="button ghost compact-button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("")}
      </div>
    </article>
  `;
}

function qualitySecurityArtifacts(report) {
  const dependencies = report.dependencies || {};
  const containers = report.containerScanning || {};
  const artifacts = [
    ...(dependencies.manifests || []).map((item) => `manifest: ${item}`),
    ...(dependencies.lockfiles || []).map((item) => `lockfile: ${item}`),
    ...(containers.dockerfiles || []).map((item) => `dockerfile: ${item}`),
    ...(containers.composeFiles || []).map((item) => `compose: ${item}`)
  ];
  if (!artifacts.length) return "";
  return `
    <h3>Evidencias inspeccionadas</h3>
    ${pathList(artifacts.slice(0, 24), "Sin artefactos inspeccionados.")}
  `;
}

function qualitySecurityFindings(report) {
  const findings = report.findings || [];
  if (!findings.length) {
    return `<article class="empty-state compact"><strong>Sin findings abiertos</strong><p class="muted">Los scanners locales no detectaron brechas bloqueantes con los patrones actuales.</p></article>`;
  }
  return `
    <h3>Findings</h3>
    <div class="stage-list">
      ${findings.slice(0, 12).map((finding) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <strong>${escapeHtml(finding.title || finding.code)}</strong>
          <p class="muted">${escapeHtml(finding.detail || finding.code)}</p>
          ${finding.path ? `<code>${escapeHtml(`${finding.path}${finding.line ? `:${finding.line}` : ""}`)}</code>` : ""}
          ${finding.evidence ? `<p class="muted">${escapeHtml(finding.evidence)}</p>` : ""}
        </article>
      `).join("")}
    </div>
    ${findings.length > 12 ? `<p class="muted">+${findings.length - 12} findings adicionales en la API.</p>` : ""}
  `;
}

async function loadProjectObservability(projectId) {
  const current = state.observabilityByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 30000) return;
  state.observabilityByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/observability/overview`);
    state.observabilityByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.observabilityByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "quality") renderDashboard();
}

function observabilityPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando observabilidad...</strong><p class="muted">Consultando Prometheus, Loki, Tempo y Alertmanager.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar observabilidad.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  return `
    <div class="integration-grid">
      ${observabilitySignalCard("Prometheus", "Metrics", report.metrics)}
      ${observabilitySignalCard("Loki", "Logs", report.logs)}
      ${observabilitySignalCard("Tempo", "Traces", report.traces)}
      ${observabilitySignalCard("Alertmanager", "Alerts", report.alerts)}
    </div>
    ${observabilityDashboards(report)}
    ${observabilityGaps(report)}
    <p class="muted">Ultima verificacion: ${escapeHtml(formatDate(report.generatedAt))}. Labels esperados: project=${escapeHtml(project.slug)}, environment=local.</p>
  `;
}

function observabilitySignalCard(title, label, signal = {}) {
  const status = signal.status || "NOT_CONFIGURED";
  const counts = [
    hasValue(signal.sampleCount) ? `samples=${signal.sampleCount}` : "",
    hasValue(signal.probeSampleCount) ? `probes=${signal.probeSampleCount}` : "",
    hasValue(signal.lineCount) ? `lines=${signal.lineCount}` : "",
    hasValue(signal.localRuntimeLogLines) ? `local=${signal.localRuntimeLogLines}` : "",
    hasValue(signal.traceCount) ? `traces=${signal.traceCount}` : "",
    hasValue(signal.active) ? `active=${signal.active}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <article class="integration-card">
      <span class="label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${statusBadge(statusMeta(status, status, signal.summary || "", statusToneFromIntegration(status), 1))}</p>
      <p class="muted">${escapeHtml(signal.summary || counts || "Sin evidencia.")}</p>
      ${signal.query ? `<code>${escapeHtml(signal.query)}</code>` : ""}
      ${counts ? `<p class="muted">${escapeHtml(counts)}</p>` : ""}
      <div class="toolbar">
        ${(signal.links || []).slice(0, 2).map((link) => `<a class="button ghost compact-button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join("")}
      </div>
    </article>
  `;
}

function observabilityDashboards(report) {
  const dashboards = report.dashboards || [];
  if (!dashboards.length) return "";
  return `
    <h3>Dashboards</h3>
    <div class="tool-link-grid">
      ${dashboards.map((dashboard) => `
        <a class="tool-link ${statusToneFromIntegration(dashboard.status)}" href="${escapeHtml(dashboard.url)}" target="_blank" rel="noreferrer">
          <strong>${escapeHtml(dashboard.name)}</strong>
          <span>${escapeHtml(`${dashboard.provider || "dashboard"} · ${dashboard.status || "UNKNOWN"}`)}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function observabilityGaps(report) {
  const gaps = report.gaps || [];
  if (!gaps.length) return "";
  return `
    <h3>Gaps de observabilidad</h3>
    <div class="stage-list">
      ${gaps.map((gap) => `
        <article class="stage">
          <span class="status ${statusClass(gap.severity)}">${escapeHtml(gap.severity || "warning")}</span>
          <strong>${escapeHtml(gap.message)}</strong>
        </article>
      `).join("")}
    </div>
  `;
}

function statusToneFromIntegration(status) {
  if (status === "CONFIGURED_AND_VERIFIED") return "ok";
  if (status === "PARTIALLY_CONFIGURED" || status === "CONFIGURED_NOT_VERIFIED") return "info";
  if (status === "ERROR") return "error";
  return "warn";
}

function renderTerminal(project) {
  const runtime = project.localRuntime || {};
  return `
    ${runtimeControlPanel(project)}
    <div class="terminal-toolbar">
      <div>
        ${runtimeStatusBadge(runtime)}
        <p class="muted">${escapeHtml(runtime.explanation || "Sin estado local.")}</p>
      </div>
      <div class="toolbar">
        <button class="button secondary" type="button" data-runtime-log-refresh>Actualizar logs</button>
        <button class="button secondary" type="button" data-runtime-log-clear>Limpiar consola</button>
        <button class="button secondary" type="button" data-runtime-log-download>Descargar log</button>
      </div>
    </div>
    <pre id="runtimeLogs" class="logs terminal-logs">${escapeHtml(state.runtimeLogText || "Cargando logs del runtime...")}</pre>
  `;
}

function renderQuality(project, model) {
  const snapshot = project.latestSnapshot;
  return `
    <div class="metric-grid">
      ${metric("Quality Gate", model.qualityGate, "SonarQube")}
      ${metric("Coverage", model.coverage, "SonarQube")}
      ${metric("Bugs", snapshot?.metrics?.bugs ?? "Sin datos", "SonarQube")}
      ${metric("Vulnerabilities", snapshot?.metrics?.vulnerabilities ?? "Sin datos", "SonarQube")}
      ${metric("Code smells", snapshot?.metrics?.code_smells ?? "Sin datos", "SonarQube")}
      ${metric("Duplications", hasValue(snapshot?.metrics?.duplicated_lines_density) ? `${snapshot.metrics.duplicated_lines_density}%` : "Sin datos", "SonarQube")}
    </div>
    <p class="muted">Fuente: SonarQube. Ultima importacion: ${escapeHtml(snapshot?.analysisTimestamp || "sin datos")}.</p>
    <div class="toolbar">
      <a class="button secondary" href="${escapeHtml(project.links?.overview || "#")}" target="_blank" rel="noreferrer">Overview</a>
      <a class="button secondary" href="${escapeHtml(project.links?.issues || "#")}" target="_blank" rel="noreferrer">Issues</a>
      <a class="button secondary" href="${escapeHtml(project.links?.measures || "#")}" target="_blank" rel="noreferrer">Measures</a>
      <a class="button secondary" href="${escapeHtml(project.links?.securityHotspots || "#")}" target="_blank" rel="noreferrer">Security hotspots</a>
    </div>
  `;
}

function renderCoverage(project, model) {
  const coverageCommands = (project.approvedCommands || []).filter((command) => command.action === "coverage" || command.action === "tests");
  return `
    <div class="metric-grid">
      ${metric("Coverage", model.coverage, "Reporte importado")}
      ${metric("Reportes detectados", String((project.coverageArtifacts || []).length), "LCOV, JaCoCo XML o coverage.xml")}
      ${metric("Templates de test", String((project.approvedCommands || []).filter((command) => command.action === "tests").length), "Discovery")}
      ${metric("Templates de coverage", String((project.approvedCommands || []).filter((command) => command.action === "coverage").length), "Discovery")}
    </div>
    <h3>Comandos disponibles</h3>
    ${commandList(coverageCommands)}
    <h3>Artefactos de cobertura</h3>
    ${pathList(project.coverageArtifacts || [], "Sin reportes de cobertura detectados todavia.")}
  `;
}

function renderObservability(project) {
  const instrumentation = project.instrumentation || {};
  return `
    <div class="metric-grid">
      ${metric("Health", instrumentation.health?.length ? "Detectado" : "Sin datos", (instrumentation.health || []).join("; ") || "No detectado en manifests")}
      ${metric("Metrics", instrumentation.metrics?.length ? "Detectado" : "Sin datos", (instrumentation.metrics || []).join("; ") || "Prometheus/Micrometer no detectado")}
      ${metric("Logs", instrumentation.logs?.length ? "Detectado" : "Sin datos", (instrumentation.logs || []).join("; ") || "Logging estructurado no detectado")}
      ${metric("Traces", instrumentation.traces?.length ? "Detectado" : "Sin datos", (instrumentation.traces || []).join("; ") || "OpenTelemetry no detectado")}
    </div>
    <div class="integration-grid">
      ${integrationCard("Prometheus", "Metrics", `project=${project.slug}, environment=local`)}
      ${integrationCard("Loki", "Logs", `{project="${project.slug}", environment="local"}`)}
      ${integrationCard("Tempo", "Traces", `service.name=${project.slug}`)}
      ${integrationCard("Grafana", "Dashboard", "Paneles compartidos del stack local")}
    </div>
  `;
}

function renderAlerts(project) {
  return `
    <div class="metric-grid">
      ${metric("Alertas activas", "Sin datos", "Alertmanager")}
      ${metric("Quality Gate fallido", "Sin datos", "Regla disponible cuando haya snapshot real")}
      ${metric("Servicios caidos", "Sin datos", "Blackbox/Prometheus")}
      ${metric("Incidentes recientes", "Sin datos", "Se importa al emitir senales reales")}
    </div>
    <p class="muted">La UI diferencia entre OK, Warning y Sin datos. No se infiere estado saludable si Alertmanager no tiene informacion por proyecto.</p>
    <a class="button secondary" href="http://localhost:19093" target="_blank" rel="noreferrer">Abrir Alertmanager</a>
  `;
}

function renderInfrastructure(project) {
  const runtime = (project.manifests || []).filter((item) => /docker|compose|Dockerfile|gradle|pom\.xml|package\.json/i.test(item));
  return `
    <div class="metric-grid">
      ${metric("Git", project.git?.isGit ? `${project.git.branch || "branch"} · ${shortSha(project.git.commit)}` : "No detectado", "Repositorio")}
      ${metric("Runtime", runtime.length ? `${runtime.length} manifests` : "Sin datos", "Docker/build files")}
      ${metric("Stack", (project.detectedStack || []).join(", ") || "Sin datos", "Discovery")}
      ${metric("Entorno activo", "local", "Workspace")}
    </div>
    <h3>Manifests de infraestructura</h3>
    ${pathList(runtime, "No se detectaron manifests de infraestructura.")}
  `;
}

function renderExecutions(project) {
  const jobs = project.latestJob ? [project.latestJob] : [];
  const testing = state.testingByProject[project.id] || null;
  if (!testing) queueMicrotask(() => loadProjectTesting(project.id));
  return `
    <div class="toolbar">
      <button class="button secondary" type="button" data-action="lint">Lint</button>
      <button class="button secondary" type="button" data-action="tests">Tests</button>
      <button class="button secondary" type="button" data-action="coverage">Coverage</button>
      <button class="button secondary" type="button" data-action="build">Build</button>
      <button class="button secondary" type="button" data-action="sonar">Sonar</button>
    </div>
    <h3>Orquestador de pruebas</h3>
    ${testingOrchestratorPanel(project, testing)}
    <h3>Ultimo job clasico</h3>
    <div class="stage-list">
      ${jobs.map((job) => `<article class="stage"><strong>${escapeHtml(job.action)} · ${escapeHtml(job.status)}</strong><p class="muted">${escapeHtml(formatDate(job.createdAt))}</p><button class="button secondary" data-job="${job.id}" type="button">Ver job</button></article>`).join("") || `<p class="muted">Sin ejecuciones todavia.</p>`}
    </div>
  `;
}

async function loadProjectTesting(projectId) {
  const current = state.testingByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 30000) return;
  state.testingByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/testing/overview`);
    state.testingByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.testingByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "executions") renderDashboard();
}

function testingOrchestratorPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando orquestador...</strong><p class="muted">Construyendo catalogo cerrado, evidencias y guardrails.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar Fase 5.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  const counts = report.counts || {};
  return `
    <section class="focus-panel ${counts.findings?.critical ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 5</span>
        <h3>${escapeHtml(report.status || "Sin datos")}</h3>
        <p>${escapeHtml(`${counts.definitions || 0} definiciones · ${counts.runnable || 0} ejecutables · ${counts.blocked || 0} bloqueadas · ${counts.executions || 0} ejecuciones`)}</p>
      </div>
      ${statusBadge(statusMeta(report.status || "UNKNOWN", report.status || "UNKNOWN", "", statusToneFromIntegration(report.status), 1))}
    </section>
    ${testingGuardrailPanel(report.guardrails || {})}
    ${testingDefinitionCatalog(project, report)}
    ${testingExecutionEvidence(report)}
    ${testingFindingPanel(report)}
    <p class="muted">Ultima verificacion: ${escapeHtml(formatDate(report.generatedAt))}. Worker: ${escapeHtml(report.workerPool?.id || "local-job-worker")}.</p>
  `;
}

function testingGuardrailPanel(guardrails) {
  const performance = guardrails.performance || {};
  return `
    <div class="integration-grid">
      ${integrationCard("Catalogo cerrado", "Guardrail", `Comandos arbitrarios: ${guardrails.arbitraryCommands || "blocked"}`)}
      ${integrationCard("Performance", "Limites", `VUs<=${performance.maxVirtualUsers || 0}, duracion<=${performance.maxDurationSeconds || 0}s, requests<=${performance.maxRequests || 0}`)}
      ${integrationCard("DAST", "Modo", guardrails.dast?.mode || "passive-read-only")}
      ${integrationCard("Stress", "Estado", guardrails.stress?.status || "BLOCKED")}
    </div>
  `;
}

function testingDefinitionCatalog(project, report) {
  const definitions = report.definitions || [];
  if (!definitions.length) {
    return `<article class="empty-state compact"><strong>Sin definiciones</strong><p class="muted">No se detectaron comandos, perfiles smoke ni targets HTTP locales.</p></article>`;
  }
  return `
    <h3>Catalogo de pruebas</h3>
    <div class="stage-list">
      ${definitions.map((definition) => testingDefinitionCard(project, definition)).join("")}
    </div>
  `;
}

function testingDefinitionCard(project, definition) {
  const status = definition.status || "NOT_CONFIGURED";
  const guardrail = definition.guardrails || {};
  const target = testingTargetSummary(definition);
  const latest = definition.latestExecution ? `${definition.latestExecution.status} · ${formatDate(definition.latestExecution.createdAt)}` : "sin ejecucion";
  return `
    <article class="stage finding-stage">
      <span class="status ${statusClass(status)}">${escapeHtml(definition.type || definition.action)}</span>
      <strong>${escapeHtml(definition.name || definition.id)}</strong>
      <p class="muted">${escapeHtml(`${definition.mode || "test"} · ${status} · guardrail=${guardrail.status || "UNKNOWN"} · latest=${latest}`)}</p>
      <p class="muted">${escapeHtml(target)}</p>
      ${definition.command ? `<code>${escapeHtml(`${definition.command.cwd || "."}: ${definition.command.label}`)}</code>` : ""}
      <div class="toolbar">
        ${definition.canRun ? `
          <button class="button secondary compact-button" type="button" data-test-definition="${escapeHtml(definition.id)}">Ejecutar</button>
        ` : `
          <button class="button secondary compact-button" type="button" disabled>Bloqueado</button>
        `}
        ${definition.latestExecution?.id ? `<button class="button ghost compact-button" type="button" data-job="${escapeHtml(definition.latestExecution.id)}">Ver evidencia</button>` : ""}
      </div>
    </article>
  `;
}

function testingTargetSummary(definition) {
  if (definition.target?.urls?.length) {
    return definition.target.urls.slice(0, 3).map((target) => target.url).join(" · ");
  }
  if (definition.target?.label) return definition.target.label;
  if (definition.target?.cwd) return `cwd=${definition.target.cwd}`;
  return definition.description || "Sin target ejecutable.";
}

function testingExecutionEvidence(report) {
  const executions = report.executions || [];
  if (!executions.length) {
    return `<article class="empty-state compact"><strong>Sin ejecuciones de Fase 5</strong><p class="muted">Ejecuta una definicion del catalogo para generar evidencia con commit, branch, parametros, logs y metricas.</p></article>`;
  }
  return `
    <h3>Evidencias recientes</h3>
    <div class="stage-list">
      ${executions.slice(0, 8).map((execution) => `
        <article class="stage">
          <span class="status ${statusClass(execution.status)}">${escapeHtml(execution.status)}</span>
          <strong>${escapeHtml(`${execution.testDefinitionName || execution.action} · ${execution.testType || execution.action}`)}</strong>
          <p class="muted">${escapeHtml(`${formatDate(execution.createdAt)} · ${execution.branch || "sin branch"} · ${shortSha(execution.commit) || "sin commit"}`)}</p>
          <button class="button secondary compact-button" data-job="${escapeHtml(execution.id)}" type="button">Ver job</button>
        </article>
      `).join("")}
    </div>
  `;
}

function testingFindingPanel(report) {
  const findings = report.findings || [];
  if (!findings.length) {
    return `<article class="empty-state compact"><strong>Sin brechas de pruebas abiertas</strong><p class="muted">El catalogo y sus guardrails no reportan hallazgos con las evidencias actuales.</p></article>`;
  }
  return `
    <h3>Brechas y guardrails</h3>
    <div class="stage-list">
      ${findings.slice(0, 10).map((finding) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <strong>${escapeHtml(finding.title || finding.code)}</strong>
          <p class="muted">${escapeHtml(finding.detail || finding.code)}</p>
          ${finding.evidence ? `<code>${escapeHtml(finding.evidence)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderLivingDocs(project) {
  const record = state.livingDocsByProject[project.id] || null;
  if (!record) queueMicrotask(() => loadProjectLivingDocs(project.id));
  return livingDocsPanel(project, record);
}

async function loadProjectLivingDocs(projectId) {
  const current = state.livingDocsByProject[projectId];
  if (current?.loading) return;
  if (current?.loadedAt && Date.now() - current.loadedAt < 15000) return;
  state.livingDocsByProject[projectId] = { loading: true };
  try {
    const data = await api(`/api/v1/projects/${projectId}/docs/overview`);
    state.livingDocsByProject[projectId] = { data, loadedAt: Date.now() };
  } catch (error) {
    state.livingDocsByProject[projectId] = { error: error.message, loadedAt: Date.now() };
  }
  if (state.selectedProject?.id === projectId && state.selectedTab === "docs") renderDashboard();
}

function livingDocsPanel(project, record) {
  if (!record || record.loading) {
    return `<article class="empty-state compact"><strong>Cargando documentacion viva...</strong><p class="muted">Generando guias, runbooks, diagramas, confianza e historial desde estado verificado.</p></article>`;
  }
  if (record.error) {
    return `<article class="empty-state compact danger-soft"><strong>No se pudo consultar Fase 12.</strong><p class="muted">${escapeHtml(record.error)}</p></article>`;
  }
  const report = record.data || {};
  const counts = report.counts || {};
  const confidence = report.confidence || {};
  return `
    <section class="focus-panel ${counts.findings ? "danger-soft" : ""}">
      <div>
        <span class="label">Fase 12 · Documentacion viva</span>
        <h3>${escapeHtml(report.status || "Sin datos")} · ${escapeHtml(confidence.label || "Sin confianza")}</h3>
        <p>${escapeHtml(`${report.contract || "living-documentation.v2"} · confianza ${confidence.score ?? 0}/100 · ${counts.documents || 0} docs · ${counts.verifiedSections || 0}/${counts.requiredSections || 0} secciones verificadas · ${counts.unverifiedSections || 0} pendientes`)}</p>
      </div>
      <div class="toolbar">
        <button class="button secondary compact-button" type="button" data-docs-action="refresh">Regenerar</button>
        <button class="button primary compact-button" type="button" data-docs-action="snapshot">Crear snapshot</button>
      </div>
    </section>
    ${livingDocsMetadataPanel(report)}
    ${livingDocsRequiredSectionPanel(report)}
    ${livingDocsDocumentPanel(report)}
    ${livingDocsOfficialDocsPanel(report)}
    ${livingDocsConfidencePanel(report)}
    ${livingDocsGuidePanel(report)}
    ${livingDocsRunbookPanel(report)}
    ${livingDocsDiagramPanel(report)}
    ${livingDocsHistoryPanel(report)}
    ${livingDocsInventoryPanel(report)}
    ${livingDocsFindingPanel(report)}
    <h3>Markdown generado</h3>
    <textarea class="prompt-output" rows="18" readonly>${escapeHtml(report.markdown || "")}</textarea>
    <p class="muted">Hash Markdown: ${escapeHtml(report.markdownHashShort || "sin hash")} · Hash evidencia: ${escapeHtml(report.sourceHashShort || "sin hash")} · Ultimo snapshot: ${escapeHtml(report.latestSnapshot?.exportPath || "sin snapshot exportado")}.</p>
  `;
}

function livingDocsMetadataPanel(report) {
  const firstDocument = (report.documents || [])[0] || {};
  const metadata = firstDocument.metadata || {};
  return `
    <h3>Metadata verificable</h3>
    <div class="metric-grid">
      ${metric("Commit de origen", metadata.generatedFromShortCommit || "Sin commit", metadata.generatedFromBranch || "sin rama")}
      ${metric("Infraestructura", metadata.infrastructureStatus || "Sin datos", formatDate(metadata.infrastructureVerifiedAt))}
      ${metric("Integraciones", metadata.integrationsVerifiedAt ? "Verificadas" : "Sin verificacion", formatDate(metadata.integrationsVerifiedAt))}
      ${metric("Docs oficiales", report.officialDocs?.status || "Sin registro", report.officialDocs?.consultedAt ? formatDate(report.officialDocs.consultedAt) : "sin consulta automatica")}
    </div>
  `;
}

function livingDocsRequiredSectionPanel(report) {
  const sections = report.requiredSections || [];
  if (!sections.length) {
    return `<article class="empty-state compact"><strong>Sin matriz Fase 12</strong><p class="muted">No se genero cobertura de secciones obligatorias.</p></article>`;
  }
  return `
    <h3>Cobertura obligatoria</h3>
    <div class="stage-list">
      ${sections.map((section) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(section.status)}">${escapeHtml(section.status)}</span>
          <strong>${escapeHtml(section.title)}</strong>
          <p class="muted">${escapeHtml(section.summary || "")}</p>
          <code>${escapeHtml(section.evidence || "sin evidencia")}</code>
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsDocumentPanel(report) {
  const documents = report.documents || [];
  if (!documents.length) {
    return `<article class="empty-state compact"><strong>Sin documentos por ambiente</strong><p class="muted">No se genero documentacion especifica para local, Docker Compose o proveedores.</p></article>`;
  }
  return `
    <h3>Documentos por ambiente y proveedor</h3>
    <div class="integration-grid">
      ${documents.map((doc) => {
        const metadata = doc.metadata || {};
        return `
          <article class="integration-card">
            <span class="label">${escapeHtml(`${doc.environment || "env"} · ${doc.provider || "provider"}`)}</span>
            <strong>${escapeHtml(doc.title || doc.id)}</strong>
            <p>${statusBadge(statusMeta(doc.status || "UNKNOWN", doc.status || "UNKNOWN", "", statusClass(doc.status), 1))}</p>
            <p class="muted">${escapeHtml(doc.summary || "Sin resumen.")}</p>
            <code>${escapeHtml(`commit=${metadata.generatedFromShortCommit || "sin commit"} branch=${metadata.generatedFromBranch || "sin rama"}`)}</code>
            <p class="muted">${escapeHtml(`infra=${metadata.infrastructureStatus || "UNKNOWN"} · no verificadas=${(metadata.unverifiedSections || []).length}`)}</p>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function livingDocsOfficialDocsPanel(report) {
  const officialDocs = report.officialDocs || {};
  const consulted = officialDocs.consulted || [];
  return `
    <h3>Documentacion oficial consultada</h3>
    <section class="focus-panel">
      <div>
        <span class="label">${escapeHtml(officialDocs.status || "Sin registro")}</span>
        <h3>${escapeHtml(consulted.length ? `${consulted.length} fuente(s)` : "Sin consulta automatica")}</h3>
        <p>${escapeHtml(officialDocs.policy || "La generacion usa evidencia local verificada y no inventa fuentes externas.")}</p>
      </div>
      <span class="status ${consulted.length ? "ok" : "info"}">${escapeHtml(officialDocs.consultedAt ? formatDate(officialDocs.consultedAt) : "sin fecha")}</span>
    </section>
  `;
}

function livingDocsConfidencePanel(report) {
  const signals = report.confidence?.signals || [];
  return `
    <h3>Confianza</h3>
    <div class="integration-grid">
      ${signals.map((signal) => `
        <article class="integration-card">
          <span class="label">${escapeHtml(signal.name)}</span>
          <strong>${escapeHtml(`${signal.score}/100`)}</strong>
          <p>${statusBadge(statusMeta(signal.status, signal.status, signal.evidence || "", statusToneFromIntegration(signal.status), 1))}</p>
          <p class="muted">${escapeHtml(signal.evidence || "Sin evidencia.")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsGuidePanel(report) {
  const guides = report.guides || [];
  if (!guides.length) return `<article class="empty-state compact"><strong>Sin guias generadas</strong><p class="muted">No hay suficiente estado verificado para generar guias especificas.</p></article>`;
  return `
    <h3>Guias vivas</h3>
    <div class="stage-list">
      ${guides.map((guide) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(guide.status)}">${escapeHtml(guide.status)}</span>
          <strong>${escapeHtml(guide.title)}</strong>
          <p class="muted">${escapeHtml(guide.summary || "")}</p>
          <ul class="compact-list">${(guide.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
          ${guide.evidence ? `<code>${escapeHtml(guide.evidence)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsRunbookPanel(report) {
  const runbooks = report.runbooks || [];
  if (!runbooks.length) return `<article class="empty-state compact"><strong>Sin runbooks generados</strong><p class="muted">No hay triggers operativos detectados.</p></article>`;
  return `
    <h3>Runbooks</h3>
    <div class="stage-list">
      ${runbooks.map((runbook) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(runbook.status)}">${escapeHtml(runbook.status)}</span>
          <strong>${escapeHtml(runbook.title)}</strong>
          <p class="muted">${escapeHtml(`Trigger: ${runbook.trigger || "manual"}`)}</p>
          <ul class="compact-list">${(runbook.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>
          ${runbook.evidence ? `<code>${escapeHtml(runbook.evidence)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsDiagramPanel(report) {
  const diagrams = report.diagrams || [];
  if (!diagrams.length) return "";
  return `
    <h3>Diagramas</h3>
    <div class="stage-list">
      ${diagrams.map((diagram) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(diagram.status)}">${escapeHtml(diagram.status)}</span>
          <strong>${escapeHtml(diagram.title)}</strong>
          <pre class="logs compact-log">${escapeHtml(diagram.code || "")}</pre>
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsHistoryPanel(report) {
  const entries = report.history?.entries || [];
  if (!entries.length) return `<article class="empty-state compact"><strong>Sin historial operativo</strong><p class="muted">Los snapshots, jobs, deployments y auditoria apareceran cuando existan eventos.</p></article>`;
  return `
    <h3>Historial</h3>
    <div class="stage-list">
      ${entries.slice(0, 12).map((entry) => `
        <article class="stage">
          <span class="status ${statusClass(entry.status)}">${escapeHtml(entry.type)}</span>
          <strong>${escapeHtml(`${entry.action} · ${entry.status}`)}</strong>
          <p class="muted">${escapeHtml(`${formatDate(entry.timestamp)} · ${entry.evidence || ""}`)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsInventoryPanel(report) {
  const inventory = report.inventory || {};
  const items = inventory.items || [];
  if (!items.length) return "";
  return `
    <h3>Inventario documental</h3>
    <div class="stage-list">
      ${items.slice(0, 12).map((item) => `
        <article class="stage">
          <span class="status ${statusClass(item.status)}">${escapeHtml(item.status)}</span>
          <strong>${escapeHtml(item.path)}</strong>
          <p class="muted">${escapeHtml(`${item.required ? "required" : "optional"} · ${item.evidence || ""}`)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function livingDocsFindingPanel(report) {
  const findings = report.findings || [];
  if (!findings.length) {
    return `<article class="empty-state compact"><strong>Sin findings de documentacion viva</strong><p class="muted">La documentacion generada no detecta brechas abiertas contra sus fuentes verificadas.</p></article>`;
  }
  return `
    <h3>Findings de documentacion</h3>
    <div class="stage-list">
      ${findings.slice(0, 10).map((finding) => `
        <article class="stage finding-stage">
          <span class="status ${statusClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <strong>${escapeHtml(finding.title || finding.code)}</strong>
          <p class="muted">${escapeHtml(finding.detail || finding.code)}</p>
          ${finding.evidence ? `<code>${escapeHtml(finding.evidence)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderConfiguration(project) {
  const commands = project.approvedCommands || [];
  const manifests = project.manifests || [];
  const runtimeConfig = project.runtimeConfig || {};
  return `
    <div class="metric-grid">
      ${metric("Repository path", project.repositoryPath, "Relativo a PROJECTS_ROOT")}
      ${metric("Sonar key", project.sonarProjectKey, "Clave estable")}
      ${metric("Branch", project.defaultBranch || "main", "Git")}
      ${metric("Estado", project.status, `Trust: ${project.trust || "UNTRUSTED"}`)}
    </div>
    ${setupHintList(project)}
    <h3>Variables de ejecucion</h3>
    <form class="settings-form" id="runtimeConfigForm">
      <div class="form-grid">
        <label>
          SONAR_HOST_URL
          <input name="sonarHostUrl" value="${escapeHtml(runtimeConfig.sonarHostUrl || "")}" placeholder="http://host.docker.internal:9000" />
        </label>
        <label>
          Trust de ejecucion
          <select name="projectTrust">
            ${option("UNTRUSTED", project.trust, "UNTRUSTED — solo discovery")}
            ${option("TRUSTED_LOCAL", project.trust, "TRUSTED_LOCAL — permite perfiles locales")}
          </select>
        </label>
        <label>
          JENKINS_URL
          <input name="jenkinsUrl" value="${escapeHtml(runtimeConfig.jenkinsUrl || "")}" placeholder="http://localhost:18082" />
        </label>
        <label>
          Jenkins multibranch job
          <input name="jenkinsJobName" value="${escapeHtml(runtimeConfig.jenkinsJobName || project.slug)}" placeholder="${escapeHtml(project.slug)}" />
        </label>
        <label>
          SONAR_SCAN_SCOPE
          <select name="sonarScanScope">
            ${option("stable", runtimeConfig.sonarScanScope, "stable")}
            ${option("backend", runtimeConfig.sonarScanScope, "backend")}
            ${option("frontend", runtimeConfig.sonarScanScope, "frontend")}
            ${option("full", runtimeConfig.sonarScanScope, "full")}
          </select>
        </label>
        <label>
          SONAR_SCANNER_MODE
          <select name="sonarScannerMode">
            ${option("cli", runtimeConfig.sonarScannerMode, "cli")}
            ${option("docker", runtimeConfig.sonarScannerMode, "docker")}
          </select>
        </label>
        <label>
          SONAR_JAVASCRIPT_NODE_MAXSPACE
          <input name="sonarJavascriptNodeMaxspace" value="${escapeHtml(runtimeConfig.sonarJavascriptNodeMaxspace || "6144")}" />
        </label>
        <label>
          SONAR_SCANNER_JAVA_OPTS
          <input name="sonarScannerJavaOpts" value="${escapeHtml(runtimeConfig.sonarScannerJavaOpts || "-Xmx1024m")}" />
        </label>
        <label>
          CI
          <select name="ci">
            ${option("true", runtimeConfig.ci, "true")}
            ${option("false", runtimeConfig.ci, "false")}
          </select>
        </label>
        <label class="span-2">
          Variables adicionales permitidas
          <textarea name="additionalEnv" rows="5" placeholder="MAVEN_OPTS=-Xmx2g&#10;GRADLE_OPTS=-Dorg.gradle.jvmargs=-Xmx2g">${escapeHtml(formatAdditionalEnv(runtimeConfig.additionalEnv || []))}</textarea>
        </label>
      </div>
      <p class="muted">SONAR_TOKEN se configura solo en el environment del backend. Las variables adicionales son no secretas; claves o valores con apariencia de credencial se rechazan. Los valores no publicos se muestran como [CONFIGURED]. Cambiar trust requiere rol ADMIN.</p>
      <div class="toolbar end">
        <button class="button primary" type="submit">Guardar configuracion</button>
      </div>
    </form>
    <h3>Configuration Doctor</h3>
    ${doctorList(project.doctor || [])}
    ${toolLinksPanel(project)}
    <h3>Templates aprobados</h3>
    ${commandList(commands)}
    <h3>Manifests detectados</h3>
    ${pathList(manifests.slice(0, 40), "Sin manifests detectados.")}
    ${manifests.length > 40 ? `<p class="muted">+${manifests.length - 40} manifests adicionales.</p>` : ""}
  `;
}

function bindDashboardActions() {
  for (const button of els.tabContent.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => startExecution(button.dataset.action));
  }
  for (const button of els.tabContent.querySelectorAll("[data-runtime-action]")) {
    button.addEventListener("click", () => runRuntimeAction(button.dataset.runtimeAction));
  }
  for (const button of els.tabContent.querySelectorAll("[data-version-action]")) {
    button.addEventListener("click", () => runVersionAction(button.dataset.versionAction));
  }
  for (const button of els.tabContent.querySelectorAll("[data-job]")) {
    button.addEventListener("click", () => watchJob(button.dataset.job));
  }
  for (const button of els.tabContent.querySelectorAll("[data-test-definition]")) {
    button.addEventListener("click", () => startTestingExecution(button.dataset.testDefinition));
  }
  for (const button of els.tabContent.querySelectorAll("[data-deployment-action]")) {
    button.addEventListener("click", () => runDeploymentAction(button.dataset.deploymentAction));
  }
  for (const button of els.tabContent.querySelectorAll("[data-infrastructure-action]")) {
    button.addEventListener("click", () => runInfrastructureAction(button.dataset.infrastructureAction));
  }
  for (const button of els.tabContent.querySelectorAll("[data-docs-action]")) {
    button.addEventListener("click", () => runLivingDocsAction(button.dataset.docsAction));
  }
  for (const button of els.tabContent.querySelectorAll("[data-project-intent]")) {
    button.addEventListener("click", () => runProjectIntent(button.dataset.projectIntent, button.dataset.intentKind, button.dataset.intentValue));
  }
  const settingsForm = els.tabContent.querySelector("#runtimeConfigForm");
  if (settingsForm) {
    settingsForm.addEventListener("submit", saveRuntimeConfig);
  }
  const refreshLogsButton = els.tabContent.querySelector("[data-runtime-log-refresh]");
  if (refreshLogsButton) refreshLogsButton.addEventListener("click", refreshRuntimeLogs);
  const clearLogsButton = els.tabContent.querySelector("[data-runtime-log-clear]");
  if (clearLogsButton) clearLogsButton.addEventListener("click", clearRuntimeLogs);
  const downloadLogsButton = els.tabContent.querySelector("[data-runtime-log-download]");
  if (downloadLogsButton) downloadLogsButton.addEventListener("click", downloadRuntimeLogs);
  const validateLinksButton = els.tabContent.querySelector("[data-validate-links]");
  if (validateLinksButton) validateLinksButton.addEventListener("click", validateProjectLinks);
}

function projectModel(project) {
  const status = deriveProjectStatus(project);
  const intent = recommendedIntent(project, status);
  const runtime = project.localRuntime || {};
  return {
    project,
    status,
    intent,
    selected: state.selectedProject?.id === project.id,
    qualityGate: project.latestSnapshot?.qualityGate || "Sin datos",
    coverage: formatCoverage(project.latestSnapshot?.metrics?.coverage),
    lastAnalysis: project.latestSnapshot?.analysisTimestamp ? formatDate(project.latestSnapshot.analysisTimestamp) : project.latestJob?.createdAt ? formatDate(project.latestJob.createdAt) : "Pendiente",
    alerts: "Sin datos",
    logs: "Sin datos",
    runtimeState: runtime.label || runtimeState(project)
  };
}

function deriveProjectStatus(project) {
  const doctor = project.doctor || [];
  const latestJob = project.latestJob;
  const gate = String(project.latestSnapshot?.qualityGate || "").toUpperCase();
  const hasSonar = Boolean(project.sonarProjectKey) && (project.approvedCommands || []).some((command) => command.action === "sonar");
  const errors = doctor.filter((item) => item.level === "error");
  const warnings = doctor.filter((item) => item.level === "warn");
  const failure = jobFailureInsight(latestJob);
  const runtime = project.localRuntime || {};

  if (latestJob && ["RUNNING", "QUEUED"].includes(latestJob.status)) {
    return statusMeta("running", "Running", "Hay una ejecucion en curso.", "info", 2);
  }
  if (["starting", "stopping", "restarting"].includes(runtime.status)) {
    return statusMeta("running", runtime.label || "Running", runtime.explanation || "Hay una accion local en curso.", "info", 2);
  }
  if (runtime.status === "stale") {
    return statusMeta("stale_runtime", "Runtime obsoleto", runtime.explanation || "El codigo local cambio desde el ultimo deploy registrado.", "error", 5);
  }
  if (runtime.freshness?.status === "unverified") {
    return statusMeta("unverified_runtime", "Runtime sin evidencia", runtime.freshness.message || "Hay runtime activo sin fingerprint de deploy registrado.", "warn", 4);
  }
  if (["error", "degraded"].includes(runtime.status)) {
    return statusMeta("critical", "Critical", runtime.explanation || "El entorno local reporta errores.", "error", 5);
  }
  if (project.status && project.status !== "ACTIVE") {
    return statusMeta("offline", "Offline", "El registry no marca el proyecto como activo.", "error", 5);
  }
  if (errors.length) {
    return statusMeta("critical", "Critical", errors[0].message || "Doctor reporto errores.", "error", 5);
  }
  if (gate && !["OK", "NONE", "SIN DATOS", "UNKNOWN"].includes(gate)) {
    return statusMeta("critical", "Critical", `Quality Gate ${gate}.`, "error", 5);
  }
  if (failure?.kind === "sonar-auth" || failure?.kind === "configuration") {
    return statusMeta("not_configured", "Not configured", failure.explanation, "warn", 4);
  }
  if (!hasSonar) {
    return statusMeta("not_configured", "Not configured", "Falta configuracion SonarQube ejecutable.", "warn", 4);
  }
  if (warnings.length) {
    return statusMeta("warning", "Warning", warnings[0].message || "Hay advertencias de configuracion.", "warn", 3);
  }
  if (failure) {
    return statusMeta("warning", "Warning", failure.explanation, "warn", 3);
  }
  if (!project.latestSnapshot) {
    return statusMeta("analysis_pending", "Analysis pending", "Todavia no hay snapshot real importado desde SonarQube.", "warn", 2);
  }
  return statusMeta("healthy", "Healthy", "Sin brechas bloqueantes detectadas.", "ok", 0);
}

function statusMeta(key, label, explanation, tone, rank) {
  return { key, label, explanation, tone, rank };
}

function recommendedIntent(project, status) {
  const warnings = (project.doctor || []).filter((item) => item.level === "warn" || item.level === "error");
  const failure = jobFailureInsight(project.latestJob);
  const runtime = project.localRuntime || {};
  if (runtime.status === "stale") {
    return { kind: "execute-runtime", value: "start", button: "Start", label: "Runtime obsoleto", reason: runtime.explanation || "El codigo local cambio desde el ultimo deploy." };
  }
  if (runtime.freshness?.status === "unverified") {
    return { kind: "execute-runtime", value: "start", button: "Registrar deploy fresco", label: "Runtime sin evidencia", reason: runtime.freshness.message || "Hay runtime activo sin fingerprint de deploy registrado." };
  }
  if (["error", "degraded", "unavailable"].includes(runtime.status)) {
    return { kind: "tab", value: "environment", button: "Revisar entorno", label: "Resolver runtime local", reason: runtime.explanation || "El entorno local requiere atencion." };
  }
  if (status.key === "running") {
    return { kind: "tab", value: "executions", button: "Ver ejecucion", label: "Monitorear ejecucion", reason: "Hay un job activo o en cola." };
  }
  if (status.key === "critical") {
    return { kind: "tab", value: "quality", button: "Revisar calidad", label: "Resolver riesgo critico", reason: status.explanation };
  }
  if (status.key === "not_configured") {
    return { kind: "tab", value: "configuration", button: "Configurar variables", label: "Completar setup", reason: status.explanation };
  }
  if (failure) {
    return {
      kind: "tab",
      value: failure.kind === "sonar-auth" || failure.kind === "configuration" ? "configuration" : "executions",
      button: failure.cta,
      label: failure.title,
      reason: failure.explanation
    };
  }
  if (warnings.length) {
    return { kind: "tab", value: "configuration", button: "Ver brechas", label: "Completar configuracion", reason: warnings[0].message };
  }
  if (!project.latestSnapshot) {
    return { kind: "execute", value: "full", button: "Ejecutar analisis", label: "Generar primer snapshot", reason: "No hay datos reales de Quality Gate, cobertura o issues." };
  }
  return { kind: "tab", value: "overview", button: "Abrir resumen", label: "Revisar evolucion", reason: "El proyecto esta listo para seguimiento operativo." };
}

function matchesCurrentFilters(model) {
  const haystack = [
    model.project.displayName,
    model.project.repositoryPath,
    model.project.sonarProjectKey,
    model.project.status,
    model.status.label,
    model.project.localRuntime?.label,
    model.project.localRuntime?.status,
    ...(model.project.detectedStack || [])
  ].join(" ").toLowerCase();
  if (state.query && !haystack.includes(state.query)) return false;
  if (state.filter === "healthy") return model.status.key === "healthy";
  if (state.filter === "warning") return ["warning", "analysis_pending", "not_configured", "running", "unverified_runtime"].includes(model.status.key);
  if (state.filter === "critical") return ["critical", "analysis_failed", "offline", "stale_runtime"].includes(model.status.key);
  if (state.filter === "pending") return ["analysis_pending", "not_configured"].includes(model.status.key);
  return true;
}

function summaryCounts(models) {
  return models.reduce((acc, model) => {
    if (model.status.key === "healthy") acc.healthy += 1;
    if (["warning", "analysis_pending", "not_configured", "running", "unverified_runtime"].includes(model.status.key)) acc.warning += 1;
    if (["critical", "analysis_failed", "offline", "stale_runtime"].includes(model.status.key)) acc.critical += 1;
    if (["analysis_pending", "not_configured"].includes(model.status.key)) acc.pending += 1;
    return acc;
  }, { healthy: 0, warning: 0, critical: 0, pending: 0 });
}

function selectTab(tabName) {
  state.selectedTab = tabName;
  for (const button of document.querySelectorAll("[role='tab'][data-tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tabName));
  }
  renderDashboard();
}

function openProject(projectId) {
  state.selectedProject = state.projects.find((project) => project.id === projectId) || state.selectedProject;
  state.detailOpen = true;
  if (!["overview", "environment", "quality", "terminal", "executions", "docs", "configuration"].includes(state.selectedTab)) {
    state.selectedTab = "overview";
  }
  renderWorkspace();
  renderDashboard();
  els.projectDetail.focus?.();
}

function closeProjectDetail() {
  state.detailOpen = false;
  stopRuntimeLogPolling();
  renderWorkspace();
  renderDashboard();
}

function runProjectIntent(projectId, kind, value) {
  const project = state.projects.find((item) => item.id === projectId);
  if (project) state.selectedProject = project;
  state.detailOpen = true;
  renderWorkspace();
  renderDashboard();
  if (kind === "execute") {
    startExecution(value);
    return;
  }
  if (kind === "execute-runtime") {
    runRuntimeAction(value || "start");
    return;
  }
  if (kind === "external") {
    window.open(value, "_blank", "noreferrer");
    return;
  }
  selectTab(value || "overview");
}

async function saveRuntimeConfig(event) {
  event.preventDefault();
  const project = state.selectedProject;
  if (!project) return;
  const form = new FormData(event.currentTarget);
  const runtimeConfig = {
    sonarHostUrl: String(form.get("sonarHostUrl") || "").trim(),
    jenkinsUrl: String(form.get("jenkinsUrl") || "").trim(),
    jenkinsJobName: String(form.get("jenkinsJobName") || "").trim(),
    sonarScanScope: String(form.get("sonarScanScope") || "stable"),
    sonarScannerMode: String(form.get("sonarScannerMode") || "cli"),
    sonarJavascriptNodeMaxspace: String(form.get("sonarJavascriptNodeMaxspace") || "6144").trim(),
    sonarScannerJavaOpts: String(form.get("sonarScannerJavaOpts") || "-Xmx1024m").trim(),
    ci: String(form.get("ci") || "true"),
    additionalEnv: parseAdditionalEnv(String(form.get("additionalEnv") || ""))
  };
  const trust = String(form.get("projectTrust") || project.trust || "UNTRUSTED");

  try {
    const updated = await api(`/api/v1/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ runtimeConfig, trust })
    });
    state.selectedProject = updated;
    toast("Configuracion guardada");
    await loadProjects();
    selectTab("configuration");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runAgentAction(action) {
  try {
    if (action === "heartbeat") {
      await api("/api/v1/agents/heartbeat", {
        method: "POST",
        body: JSON.stringify({ evidence: "ui heartbeat" })
      });
      await loadLocalAgent({ silent: true });
      renderWorkspace();
      toast("Heartbeat del agente registrado");
      return;
    }
    if (action === "refresh") {
      const result = await api("/api/v1/agents/discovery/refresh", {
        method: "POST",
        body: JSON.stringify({})
      });
      await loadLocalAgent({ silent: true });
      await loadProjects();
      toast(result.snapshot?.sourceHashShort ? `Discovery del agente ${result.snapshot.sourceHashShort}` : "Discovery del agente actualizado");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function startExecution(action) {
  const project = state.selectedProject;
  if (!project) return;
  try {
    const job = await api(`/api/v1/projects/${project.id}/executions`, {
      method: "POST",
      headers: { "Idempotency-Key": `${project.id}-${action}-${Date.now()}` },
      body: JSON.stringify({ action })
    });
    toast(`Job ${action} iniciado`);
    watchJob(job.id);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function startTestingExecution(definitionId) {
  const project = state.selectedProject;
  if (!project || !definitionId) return;
  try {
    const job = await api(`/api/v1/projects/${project.id}/testing/executions`, {
      method: "POST",
      headers: { "Idempotency-Key": `${project.id}-${definitionId}-${Date.now()}` },
      body: JSON.stringify({ definitionId })
    });
    delete state.testingByProject[project.id];
    toast("Prueba iniciada desde catalogo");
    watchJob(job.id);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runDeploymentAction(action) {
  const project = state.selectedProject;
  if (!project) return;
  const report = state.deploymentsByProject[project.id]?.data || {};
  const latestPlan = report.latestPlan || null;
  const latestRecord = report.latestRecord || null;
  const refreshDeployments = async (delayMs = 0) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    delete state.deploymentsByProject[project.id];
    delete state.livingDocsByProject[project.id];
    await Promise.all([
      loadProjectDeployments(project.id),
      loadProjects()
    ]);
  };

  try {
    if (action === "plan-smart" || action === "plan-rebuild") {
      const strategy = action === "plan-rebuild" ? "rebuild" : "smart";
      await api(`/api/v1/projects/${project.id}/deployments/plan`, {
        method: "POST",
        body: JSON.stringify({ environment: "local", strategy })
      });
      toast("Plan de despliegue generado");
      await refreshDeployments();
      return;
    }
    if (action === "approve") {
      if (!latestPlan?.id) throw new Error("No hay plan para aprobar");
      await api(`/api/v1/projects/${project.id}/deployments/plans/${latestPlan.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ reason: "Aprobado desde UI local Fase 6" })
      });
      toast("Apply aprobado");
      await refreshDeployments();
      return;
    }
    if (action === "apply") {
      if (!latestPlan?.id) throw new Error("No hay plan aprobado para apply");
      await api(`/api/v1/projects/${project.id}/deployments/plans/${latestPlan.id}/apply`, { method: "POST" });
      toast("Apply encolado");
      await refreshDeployments(2500);
      return;
    }
    if (action === "verify") {
      await api(`/api/v1/projects/${project.id}/deployments/verify`, {
        method: "POST",
        body: JSON.stringify({ recordId: latestRecord?.id || "" })
      });
      toast("Verificacion de despliegue registrada");
      await refreshDeployments();
      return;
    }
    if (action === "rollback") {
      await api(`/api/v1/projects/${project.id}/deployments/rollback`, {
        method: "POST",
        body: JSON.stringify({ recordId: latestRecord?.id || "" })
      });
      toast("Rollback solicitado");
      await refreshDeployments(2500);
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runInfrastructureAction(action) {
  const project = state.selectedProject;
  if (!project) return;
  try {
    if (action === "refresh") {
      const result = await api(`/api/v1/projects/${project.id}/infrastructure/refresh`, {
        method: "POST",
        body: JSON.stringify({ adapter: "all" })
      });
      delete state.infrastructureByProject[project.id];
      delete state.livingDocsByProject[project.id];
      await Promise.all([
        loadProjectInfrastructure(project.id),
        loadImprovements({ silent: true })
      ]);
      toast(result.discoveryCache?.sourceHashShort ? `Discovery refrescado ${result.discoveryCache.sourceHashShort}` : "Discovery refrescado");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runLivingDocsAction(action) {
  const project = state.selectedProject;
  if (!project) return;
  try {
    if (action === "refresh") {
      delete state.livingDocsByProject[project.id];
      await loadProjectLivingDocs(project.id);
      toast("Documentacion viva regenerada");
      return;
    }
    if (action === "snapshot") {
      const result = await api(`/api/v1/projects/${project.id}/docs/snapshot`, {
        method: "POST",
        body: JSON.stringify({ export: true })
      });
      delete state.livingDocsByProject[project.id];
      await loadProjectLivingDocs(project.id);
      toast(result.exportPath ? `Snapshot exportado en ${result.exportPath}` : "Snapshot registrado");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runRuntimeAction(action) {
  const project = state.selectedProject;
  if (!project) return;
  await runRuntimeActionForProject(project.id, action, { openTab: action === "stop" ? "environment" : "terminal" });
}

async function runRuntimeActionForProject(projectId, action, options = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  try {
    const runtime = await api(`/api/v1/projects/${project.id}/runtime/${action}`, {
      method: "POST"
    });
    const updatedProject = { ...project, localRuntime: runtime };
    state.projects = state.projects.map((item) => item.id === project.id ? updatedProject : item);
    if (state.selectedProject?.id === project.id || options.openTab) state.selectedProject = updatedProject;
    delete state.infrastructureByProject[project.id];
    delete state.versionsByProject[project.id];
    delete state.livingDocsByProject[project.id];
    toast(`Runtime ${action} iniciado`);
    await loadProjects();
    await loadImprovements({ silent: true });
    if (options.openTab) openProjectTab(project.id, options.openTab);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runVersionAction(action) {
  const project = state.selectedProject;
  if (!project) return;
  if (action === "view-changes") {
    await loadProjectVersions(project.id, { force: true });
    toast("Cambios detectados actualizados");
    return;
  }
  await runRuntimeActionForProject(project.id, action, { openTab: action === "stop" ? "environment" : "terminal" });
}

function runProjectMenuAction(projectId, action) {
  closeProjectMenus();
  if (["start", "restart", "rebuild-changed", "clean-rebuild", "pull-rebuild", "stop", "start-fresh"].includes(action)) {
    runRuntimeActionForProject(projectId, action);
    return;
  }
  if (action === "view-changes") {
    openProjectTab(projectId, "environment");
    loadProjectVersions(projectId, { force: true });
    return;
  }
  if (["terminal", "configuration"].includes(action)) {
    openProjectTab(projectId, action);
  }
}

async function copyFingerprint(value) {
  if (!value) {
    toast("No hay fingerprint disponible");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast("Fingerprint copiado");
  } catch {
    toast(`Fingerprint: ${value}`);
  }
}

async function runBulkRuntimeAction(action) {
  try {
    setBulkButtonsDisabled(true);
    const operation = await api(`/api/v1/runtime/${action}-all`, { method: "POST" });
    state.bulkOperation = operation;
    toast(`${runtimeActionProgressLabel(operation.action)} ${operation.summary?.total || 0} proyectos`);
    renderWorkspace();
    await loadProjects();
    pollBulkRuntimeOperation(operation.id);
  } catch (error) {
    setBulkButtonsDisabled(false);
    toast(error.message, "error");
  }
}

async function validateProjectLinks() {
  const project = state.selectedProject;
  if (!project) return;
  try {
    const result = await api(`/api/v1/projects/${project.id}/links/validate`, { method: "POST" });
    const updatedProject = { ...project, toolLinks: result.items || project.toolLinks || [] };
    state.selectedProject = updatedProject;
    state.projects = state.projects.map((item) => item.id === project.id ? updatedProject : item);
    toast("Links validados");
    renderWorkspace();
    renderDashboard();
  } catch (error) {
    toast(error.message, "error");
  }
}

function pollBulkRuntimeOperation(id) {
  if (state.bulkTimer) clearInterval(state.bulkTimer);
  refreshBulkRuntimeOperation(id);
  state.bulkTimer = setInterval(() => refreshBulkRuntimeOperation(id), 3500);
}

async function refreshBulkRuntimeOperation(id) {
  if (!id) return;
  try {
    const operation = await api(`/api/v1/runtime/bulk/${id}`);
    state.bulkOperation = operation;
    setBulkButtonsDisabled(operation.status === "RUNNING");
    await loadProjects();
    await loadImprovements({ silent: true });
    if (operation.status !== "RUNNING") {
      if (state.bulkTimer) clearInterval(state.bulkTimer);
      state.bulkTimer = null;
      const failed = operation.summary?.failed || 0;
      toast(failed ? `Bulk finalizado con ${failed} fallo(s)` : "Bulk finalizado");
    }
  } catch (error) {
    setBulkButtonsDisabled(false);
    toast(error.message, "error");
  }
}

function setBulkButtonsDisabled(disabled) {
  if (els.startAllRuntimeButton) els.startAllRuntimeButton.disabled = disabled;
  if (els.rebuildAllRuntimeButton) els.rebuildAllRuntimeButton.disabled = disabled;
  if (els.stopAllRuntimeButton) els.stopAllRuntimeButton.disabled = disabled;
}

function runtimeActionProgressLabel(action) {
  if (action === "start") return "Levantando";
  if (action === "rebuild-changed") return "Reconstruyendo cambios";
  if (action === "clean-rebuild") return "Reconstruyendo limpio";
  if (action === "pull-rebuild") return "Actualizando y reconstruyendo";
  if (action === "start-fresh") return "Reconstruyendo y levantando";
  if (action === "restart-fresh") return "Reconstruyendo y reiniciando";
  if (action === "restart") return "Reiniciando";
  if (action === "smoke") return "Validando";
  return "Deteniendo";
}

function runtimeActionDisplayLabel(action) {
  if (action === "start") return "Start todos";
  if (action === "rebuild-changed") return "Rebuild changed components todos";
  if (action === "clean-rebuild") return "Clean rebuild todos";
  if (action === "pull-rebuild") return "Pull and rebuild todos";
  if (action === "start-fresh") return "Legacy fresh rebuild todos";
  if (action === "restart-fresh") return "Reconstruir y reiniciar todos";
  if (action === "restart") return "Restart todos";
  if (action === "smoke") return "Validar todos";
  if (action === "stop") return "Stop todos";
  return `${action} todos`;
}

function bulkRuntimeSummary(operation) {
  const summary = operation.summary || {};
  const current = operation.currentProjectSlug ? `Actual: ${operation.currentProjectSlug}. ` : "";
  return `${current}${summary.succeeded || 0} ok · ${summary.failed || 0} fallos · ${summary.skipped || 0} omitidos · ${summary.total || 0} total`;
}

function startRuntimeLogPolling() {
  if (state.runtimeLogTimer) return;
  refreshRuntimeLogs();
  state.runtimeLogTimer = setInterval(refreshRuntimeLogs, 3500);
}

function stopRuntimeLogPolling() {
  if (!state.runtimeLogTimer) return;
  clearInterval(state.runtimeLogTimer);
  state.runtimeLogTimer = null;
}

async function refreshRuntimeLogs() {
  const project = state.selectedProject;
  if (!project || !state.detailOpen || state.selectedTab !== "terminal") return;
  try {
    const data = await api(`/api/v1/projects/${project.id}/runtime/logs?tail=360`);
    state.runtimeLogText = (data.lines || []).join("\n") || "Sin logs del runtime local.";
    const output = document.querySelector("#runtimeLogs");
    if (output) {
      output.textContent = state.runtimeLogText;
      output.scrollTop = output.scrollHeight;
    }
  } catch (error) {
    state.runtimeLogText = `No se pudieron cargar logs: ${error.message}`;
    const output = document.querySelector("#runtimeLogs");
    if (output) output.textContent = state.runtimeLogText;
  }
}

async function clearRuntimeLogs() {
  const project = state.selectedProject;
  if (!project) return;
  try {
    await api(`/api/v1/projects/${project.id}/runtime/logs/clear`, { method: "POST" });
    state.runtimeLogText = "Consola limpiada. Los logs nuevos apareceran aca.";
    const output = document.querySelector("#runtimeLogs");
    if (output) output.textContent = state.runtimeLogText;
  } catch (error) {
    toast(error.message, "error");
  }
}

function downloadRuntimeLogs() {
  const project = state.selectedProject;
  const blob = new Blob([state.runtimeLogText || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project?.slug || "runtime"}-container-log.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyImprovementPrompt() {
  const value = state.improvements?.promptMarkdown || els.improvementPrompt?.value || "";
  if (!value) {
    toast("No hay prompt generado");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast("Prompt maestro copiado");
  } catch {
    els.improvementPrompt?.focus();
    els.improvementPrompt?.select();
    toast("Prompt seleccionado para copiar");
  }
}

function downloadImprovementPrompt() {
  const value = state.improvements?.promptMarkdown || els.improvementPrompt?.value || "";
  if (!value) {
    toast("No hay prompt generado");
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const scope = state.improvements?.scope === "project"
    ? state.improvements?.projectSummaries?.[0]?.slug || "project"
    : "all-projects";
  const blob = new Blob([value], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `engineering-control-center-improvements-${scope}-${date}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function watchJob(jobId) {
  closeJobDrawer();
  els.jobDrawer.hidden = false;
  state.activeJobSource = new EventSource(`${API_BASE}/api/v1/executions/${jobId}/events`);
  state.activeJobSource.addEventListener("job", (event) => {
    const job = JSON.parse(event.data);
    renderJob(job);
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)) {
      state.activeJobSource.close();
      state.activeJobSource = null;
      loadProjects();
      loadImprovements({ silent: true });
      if (job.projectId) {
        delete state.infrastructureByProject[job.projectId];
        delete state.testingByProject[job.projectId];
        delete state.livingDocsByProject[job.projectId];
        loadProjectInfrastructure(job.projectId).catch(() => {});
        loadProjectTesting(job.projectId).catch(() => {});
      }
    }
  });
}

function renderJob(job) {
  els.jobTitle.textContent = `${job.projectSlug} · ${job.action} · ${job.status}`;
  const digest = jobDigest(job);
  els.jobStages.innerHTML = (job.stages || []).map((stage) => `
    <article class="stage">
      <span class="status ${statusClass(stage.status)}">${escapeHtml(stage.status)}</span>
      <strong>${escapeHtml(stage.name)}</strong>
      <p class="muted">${escapeHtml(stage.durationMs ? `${stage.durationMs} ms` : "en curso")}${stage.summary ? ` · ${escapeHtml(summaryLine(stage.summary))}` : ""}</p>
    </article>
  `).join("");
  els.jobSummary.innerHTML = renderJobDigest(digest);
  els.jobLogs.textContent = (job.logs || []).map((entry) => `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}`).join("\n");
  els.jobLogs.scrollTop = els.jobLogs.scrollHeight;
}

function closeJobDrawer() {
  if (state.activeJobSource) {
    state.activeJobSource.close();
    state.activeJobSource = null;
  }
  els.jobDrawer.hidden = true;
}

function jobDigest(job) {
  const failedStage = [...(job.stages || [])].reverse().find((stage) => stage.status === "FAILED");
  const stageSummary = job.summary?.failure?.output || failedStage?.summary || null;
  const logs = job.logs || [];
  const text = logs.map((entry) => entry.message).join("\n");
  const eslintTotals = text.match(/([0-9,]+)\s+problems?\s+\(([0-9,]+)\s+errors?,\s+([0-9,]+)\s+warnings?\)/i);
  const fallbackRules = countRulesFromLogs(logs);
  const errors = stageSummary?.errors || (eslintTotals ? numberFromText(eslintTotals[2]) : logs.filter((entry) => /error|failed|failure/i.test(entry.message)).length);
  const warnings = stageSummary?.warnings || (eslintTotals ? numberFromText(eslintTotals[3]) : logs.filter((entry) => entry.level === "warn" || /warning|warn/i.test(entry.message)).length);
  const categories = stageSummary?.categories || [];
  const topRules = stageSummary?.topRules?.length ? stageSummary.topRules : fallbackRules;
  return {
    title: failedStage ? `Fallo en ${failedStage.name}` : job.status === "SUCCEEDED" ? "Ejecucion completada" : `Ejecucion ${job.status}`,
    status: job.status,
    action: failedStage?.action || job.action,
    exitCode: failedStage?.exitCode ?? job.exitCode,
    errors,
    warnings,
    categories,
    topRules,
    firstProblems: stageSummary?.firstProblems || logs.filter((entry) => /error|failed|failure|SONAR_TOKEN|not authorized/i.test(entry.message)).slice(0, 8).map((entry) => entry.message),
    logLines: logs.length
  };
}

function renderJobDigest(digest) {
  return `
    <section class="job-digest">
      <div class="digest-header">
        <div>
          <span class="status ${statusClass(digest.status)}">${escapeHtml(digest.status)}</span>
          <h3>${escapeHtml(digest.title)}</h3>
          <p class="muted">${escapeHtml(digest.exitCode === null || digest.exitCode === undefined ? "Sin exit code todavia" : `Exit code ${digest.exitCode}`)}</p>
        </div>
      </div>
      <div class="digest-metrics">
        ${metric("Errores", String(digest.errors || 0), "Resumen del output")}
        ${metric("Advertencias", String(digest.warnings || 0), "Resumen del output")}
        ${metric("Lineas capturadas", String(digest.logLines || 0), "Log sanitizado")}
      </div>
      ${digest.topRules?.length ? `<h4>Reglas mas repetidas</h4><div class="rule-list">${digest.topRules.map((item) => `<span><strong>${escapeHtml(item.count)}</strong> ${escapeHtml(item.rule)}</span>`).join("")}</div>` : ""}
      ${digest.categories?.length ? `<h4>Categorias detectadas</h4><div class="rule-list">${digest.categories.map((item) => `<span><strong>${escapeHtml(item.count)}</strong> ${escapeHtml(item.category)}</span>`).join("")}</div>` : ""}
      ${digest.firstProblems?.length ? `<h4>Primeros problemas</h4><div class="problem-list">${digest.firstProblems.slice(0, 8).map((line) => `<code>${escapeHtml(line)}</code>`).join("")}</div>` : ""}
    </section>
  `;
}

function countRulesFromLogs(logs) {
  const counts = new Map();
  for (const entry of logs) {
    const eslintRule = String(entry.message || "").match(/\s(?:error|warning)\s+.+?\s+([@a-z0-9][@a-z0-9-]*(?:\/[a-z0-9-]+){1,2})\s*$/i);
    const tsRule = String(entry.message || "").match(/\b(TS[0-9]{4})\b/);
    const rule = eslintRule?.[1] || tsRule?.[1];
    if (rule) counts.set(rule, (counts.get(rule) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rule, count]) => ({ rule, count }));
}

function openProjectDialog() {
  els.discoverPreview.innerHTML = "";
  els.projectForm.reset();
  renderSetupChecklist();
  els.projectDialog.showModal();
}

async function discoverProject() {
  const form = new FormData(els.projectForm);
  const repositoryPath = String(form.get("repositoryPath") || "").trim();
  try {
    const data = await api("/api/v1/projects/discover", {
      method: "POST",
      body: JSON.stringify({ repositoryPath })
    });
    const displayNameInput = els.projectForm.elements.displayName;
    const slugInput = els.projectForm.elements.slug;
    const sonarInput = els.projectForm.elements.sonarProjectKey;
    if (!displayNameInput.value) displayNameInput.value = titleFromSlug(repositoryPath.split("/").filter(Boolean).pop() || repositoryPath);
    if (!slugInput.value) slugInput.value = slugify(repositoryPath.split("/").filter(Boolean).pop() || repositoryPath);
    if (!sonarInput.value && data.sonarProjectKey) sonarInput.value = data.sonarProjectKey;
    renderSetupChecklist(data);
    els.discoverPreview.innerHTML = `
      <div class="preview-card">
        <strong>Stack detectado</strong>
        <p>${escapeHtml((data.detectedStack || []).join(", ") || "sin stack")}</p>
        <strong>Templates aprobados</strong>
        <p>${escapeHtml(String((data.approvedCommands || []).length))}</p>
      </div>
    `;
  } catch (error) {
    els.discoverPreview.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
  }
}

async function saveProject(event) {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(els.projectForm).entries());
  try {
    await api("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify(form)
    });
    els.projectDialog.close();
    toast("Proyecto registrado");
    await loadProjects();
  } catch (error) {
    els.discoverPreview.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
  }
}

function renderSetupChecklist(discovered = null) {
  const instrumentation = discovered?.instrumentation || {};
  const doctor = discovered?.doctor || [];
  const steps = [
    ["Seleccionar carpeta", Boolean(discovered), "La ruta queda limitada a PROJECTS_ROOT."],
    ["Detectar stack tecnologico", Boolean(discovered?.detectedStack?.length), (discovered?.detectedStack || []).join(", ") || "Pendiente"],
    ["Detectar Docker y servicios", Boolean((discovered?.detectedStack || []).includes("docker")), "Busca Dockerfile y compose."],
    ["Detectar repositorio Git", Boolean(discovered?.git?.isGit), discovered?.git?.branch || "Pendiente"],
    ["Validar SonarQube", Boolean(discovered?.sonarProjectKey || (discovered?.approvedCommands || []).some((cmd) => cmd.action === "sonar")), discovered?.sonarProjectKey || "Pendiente"],
    ["Validar instrumentacion", Boolean(instrumentation.health?.length || instrumentation.metrics?.length || instrumentation.logs?.length || instrumentation.traces?.length), "Health, metrics, logs o traces."],
    ["Detectar endpoints de salud", Boolean(instrumentation.health?.length), (instrumentation.health || []).join("; ") || "Sin datos"],
    ["Detectar metricas", Boolean(instrumentation.metrics?.length), (instrumentation.metrics || []).join("; ") || "Sin datos"],
    ["Detectar logs/trazas", Boolean(instrumentation.logs?.length || instrumentation.traces?.length), [...(instrumentation.logs || []), ...(instrumentation.traces || [])].join("; ") || "Sin datos"],
    ["Mostrar configuraciones faltantes", Boolean(discovered), doctor.filter((item) => item.level !== "ok").map((item) => item.code).join(", ") || "Sin brechas bloqueantes"],
    ["Aplicar configuraciones automaticamente", false, "Disponible mediante scripts y overrides revisados."],
    ["Ejecutar primera validacion", false, "Correr Doctor o analisis completo al finalizar."]
  ];
  els.setupChecklist.innerHTML = steps.map(([label, ok, detail]) => `
    <article class="setup-step">
      <span class="status ${ok ? "ok" : "warn"}">${ok ? "OK" : "Pendiente"}</span>
      <div>
        <strong>${escapeHtml(label)}</strong>
        <p class="muted">${escapeHtml(detail)}</p>
      </div>
    </article>
  `).join("");
}

function openCommandDialog() {
  state.commandQuery = "";
  els.commandSearch.value = "";
  renderCommandPalette();
  els.commandDialog.showModal();
  els.commandSearch.focus();
}

function closeCommandDialog() {
  els.commandDialog.close();
}

function jobFailureInsight(job) {
  if (!job || !["FAILED", "TIMED_OUT", "CANCELLED"].includes(job.status)) return null;
  const failedStage = [...(job.stages || [])].reverse().find((stage) => stage.status === "FAILED");
  const failure = job.summary?.failure || {};
  const text = [
    job.error?.message,
    failure.stage,
    failedStage?.name,
    failedStage?.action,
    ...(failure.output?.categories || []).map((item) => item.category),
    ...(job.logs || []).slice(-80).map((entry) => entry.message)
  ].filter(Boolean).join("\n");

  if (/SONAR_TOKEN|sonar-auth|not authorized|unauthorized|forbidden|401|403|no valido|token/i.test(text)) {
    return {
      kind: "sonar-auth",
      title: "Configurar SonarQube",
      cta: "Revisar token de Sonar",
      explanation: "La ultima ejecucion fallo por autenticacion o conexion con SonarQube."
    };
  }
  if (/NO_APPROVED_COMMAND|No approved template|config/i.test(text)) {
    return {
      kind: "configuration",
      title: "Completar configuracion",
      cta: "Completar setup",
      explanation: "Falta una configuracion ejecutable para el proyecto."
    };
  }
  if (/lint|eslint|@typescript-eslint/i.test(text)) {
    return {
      kind: "lint",
      title: "Revisar reporte de lint",
      cta: "Ver reporte de lint",
      explanation: "La ultima ejecucion fallo en linting; conviene revisar reglas y errores agrupados."
    };
  }
  if (/test|vitest|jest|FAIL/i.test(text)) {
    return {
      kind: "tests",
      title: "Revisar tests fallidos",
      cta: "Ver tests",
      explanation: "La ultima ejecucion fallo durante tests."
    };
  }
  if (/build|compile|gradle|maven|tsc|TS[0-9]{4}/i.test(text)) {
    return {
      kind: "build",
      title: "Revisar build",
      cta: "Ver build",
      explanation: "La ultima ejecucion fallo durante build o compilacion."
    };
  }
  return {
    kind: "execution",
    title: "Revisar ejecucion",
    cta: "Ver resumen del job",
    explanation: "La ultima ejecucion termino con error; el detalle esta en Ejecuciones."
  };
}

function renderCommandPalette() {
  if (!els.commandList) return;
  const commands = [
    { label: "Agregar proyecto", detail: "Abrir onboarding", run: openProjectDialog },
    { label: "Actualizar workspace", detail: "Refrescar estado de plataforma y proyectos", run: loadAll },
    { label: "Start todos", detail: "Start smart con Git, fingerprint y rebuild solo si cambio el codigo", run: () => runBulkRuntimeAction("start") },
    { label: "Rebuild changed components todos", detail: "Rebuild secuencial cuando difiere la huella de fuente", run: () => runBulkRuntimeAction("rebuild-changed") },
    { label: "Clean rebuild todos", detail: "Build y recreacion preservando volumenes", run: () => runBulkRuntimeAction("clean-rebuild") },
    { label: "Pull and rebuild todos", detail: "Pull fast-forward y rebuild sobre worktree limpio", run: () => runBulkRuntimeAction("pull-rebuild") },
    { label: "Stop todos", detail: "Stop secuencial preservando volumenes", run: () => runBulkRuntimeAction("stop") },
    ...state.projects.flatMap((project) => [
      { label: `Abrir ${project.displayName}`, detail: project.repositoryPath, run: () => openProject(project.id) },
      { label: `Start ${project.displayName}`, detail: "Start smart con Git y fingerprint", run: () => { openProject(project.id); runRuntimeAction("start"); } },
      { label: `Restart ${project.displayName}`, detail: "Restart local con fingerprint actual", run: () => { openProject(project.id); runRuntimeAction("restart"); } },
      { label: `Rebuild changed components ${project.displayName}`, detail: "Rebuild solo si cambio la huella de fuente", run: () => { openProject(project.id); runRuntimeAction("rebuild-changed"); } },
      { label: `Clean rebuild ${project.displayName}`, detail: "Build y recreacion preservando volumenes", run: () => { openProject(project.id); runRuntimeAction("clean-rebuild"); } },
      { label: `Pull and rebuild ${project.displayName}`, detail: "Pull fast-forward y rebuild", run: () => { openProject(project.id); runRuntimeAction("pull-rebuild"); } },
      { label: `Stop ${project.displayName}`, detail: "Stop local Docker Compose", run: () => { openProject(project.id); runRuntimeAction("stop"); } },
      { label: `Doctor ${project.displayName}`, detail: "Ejecutar Configuration Doctor", run: () => { state.selectedProject = project; startExecution("doctor"); } },
      { label: `Sonar ${project.displayName}`, detail: "Ejecutar analisis Sonar", run: () => { state.selectedProject = project; startExecution("sonar"); } }
    ])
  ].filter((command) => !state.commandQuery || `${command.label} ${command.detail}`.toLowerCase().includes(state.commandQuery));

  els.commandList.innerHTML = commands.map((command, index) => `
    <button type="button" data-command="${index}">
      <strong>${escapeHtml(command.label)}</strong>
      <span>${escapeHtml(command.detail)}</span>
    </button>
  `).join("") || `<p class="muted">Sin comandos para esta busqueda.</p>`;

  for (const button of els.commandList.querySelectorAll("[data-command]")) {
    button.addEventListener("click", () => {
      const command = commands[Number(button.dataset.command)];
      closeCommandDialog();
      command.run();
    });
  }
}

function statusBadge(status) {
  return `<span class="status ${statusClass(status.tone || status.label)}">${escapeHtml(status.label)}</span>`;
}

function metric(label, value, source) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p class="muted">${escapeHtml(source)}</p></div>`;
}

function miniMetric(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function quickToolLink(project, provider, label) {
  const link = (project.toolLinks || []).find((item) => item.provider === provider && item.label === label);
  if (!link?.url) return "";
  return `<a class="button ghost" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function answerCard(question, answer, detail) {
  return `<article class="answer-card"><span class="label">${escapeHtml(question)}</span><strong>${escapeHtml(answer)}</strong><p class="muted">${escapeHtml(detail)}</p></article>`;
}

function integrationCard(title, label, detail) {
  return `<article class="integration-card"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(title)}</strong><p class="muted">${escapeHtml(detail)}</p></article>`;
}

function toolLinksPanel(project, preferredGroup = "") {
  const links = (project.toolLinks || []).filter((link) => !preferredGroup || link.group === preferredGroup || ["source", "ci"].includes(link.group));
  if (!links.length) return "";
  const grouped = links.reduce((acc, link) => {
    const group = link.group || "tools";
    acc[group] ||= [];
    acc[group].push(link);
    return acc;
  }, {});
  const groupLabels = {
    source: "Repositorio y Git",
    ci: "CI/CD",
    quality: "Calidad",
    observability: "Observabilidad",
    tools: "Herramientas"
  };
  return `
    <section class="tool-links-panel">
      <div class="section-heading compact">
        <h3>Herramientas del proyecto</h3>
        <button class="button secondary" type="button" data-validate-links>Validar links</button>
      </div>
      ${Object.entries(grouped).map(([group, items]) => `
        <div class="tool-link-group">
          <span class="label">${escapeHtml(groupLabels[group] || group)}</span>
          <div class="tool-link-grid">
            ${items.map(toolLinkCard).join("")}
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function toolLinkCard(link) {
  const status = toolLinkStatus(link);
  return `
    <article class="tool-link-card ${status.tone}">
      <div class="tool-link-title">
        <span class="status ${status.tone}">${escapeHtml(status.label)}</span>
        <strong>${escapeHtml(link.label)}</strong>
      </div>
      <p class="muted">${escapeHtml(link.hint || "")}</p>
      ${link.error ? `<p class="error-text">${escapeHtml(link.error)}</p>` : ""}
      ${link.httpStatus ? `<small>HTTP ${escapeHtml(link.httpStatus)} · ${escapeHtml(link.responseTimeMs || 0)} ms</small>` : ""}
      <a class="button ghost" href="${escapeHtml(link.url || "#")}" target="_blank" rel="noreferrer">Abrir</a>
    </article>
  `;
}

function toolLinkStatus(link = {}) {
  if (link.status === "ok") return { label: "OK", tone: "ok" };
  if (link.status === "blocked") return { label: "Requiere acceso", tone: "warn" };
  if (link.status === "missing") return { label: "Falta", tone: "warn" };
  if (link.status === "failed") return { label: "Falla", tone: "error" };
  return { label: "Sin validar", tone: "info" };
}

function runtimeFreshnessPanel(project) {
  const runtime = project.localRuntime || {};
  const freshness = runtime.freshness || {};
  const deployment = runtime.lastDeployment || {};
  const git = runtime.git || project.git || {};
  const status = freshness.status || "unknown";
  const expectedShort = fingerprintShort(freshness.expected || deployment.expectedFingerprint);
  const currentShort = fingerprintShort(freshness.current || runtime.sourceFingerprint?.value);
  return `
    <section class="focus-panel ${status === "stale" || status === "failed" ? "danger-soft" : ""}">
      <div>
        <span class="label">Evidencia de ultimos cambios</span>
        <h3>${escapeHtml(freshnessLabel(status))}</h3>
        <p>${escapeHtml(freshness.message || "Sin evidencia de deploy local todavia.")}</p>
        <p class="muted">${escapeHtml(gitLine(git))}${git?.dirty ? ` · ${escapeHtml(localChangeSummary(git))}` : ""}</p>
        <p class="muted">Actual: ${escapeHtml(currentShort || "sin fingerprint")} · Ultimo deploy: ${escapeHtml(expectedShort || "sin deploy")}</p>
      </div>
      ${status === "stale" || status === "unverified" || status === "pending" ? `
        <button class="button primary" type="button" data-runtime-action="start">Start</button>
      ` : `
        <span class="status ${freshnessTone(status)}">${escapeHtml(freshnessLabel(status))}</span>
      `}
    </section>
  `;
}

function freshnessLabel(status) {
  const labels = {
    matched: "Coincide",
    deploying: "Verificando",
    stale: "Runtime obsoleto",
    failed: "Deploy fallido",
    pending: "Sin deploy registrado",
    unverified: "Runtime sin evidencia",
    unknown: "Sin datos",
    not_applicable: "No aplica"
  };
  return labels[status] || status || "Sin datos";
}

function freshnessTone(status) {
  if (status === "matched") return "ok";
  if (["deploying", "not_applicable"].includes(status)) return "info";
  if (["stale", "failed"].includes(status)) return "error";
  return "warn";
}

function gitLine(git = {}) {
  if (!git?.isGit) return "Git no detectado";
  const branch = git.detachedHead ? "detached HEAD" : git.branch || "sin rama";
  const dirty = git.dirty ? "dirty" : "clean";
  const remote = git.ahead || git.behind ? ` · ahead ${git.ahead || 0} / behind ${git.behind || 0}` : "";
  return `${branch} · ${shortSha(git.commit || git.shortCommit)} · ${dirty}${remote}`;
}

function localChangeSummary(git = {}) {
  const parts = [];
  if (git.modified) parts.push(`${git.modified} mod`);
  if (git.added) parts.push(`${git.added} add`);
  if (git.deleted) parts.push(`${git.deleted} del`);
  if (git.untracked) parts.push(`${git.untracked} untracked`);
  if (git.conflicted) parts.push(`${git.conflicted} conflictos`);
  return parts.join(" · ") || "sin cambios locales";
}

function fingerprintShort(value) {
  return value ? String(value).replace(/^sha256:/, "").slice(0, 12) : "";
}

function runtimeControlPanel(project) {
  const runtime = project.localRuntime || {};
  const busy = ["starting", "stopping", "restarting"].includes(runtime.status);
  return `
    <section class="runtime-panel">
      <div>
        <span class="label">Local Run Engine</span>
        <h3>${escapeHtml(runtime.label || "Sin datos")}</h3>
        <p class="muted">${escapeHtml(runtime.explanation || "Gestiona el compose local detectado para este proyecto.")}</p>
        <p class="muted">Git, fingerprint, ultimo deploy y volumenes se validan antes de ejecutar perfiles locales aprobados.</p>
      </div>
      <div class="toolbar">
        <button class="button primary" type="button" data-runtime-action="start" ${busy ? "disabled" : ""}>Start</button>
        <button class="button secondary" type="button" data-runtime-action="restart" ${busy ? "disabled" : ""}>Restart</button>
        <button class="button secondary" type="button" data-runtime-action="rebuild-changed" ${busy ? "disabled" : ""}>Rebuild changed components</button>
        <button class="button secondary" type="button" data-runtime-action="clean-rebuild" ${busy ? "disabled" : ""}>Clean rebuild</button>
        <button class="button secondary" type="button" data-runtime-action="pull-rebuild" ${busy ? "disabled" : ""}>Pull and rebuild</button>
        <button class="button secondary" type="button" data-runtime-action="stop" ${busy ? "disabled" : ""}>Stop</button>
      </div>
    </section>
  `;
}

function runtimeStatusBadge(runtime = {}) {
  const tone = runtimeStatusTone(runtime.status);
  return `<span class="status ${tone}">${escapeHtml(runtime.label || "Sin datos")}</span>`;
}

function runtimeStatusTone(status) {
  if (status === "running") return "ok";
  if (["starting", "stopping", "restarting", "checking"].includes(status)) return "info";
  if (["stopped", "not_configured", "unavailable"].includes(status)) return "warn";
  if (["error", "degraded", "stale"].includes(status)) return "error";
  return "info";
}

function resourceTable(resources) {
  if (!resources.length) {
    return `<article class="empty-state compact"><strong>Sin recursos activos</strong><p class="muted">Cuando el entorno local este levantado, aca aparecen servicios, estado y puertos publicados.</p></article>`;
  }
  return `
    <div class="resource-table" role="table" aria-label="Recursos activos del runtime local">
      <div class="resource-row head" role="row">
        <span>Servicio</span>
        <span>Estado</span>
        <span>Puerto host</span>
        <span>Acciones</span>
      </div>
      ${resources.map((resource) => `
        <div class="resource-row" role="row">
          <span>
            <strong>${escapeHtml(resource.service || resource.name)}</strong>
            <small>${escapeHtml(resource.name || resource.id)}</small>
          </span>
          <span>${statusBadge(statusMeta(resource.state, resource.state || "unknown", resource.status || "", resource.state === "running" ? "ok" : "error", resource.state === "running" ? 0 : 4))}</span>
          <span>${(resource.ports || []).map((port) => `<code>localhost:${escapeHtml(port.host)} -> ${escapeHtml(port.target)}/${escapeHtml(port.protocol)}</code>`).join("") || `<span class="muted">sin puerto publicado</span>`}</span>
          <span class="resource-actions">${(resource.urls || []).map((item) => `<a class="button ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Abrir ${escapeHtml(item.label)}</a>`).join("") || `<span class="muted">sin URL web</span>`}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function runtimeProfileList(profiles) {
  if (!profiles.length) {
    return `<article class="empty-state compact"><strong>Sin perfiles runtime</strong><p class="muted">No se detectaron scripts aprobados ni compose usable para este proyecto.</p></article>`;
  }
  return `
    <div class="profile-grid">
      ${profiles.map((profile) => `
        <article class="profile-item">
          <strong>${escapeHtml(profile.action)}</strong>
          <span>${escapeHtml(profile.label || profile.source || "perfil aprobado")}</span>
          <code>${escapeHtml(profile.source || "")}</code>
        </article>
      `).join("")}
    </div>
  `;
}

function actionCenterItem(model) {
  const runtime = model.project.localRuntime || {};
  const failure = jobFailureInsight(model.project.latestJob);
  if (runtime.status === "stale") {
    return {
      status: statusMeta("stale-runtime", "Obsoleto", runtime.explanation || "", "error", 5),
      reason: runtime.explanation || "El codigo local cambio desde el ultimo deploy registrado.",
      button: "Start"
    };
  }
  if (runtime.freshness?.status === "unverified") {
    return {
      status: statusMeta("runtime-unverified", "Sin evidencia", runtime.freshness.message || "", "warn", 4),
      reason: runtime.freshness.message || "Hay runtime activo sin fingerprint de deploy registrado.",
      button: "Registrar deploy fresco"
    };
  }
  if (["error", "degraded"].includes(runtime.status)) {
    return { status: statusMeta("runtime", runtime.label || "Runtime", runtime.explanation || "", "error", 5), reason: runtime.explanation || "El entorno local tiene servicios detenidos o fallos.", button: "Revisar entorno" };
  }
  if (failure?.kind === "sonar-auth") {
    return { status: statusMeta("sonar-auth", "Token", failure.explanation, "error", 5), reason: failure.explanation, button: "Revisar token" };
  }
  if (model.status.key === "critical") {
    return { status: model.status, reason: model.status.explanation, button: "Abrir incidente" };
  }
  if (failure) {
    return { status: statusMeta("failed", "Falló", failure.explanation, "warn", 4), reason: failure.explanation, button: failure.cta };
  }
  if (["starting", "stopping", "restarting"].includes(runtime.status)) {
    return { status: statusMeta("runtime-busy", runtime.label || "Runtime", runtime.explanation || "", "info", 2), reason: runtime.explanation || "Accion local en progreso.", button: "Ver terminal" };
  }
  return null;
}

function projectCardMetrics(model) {
  const items = [];
  const runtime = model.project.localRuntime || {};
  const git = runtime.git || model.project.git || {};
  if (runtime.label) items.push({ label: "Local", value: runtime.label });
  if (git?.isGit) items.push({ label: "Git", value: `${git.branch || "detached"} · ${shortSha(git.commit || git.shortCommit)}` });
  if (runtime.sourceFingerprint?.short) items.push({ label: "Fingerprint", value: runtime.sourceFingerprint.short });
  if ((runtime.resources || []).length) items.push({ label: "Servicios", value: String(runtime.resources.length) });
  if ((runtime.ports || []).length) items.push({ label: "Puertos", value: String(runtime.ports.length) });
  if (model.qualityGate !== "Sin datos") items.push({ label: "Gate", value: model.qualityGate });
  if (model.coverage !== "Sin datos") items.push({ label: "Coverage", value: model.coverage });
  if (model.lastAnalysis !== "Pendiente") items.push({ label: "Ultimo analisis", value: model.lastAnalysis });
  const healthSignals = model.project.instrumentation?.health?.length || 0;
  const metricsSignals = model.project.instrumentation?.metrics?.length || 0;
  if (healthSignals) items.push({ label: "Health", value: `${healthSignals} senales` });
  if (metricsSignals) items.push({ label: "Metrics", value: `${metricsSignals} senales` });
  const missing = [
    model.qualityGate === "Sin datos" ? "Gate" : null,
    model.coverage === "Sin datos" ? "Coverage" : null,
    model.alerts === "Sin datos" ? "Alertas" : null,
    model.logs === "Sin datos" ? "Logs" : null,
    !healthSignals ? "Health" : null
  ].filter(Boolean);
  if (missing.length) items.push({ label: "Metrica incompleta", value: `${missing.length} pendientes` });
  return items.slice(0, 6);
}

function setupHintList(project) {
  const hints = projectSetupHints(project);
  if (!hints.length) return "";
  return `
    <section class="setup-hints" aria-label="Seteo requerido del proyecto">
      <div class="section-heading compact">
        <h3>Seteo requerido</h3>
        <span class="info-dot" title="Estas pistas explican que variable, puerto o script falta revisar para que las acciones del panel funcionen sin consola.">i</span>
      </div>
      <div class="hint-grid">
        ${hints.map((hint) => `
          <article class="hint-card ${escapeHtml(hint.level || "info")}">
            <div class="hint-title">
              <span class="info-dot" title="${escapeHtml(hint.help || hint.detail || "")}">i</span>
              <strong>${escapeHtml(hint.title)}</strong>
            </div>
            <p>${escapeHtml(hint.detail)}</p>
            ${hint.value ? `<code>${escapeHtml(hint.value)}</code>` : ""}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function projectSetupHints(project) {
  const runtime = project.localRuntime || {};
  const profiles = runtime.profiles || [];
  const runtimeConfig = project.runtimeConfig || {};
  const hints = [];
  const hasProfile = (action) => profiles.some((profile) => profile.action === action && profile.available !== false);

  if (!hasProfile("start")) {
    hints.push({
      level: "warn",
      title: "No hay perfil de start",
      detail: "El panel no encontro un script aprobado para levantar este proyecto.",
      value: "Agregar local:up o scripts/local-*.sh"
    });
  }
  if (!hasProfile("logs")) {
    hints.push({
      level: "info",
      title: "Logs no configurados",
      detail: "Sin perfil logs el panel no puede mostrar terminal del contenedor.",
      value: "Agregar local:logs o scripts/... logs"
    });
  }

  if (project.slug === "maria-belen-labarque-ceramic") {
    hints.push({
      level: "ok",
      title: "CORS Strapi local",
      detail: "El storefront de Maria debe estar permitido por Strapi.",
      value: "CORS_ORIGINS=http://localhost:12000,http://localhost:11337",
      help: "Se inyecta desde el perfil local:up del hub y queda visible aca para override si cambia el puerto."
    });
    hints.push({
      level: "ok",
      title: "URL publica Strapi",
      detail: "El bundle Next usa esta URL para leer productos desde el navegador.",
      value: "NEXT_PUBLIC_STRAPI_URL=http://localhost:11337"
    });
  }

  if (project.slug === "sistema-dietetica") {
    hints.push({
      level: "ok",
      title: "Frontend hacia backend",
      detail: "El bundle debe llamar al backend propio de Sistema, no al 8080 compartido.",
      value: "VITE_API_URL=http://localhost:18083/api/v1"
    });
    hints.push({
      level: "ok",
      title: "Origen permitido",
      detail: "Spring Security debe aceptar el origin del frontend local.",
      value: "APP_SECURITY_ALLOWED_ORIGINS=http://localhost:15173"
    });
  }

  if (project.slug === "giftfinder-proyect") {
    hints.push({
      level: "ok",
      title: "Frontend hacia backend",
      detail: "El bundle Vite debe llamar al backend propio de Giftfinder.",
      value: "VITE_API_URL=http://localhost:18084"
    });
    hints.push({
      level: "ok",
      title: "Origen permitido",
      detail: "Spring Security debe aceptar el origin del frontend local.",
      value: "CORS_ALLOWED_ORIGINS=http://localhost:15174"
    });
  }

  if (!runtimeConfig.sonarTokenConfigured) {
    hints.push({
      level: "info",
      title: "Sonar token",
      detail: "Los scans de Sonar requieren token del SonarQube que este levantado.",
      value: "Configurar SONAR_TOKEN en el environment del backend"
    });
  }

  if ((project.doctor || []).some((item) => item.code === "JENKINSFILE" && item.level !== "ok")) {
    hints.push({
      level: "warn",
      title: "Jenkinsfile faltante",
      detail: "Jenkins multibranch necesita un Jenkinsfile en la raiz del repo para ejecutar build/test/scan/docker image.",
      value: "Agregar Jenkinsfile al proyecto"
    });
  }

  if (!(project.toolLinks || []).some((link) => link.provider === "jenkins" && link.status === "ok")) {
    hints.push({
      level: "info",
      title: "Jenkins no validado",
      detail: "Usa Herramientas del proyecto -> Validar links para confirmar Jenkins y el multibranch job.",
      value: runtimeConfig.jenkinsUrl || "http://localhost:18082"
    });
  }

  if (runtime.status === "error" || runtime.status === "unavailable") {
    hints.push({
      level: "warn",
      title: "Runtime bloqueado",
      detail: runtime.explanation || "La ultima accion local fallo.",
      value: "Abrir Terminal/Logs"
    });
  }
  if (runtime.status === "stale") {
    hints.push({
      level: "warn",
      title: "Runtime obsoleto",
      detail: "El fingerprint actual de la carpeta no coincide con el ultimo deploy registrado.",
      value: "Usar Start o Rebuild changed components"
    });
  }
  if (runtime.lastDeployment && !runtime.lastDeployment.runtimeReportedFingerprint) {
    hints.push({
      level: "info",
      title: "Identity endpoint pendiente",
      detail: "El hub verifica el fingerprint desde la carpeta y el deploy, pero la app todavia no reporta su propio fingerprint.",
      value: "/internal/runtime-identity o equivalente"
    });
  }

  return hints;
}

function doctorList(items) {
  if (!items.length) return `<p class="muted">Sin reporte de doctor.</p>`;
  return `<div class="doctor-list">${items.map((item) => `
    <article class="doctor-item visual ${statusClass(item.level)}">
      <span class="status ${statusClass(item.level)}">${escapeHtml(doctorLabel(item.level))}</span>
      <div>
        <strong>${escapeHtml(item.code)}</strong>
        <p>${escapeHtml(item.message)}</p>
      </div>
    </article>
  `).join("")}</div>`;
}

function doctorLabel(level) {
  if (level === "ok") return "OK";
  if (level === "warn") return "Warning";
  if (level === "error") return "Critical";
  return "Info";
}

function commandList(commands) {
  if (!commands.length) return `<p class="muted">No hay templates aprobados para este proyecto.</p>`;
  return `<div class="command-list">${commands.map((command) => `
    <article class="command-item">
      <span class="status ${statusClass(command.action === "sonar" ? "warn" : "ok")}">${escapeHtml(command.action)}</span>
      <code>${escapeHtml(command.label || `${command.command} ${(command.args || []).join(" ")}`)}</code>
      <p class="muted">Fuente: ${escapeHtml(command.source || "discovery")}</p>
    </article>
  `).join("")}</div>`;
}

function pathList(items, emptyText) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="path-list">${items.map((item) => `<code>${escapeHtml(item)}</code>`).join("")}</div>`;
}

function summaryLine(summary) {
  const parts = [];
  if (summary.metrics?.p95Ms !== undefined) parts.push(`p95 ${summary.metrics.p95Ms} ms`);
  if (summary.metrics?.errorRate !== undefined) parts.push(`error ${summary.metrics.errorRate}`);
  if (summary.checks?.findings !== undefined) parts.push(`${summary.checks.findings} findings`);
  if (summary.errors) parts.push(`${summary.errors} errores`);
  if (summary.warnings) parts.push(`${summary.warnings} warnings`);
  if (summary.topRules?.length) parts.push(`${summary.topRules[0].count}x ${summary.topRules[0].rule}`);
  if (!parts.length && summary.lines) parts.push(`${summary.lines} lineas`);
  return parts.join(" · ");
}

function option(value, current, label) {
  const selected = String(current || "") === value ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
}

function formatAdditionalEnv(items) {
  return (items || []).map((item) => `${item.key}=${item.value}`).join("\n");
}

function parseAdditionalEnv(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      if (index === -1) return { key: line, value: "" };
      return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    });
}

function gapList(project) {
  const gaps = (project.doctor || []).filter((item) => item.level !== "ok");
  if (!gaps.length) return `<p class="muted">Sin brechas abiertas en el doctor actual.</p>`;
  return `<div class="doctor-list">${gaps.map((item) => `
    <article class="doctor-item">
      <span class="status ${statusClass(item.level)}">${escapeHtml(item.level)}</span>
      <strong>${escapeHtml(item.code)}</strong>
      <p>${escapeHtml(item.message)}</p>
    </article>
  `).join("")}</div>`;
}

function runtimeState(project) {
  if ((project.doctor || []).some((item) => item.code === "RUNTIME" && item.level === "ok")) return "Runtime detectado";
  if ((project.detectedStack || []).includes("docker")) return "Docker detectado";
  return "Sin datos";
}

function formatCoverage(value) {
  if (!hasValue(value)) return "Sin datos";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : String(value);
}

function formatDate(value) {
  if (!value) return "Sin datos";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function numberFromText(value) {
  return Number(String(value || "0").replace(/,/g, ""));
}

function shortSha(value) {
  return value ? String(value).slice(0, 8) : "sin commit";
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleFromSlug(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusClass(status) {
  const normalized = String(status || "").toUpperCase();
  if (["UP", "OK", "ACTIVE", "SUCCEEDED", "HEALTHY", "MATCHED", "COINCIDE", "CONFIGURED_AND_VERIFIED", "IN_SYNC", "NO_CHANGES"].includes(normalized) || status === "ok") return "ok";
  if (["RUNNING", "QUEUED", "PREPARING", "STARTING", "STOPPING", "RESTARTING", "INFO", "CONFIGURED_NOT_VERIFIED", "PARTIALLY_CONFIGURED", "CHANGES_DETECTED", "LOCAL_CHANGES", "LOCAL_AHEAD"].includes(normalized) || status === "info") return "info";
  if (["DOWN", "ERROR", "FAILED", "MISCONFIGURED", "CRITICAL", "DEGRADED", "STALE", "OBSOLETO", "RUNTIME OBSOLETO", "DEPLOYED_VERSION_STALE", "MISMATCH", "REMOTE_AHEAD", "DIVERGED"].includes(normalized) || status === "error") return "error";
  return "warn";
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
