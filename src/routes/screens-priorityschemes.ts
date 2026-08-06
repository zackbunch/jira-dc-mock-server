import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  screenFieldCatalog,
  screensPriorityState,
  type PriorityScheme,
  type Screen,
  type ScreenFieldPlacement,
  type ScreenTab,
  type ScreensPriorityState,
} from "../screens-priority-state.js";
import { jiraError } from "../shared/errors.js";

type JsonObject = Record<string, unknown>;
type Query = Record<string, string | string[] | undefined>;

function fail(reply: FastifyReply, status: number, message: string, field?: string) {
  return reply
    .code(status)
    .send(field ? jiraError([], { [field]: message }) : jiraError([message]));
}

function bodyObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryInteger(value: string | string[] | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const input = Array.isArray(value) ? value[0] : value;
  if (!/^\d+$/.test(input)) return undefined;
  return Number(input);
}

function findScreen(state: ScreensPriorityState, screenId: string): Screen | undefined {
  return state.screens.find((screen) => String(screen.id) === screenId);
}

function findTab(screen: Screen, tabId: string): ScreenTab | undefined {
  return screen.tabs.find((tab) => String(tab.id) === tabId);
}

function validateProjectKey(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  projectKey: string | string[] | undefined,
) {
  if (projectKey === undefined) return undefined;
  const key = Array.isArray(projectKey) ? projectKey[0] : projectKey;
  if (!app.jira.store.state.projects.some((project) => project.key === key)) {
    return fail(reply, 400, "The project key does not identify an existing project.", "projectKey");
  }
  return undefined;
}

function serializeTab(tab: ScreenTab) {
  return { id: tab.id, name: tab.name };
}

function serializeField(
  app: Parameters<FastifyPluginAsync>[0],
  placement: ScreenFieldPlacement,
) {
  const field = screenFieldCatalog(app.jira.store).find(
    (candidate) => candidate.id === placement.id,
  );
  return {
    id: placement.id,
    name: field?.name ?? placement.id,
    type: field?.custom ? "custom" : "system",
    showWhenEmpty: placement.showWhenEmpty,
  };
}

function serializePriorityScheme(
  scheme: PriorityScheme,
  baseUrl: string,
  includeProjects = true,
) {
  return {
    id: scheme.id,
    self: `${baseUrl}/rest/api/2/priorityschemes/${scheme.id}`,
    name: scheme.name,
    description: scheme.description,
    defaultOptionId: scheme.defaultOptionId,
    optionIds: [...scheme.optionIds],
    defaultScheme: scheme.defaultScheme,
    ...(includeProjects ? { projectKeys: [...scheme.projectKeys].sort() } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return [...new Set(value as string[])];
}

function validatePriorityOptions(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  optionIds: string[],
  defaultOptionId: string,
) {
  const priorities = new Set(app.jira.store.state.priorities.map((priority) => priority.id));
  if (!optionIds.length || optionIds.some((id) => !priorities.has(id))) {
    return fail(reply, 400, "optionIds must identify existing priorities.", "optionIds");
  }
  if (!priorities.has(defaultOptionId) || !optionIds.includes(defaultOptionId)) {
    return fail(
      reply,
      400,
      "defaultOptionId must identify a priority included in optionIds.",
      "defaultOptionId",
    );
  }
  return undefined;
}

function validateProjectKeys(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  projectKeys: string[],
) {
  const projects = new Set(app.jira.store.state.projects.map((project) => project.key));
  if (projectKeys.some((key) => !projects.has(key))) {
    return fail(reply, 400, "projectKeys must identify existing projects.", "projectKeys");
  }
  return undefined;
}

function assignProjects(
  state: ScreensPriorityState,
  scheme: PriorityScheme,
  projectKeys: string[],
) {
  if (scheme.defaultScheme) return;
  const defaultScheme = state.prioritySchemes.find((candidate) => candidate.defaultScheme)!;
  const previous = [...scheme.projectKeys];
  for (const candidate of state.prioritySchemes) {
    candidate.projectKeys = candidate.projectKeys.filter((key) => !projectKeys.includes(key));
  }
  scheme.projectKeys = [...projectKeys];
  for (const key of previous) {
    if (!projectKeys.includes(key) && !defaultScheme.projectKeys.includes(key)) {
      defaultScheme.projectKeys.push(key);
    }
  }
  defaultScheme.projectKeys.sort();
}

function screenFieldIds(screen: Screen): Set<string> {
  return new Set(screen.tabs.flatMap((tab) => tab.fields.map((field) => field.id)));
}

function movePlacement(
  fields: ScreenFieldPlacement[],
  field: ScreenFieldPlacement,
  body: JsonObject,
): string | undefined {
  const after = trimmed(body.after);
  const position = trimmed(body.position);
  if ((after ? 1 : 0) + (position ? 1 : 0) !== 1) {
    return "Specify exactly one of after or position.";
  }
  const currentIndex = fields.indexOf(field);
  if (after) {
    let targetId: string | undefined;
    try {
      const url = new URL(after);
      targetId = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    } catch {
      return "after must be the URL of another field on this tab.";
    }
    const target = fields.find((candidate) => candidate.id === targetId);
    if (!target || target === field) return "after must identify another field on this tab.";
    fields.splice(currentIndex, 1);
    fields.splice(fields.indexOf(target) + 1, 0, field);
    return undefined;
  }
  if (!(["Earlier", "Later", "First", "Last"] as string[]).includes(position!)) {
    return "position must be Earlier, Later, First, or Last.";
  }
  const destination =
    position === "First"
      ? 0
      : position === "Last"
        ? fields.length - 1
        : position === "Earlier"
          ? Math.max(0, currentIndex - 1)
          : Math.min(fields.length - 1, currentIndex + 1);
  if (destination === currentIndex) return undefined;
  fields.splice(currentIndex, 1);
  fields.splice(destination, 0, field);
  return undefined;
}

const routes: FastifyPluginAsync = async (app) => {
  app.get("/rest/api/2/priorityschemes", async (request, reply) => {
    const query = request.query as Query;
    const startAt = queryInteger(query.startAt, 0);
    const requestedMaximum = queryInteger(query.maxResults, 100);
    if (startAt === undefined || requestedMaximum === undefined) {
      return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    }
    const maxResults = Math.min(requestedMaximum, 1000);
    const state = screensPriorityState(app.jira.store);
    const schemes = state.prioritySchemes
      .slice(startAt, startAt + maxResults)
      .map((scheme) =>
        serializePriorityScheme(
          scheme,
          app.jira.baseUrl,
          String(query.expand ?? "") === "schemes.projectKeys",
        ),
      );
    return { startAt, maxResults, total: state.prioritySchemes.length, schemes };
  });

  app.post("/rest/api/2/priorityschemes", async (request, reply) => {
    const body = bodyObject(request.body);
    if (!body) return fail(reply, 400, "A priority scheme body is required.");
    const name = trimmed(body.name);
    const description = typeof body.description === "string" ? body.description : "";
    const optionIds = stringArray(body.optionIds);
    const defaultOptionId = trimmed(body.defaultOptionId);
    if (!name) return fail(reply, 400, "A priority scheme name is required.", "name");
    if (!optionIds) return fail(reply, 400, "optionIds must be an array of strings.", "optionIds");
    if (!defaultOptionId) {
      return fail(reply, 400, "A default priority is required.", "defaultOptionId");
    }
    const invalidOptions = validatePriorityOptions(app, reply, optionIds, defaultOptionId);
    if (invalidOptions) return invalidOptions;
    const projectKeys = body.projectKeys === undefined ? [] : stringArray(body.projectKeys);
    if (!projectKeys) {
      return fail(reply, 400, "projectKeys must be an array of strings.", "projectKeys");
    }
    const invalidProjects = validateProjectKeys(app, reply, projectKeys);
    if (invalidProjects) return invalidProjects;
    const state = screensPriorityState(app.jira.store);
    if (state.prioritySchemes.some((scheme) => scheme.name.toLowerCase() === name.toLowerCase())) {
      return fail(reply, 400, "A priority scheme with this name already exists.", "name");
    }
    const scheme: PriorityScheme = {
      id: state.prioritySchemeCounter++,
      name,
      description,
      optionIds,
      defaultOptionId,
      projectKeys: [],
      defaultScheme: false,
    };
    state.prioritySchemes.push(scheme);
    assignProjects(state, scheme, projectKeys);
    app.jira.store.save();
    return reply.code(201).send(serializePriorityScheme(scheme, app.jira.baseUrl));
  });

  app.get("/rest/api/2/priorityschemes/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const scheme = screensPriorityState(app.jira.store).prioritySchemes.find(
      (candidate) => String(candidate.id) === schemeId,
    );
    if (!scheme) return fail(reply, 404, "The priority scheme does not exist.");
    return serializePriorityScheme(scheme, app.jira.baseUrl);
  });

  app.put("/rest/api/2/priorityschemes/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = screensPriorityState(app.jira.store);
    const scheme = state.prioritySchemes.find((candidate) => String(candidate.id) === schemeId);
    if (!scheme) return fail(reply, 404, "The priority scheme does not exist.");
    const body = bodyObject(request.body);
    if (!body) return fail(reply, 400, "A priority scheme body is required.");
    const name = body.name === undefined ? scheme.name : trimmed(body.name);
    if (!name) return fail(reply, 400, "A priority scheme name is required.", "name");
    if (
      state.prioritySchemes.some(
        (candidate) =>
          candidate !== scheme && candidate.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return fail(reply, 400, "A priority scheme with this name already exists.", "name");
    }
    const optionIds =
      body.optionIds === undefined ? scheme.optionIds : stringArray(body.optionIds);
    if (!optionIds) return fail(reply, 400, "optionIds must be an array of strings.", "optionIds");
    const defaultOptionId =
      body.defaultOptionId === undefined ? scheme.defaultOptionId : trimmed(body.defaultOptionId);
    if (!defaultOptionId) {
      return fail(reply, 400, "A default priority is required.", "defaultOptionId");
    }
    const invalidOptions = validatePriorityOptions(app, reply, optionIds, defaultOptionId);
    if (invalidOptions) return invalidOptions;
    let projectKeys: string[] | undefined;
    if (body.projectKeys !== undefined) {
      projectKeys = stringArray(body.projectKeys);
      if (!projectKeys) {
        return fail(reply, 400, "projectKeys must be an array of strings.", "projectKeys");
      }
      const invalidProjects = validateProjectKeys(app, reply, projectKeys);
      if (invalidProjects) return invalidProjects;
    }
    scheme.name = name;
    scheme.description =
      body.description === undefined
        ? scheme.description
        : typeof body.description === "string"
          ? body.description
          : "";
    scheme.optionIds = optionIds;
    scheme.defaultOptionId = defaultOptionId;
    if (projectKeys) assignProjects(state, scheme, projectKeys);
    app.jira.store.save();
    return serializePriorityScheme(scheme, app.jira.baseUrl);
  });

  app.delete("/rest/api/2/priorityschemes/:schemeId", async (request, reply) => {
    const { schemeId } = request.params as { schemeId: string };
    const state = screensPriorityState(app.jira.store);
    const scheme = state.prioritySchemes.find((candidate) => String(candidate.id) === schemeId);
    if (!scheme) return fail(reply, 404, "The priority scheme does not exist.");
    if (scheme.defaultScheme) return fail(reply, 400, "The default priority scheme cannot be deleted.");
    const defaultScheme = state.prioritySchemes.find((candidate) => candidate.defaultScheme)!;
    defaultScheme.projectKeys = [
      ...new Set([...defaultScheme.projectKeys, ...scheme.projectKeys]),
    ].sort();
    state.prioritySchemes.splice(state.prioritySchemes.indexOf(scheme), 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/screens", async (request, reply) => {
    const query = request.query as Query;
    const startAt = queryInteger(query.startAt, 0);
    const maxResults = queryInteger(query.maxResults, 100);
    if (startAt === undefined || maxResults === undefined) {
      return fail(reply, 400, "startAt and maxResults must be non-negative integers.");
    }
    const search = String(query.search ?? "").trim().toLowerCase();
    const includeTabs = String(query.expand ?? "")
      .split(",")
      .map((value) => value.trim())
      .includes("tabs");
    const matching = screensPriorityState(app.jira.store).screens.filter((screen) =>
      `${screen.name} ${screen.description}`.toLowerCase().includes(search),
    );
    const values = matching.slice(startAt, startAt + maxResults).map((screen) => ({
      id: screen.id,
      name: screen.name,
      description: screen.description,
      ...(includeTabs ? { tabs: screen.tabs.map(serializeTab) } : {}),
    }));
    return reply.code(201).send({
      startAt,
      maxResults,
      total: matching.length,
      isLast: startAt + values.length >= matching.length,
      values,
    });
  });

  app.post("/rest/api/2/screens/addToDefault/:fieldId", async (request, reply) => {
    const { fieldId } = request.params as { fieldId: string };
    const catalog = screenFieldCatalog(app.jira.store);
    if (!catalog.some((field) => field.id === fieldId)) {
      return fail(reply, 400, "The field does not exist.", "fieldId");
    }
    const state = screensPriorityState(app.jira.store);
    const screen = state.screens.find((candidate) => candidate.id === 1)!;
    if (screenFieldIds(screen).has(fieldId)) {
      return fail(reply, 400, "The field is already present on the default screen.", "fieldId");
    }
    screen.tabs[0].fields.push({ id: fieldId, showWhenEmpty: false });
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/screens/:screenId/availableFields", async (request, reply) => {
    const { screenId } = request.params as { screenId: string };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const used = screenFieldIds(screen);
    return screenFieldCatalog(app.jira.store)
      .filter((field) => !used.has(field.id))
      .map((field) => ({
        id: field.id,
        name: field.name,
        type: field.custom ? "custom" : "system",
        showWhenEmpty: false,
      }));
  });

  app.get("/rest/api/2/screens/:screenId/tabs", async (request, reply) => {
    const { screenId } = request.params as { screenId: string };
    const query = request.query as Query;
    const projectError = validateProjectKey(app, reply, query.projectKey);
    if (projectError) return projectError;
    const screen = findScreen(screensPriorityState(app.jira.store), screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    return screen.tabs.map(serializeTab);
  });

  app.post("/rest/api/2/screens/:screenId/tabs", async (request, reply) => {
    const { screenId } = request.params as { screenId: string };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const body = bodyObject(request.body);
    const name = trimmed(body?.name);
    if (!name) return fail(reply, 400, "A tab name is required.", "name");
    if (screen.tabs.some((tab) => tab.name.toLowerCase() === name.toLowerCase())) {
      return fail(reply, 400, "A tab with this name already exists.", "name");
    }
    const tab: ScreenTab = { id: state.tabCounter++, name, fields: [] };
    screen.tabs.push(tab);
    app.jira.store.save();
    return serializeTab(tab);
  });

  app.put("/rest/api/2/screens/:screenId/tabs/:tabId", async (request, reply) => {
    const { screenId, tabId } = request.params as { screenId: string; tabId: string };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const tab = findTab(screen, tabId);
    if (!tab) return fail(reply, 400, "The tab does not exist.");
    const body = bodyObject(request.body);
    const name = trimmed(body?.name);
    if (!name) return fail(reply, 400, "A tab name is required.", "name");
    if (
      screen.tabs.some(
        (candidate) => candidate !== tab && candidate.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return fail(reply, 400, "A tab with this name already exists.", "name");
    }
    tab.name = name;
    app.jira.store.save();
    return serializeTab(tab);
  });

  app.delete("/rest/api/2/screens/:screenId/tabs/:tabId", async (request, reply) => {
    const { screenId, tabId } = request.params as { screenId: string; tabId: string };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const tab = findTab(screen, tabId);
    if (!tab) return fail(reply, 400, "The tab does not exist.");
    if (screen.tabs.length === 1) {
      return fail(reply, 412, "A screen must contain at least one tab.");
    }
    screen.tabs.splice(screen.tabs.indexOf(tab), 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.post("/rest/api/2/screens/:screenId/tabs/:tabId/move/:pos", async (request, reply) => {
    const { screenId, tabId, pos } = request.params as {
      screenId: string;
      tabId: string;
      pos: string;
    };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const tab = findTab(screen, tabId);
    if (!tab) return fail(reply, 400, "The tab does not exist.");
    if (!/^\d+$/.test(pos) || Number(pos) >= screen.tabs.length) {
      return fail(reply, 400, "The tab position is outside the screen.", "pos");
    }
    screen.tabs.splice(screen.tabs.indexOf(tab), 1);
    screen.tabs.splice(Number(pos), 0, tab);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/screens/:screenId/tabs/:tabId/fields", async (request, reply) => {
    const { screenId, tabId } = request.params as { screenId: string; tabId: string };
    const query = request.query as Query;
    const projectError = validateProjectKey(app, reply, query.projectKey);
    if (projectError) return projectError;
    const screen = findScreen(screensPriorityState(app.jira.store), screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const tab = findTab(screen, tabId);
    if (!tab) return fail(reply, 400, "The tab does not exist.");
    return tab.fields.map((field) => serializeField(app, field));
  });

  app.post("/rest/api/2/screens/:screenId/tabs/:tabId/fields", async (request, reply) => {
    const { screenId, tabId } = request.params as { screenId: string; tabId: string };
    const state = screensPriorityState(app.jira.store);
    const screen = findScreen(state, screenId);
    if (!screen) return fail(reply, 400, "The screen does not exist.");
    const tab = findTab(screen, tabId);
    if (!tab) return fail(reply, 400, "The tab does not exist.");
    const body = bodyObject(request.body);
    const fieldId = trimmed(body?.fieldId);
    if (!fieldId || !screenFieldCatalog(app.jira.store).some((field) => field.id === fieldId)) {
      return fail(reply, 400, "The field does not exist.", "fieldId");
    }
    if (screenFieldIds(screen).has(fieldId)) {
      return fail(reply, 400, "The field is already present on this screen.", "fieldId");
    }
    const placement: ScreenFieldPlacement = { id: fieldId, showWhenEmpty: false };
    tab.fields.push(placement);
    app.jira.store.save();
    return serializeField(app, placement);
  });

  app.delete(
    "/rest/api/2/screens/:screenId/tabs/:tabId/fields/:id",
    async (request, reply) => {
      const { screenId, tabId, id } = request.params as {
        screenId: string;
        tabId: string;
        id: string;
      };
      const state = screensPriorityState(app.jira.store);
      const screen = findScreen(state, screenId);
      if (!screen) return fail(reply, 400, "The screen does not exist.");
      const tab = findTab(screen, tabId);
      if (!tab) return fail(reply, 400, "The tab does not exist.");
      const field = tab.fields.find((candidate) => candidate.id === id);
      if (!field) return fail(reply, 400, "The field is not on this tab.");
      tab.fields.splice(tab.fields.indexOf(field), 1);
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.post(
    "/rest/api/2/screens/:screenId/tabs/:tabId/fields/:id/move",
    async (request, reply) => {
      const { screenId, tabId, id } = request.params as {
        screenId: string;
        tabId: string;
        id: string;
      };
      const state = screensPriorityState(app.jira.store);
      const screen = findScreen(state, screenId);
      if (!screen) return fail(reply, 400, "The screen does not exist.");
      const tab = findTab(screen, tabId);
      if (!tab) return fail(reply, 400, "The tab does not exist.");
      const field = tab.fields.find((candidate) => candidate.id === id);
      if (!field) return fail(reply, 400, "The field is not on this tab.");
      const body = bodyObject(request.body);
      if (!body) return fail(reply, 400, "A field move body is required.");
      const error = movePlacement(tab.fields, field, body);
      if (error) return fail(reply, 400, error);
      app.jira.store.save();
      return reply.code(204).send();
    },
  );

  app.put(
    "/rest/api/2/screens/:screenId/tabs/:tabId/fields/:id/updateShowWhenEmptyIndicator/:newValue",
    async (request, reply) => {
      const { screenId, tabId, id, newValue } = request.params as {
        screenId: string;
        tabId: string;
        id: string;
        newValue: string;
      };
      const state = screensPriorityState(app.jira.store);
      const screen = findScreen(state, screenId);
      if (!screen) return fail(reply, 400, "The screen does not exist.");
      const tab = findTab(screen, tabId);
      if (!tab) return fail(reply, 400, "The tab does not exist.");
      const field = tab.fields.find((candidate) => candidate.id === id);
      if (!field) return fail(reply, 400, "The field is not on this tab.");
      if (newValue !== "true" && newValue !== "false") {
        return fail(reply, 400, "newValue must be true or false.", "newValue");
      }
      field.showWhenEmpty = newValue === "true";
      app.jira.store.save();
      return reply.code(204).send();
    },
  );
};

export default routes;
