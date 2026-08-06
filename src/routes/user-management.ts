import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { jiraError } from "../shared/errors.js";
import { parseInteger } from "../shared/parameters.js";
import { serializeUser } from "../shared/serialization.js";
import type { JiraUser } from "../types.js";
import {
  type ApplicationRole,
  type ManagedAvatar,
  userManagementState,
} from "../shared/user-management-state.js";

type Query = Record<string, string | string[] | boolean | number | undefined>;
type Body = Record<string, unknown>;

const defaultColumns = ["issuetype", "key", "summary", "priority", "status"];
const roleVersion = 'W/"user-management-1"';

function error(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send(jiraError([message]));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function userByIdentity(
  users: JiraUser[],
  query: Query,
  usernameKey = "username",
): JiraUser | undefined {
  const username = stringValue(query[usernameKey]);
  const key = stringValue(query.key ?? query.userKey);
  return users.find(
    (candidate) =>
      (username !== undefined && candidate.name.toLowerCase() === username.toLowerCase()) ||
      (key !== undefined && candidate.key === key),
  );
}

function userWriteBean(user: JiraUser, baseUrl: string): Body {
  return {
    self: `${baseUrl}/rest/api/2/user?username=${encodeURIComponent(user.name)}`,
    key: user.key,
    name: user.name,
    displayName: user.displayName,
    emailAddress: user.emailAddress,
    active: user.active,
  };
}

function matchingUsers(users: JiraUser[], search: string | undefined): JiraUser[] {
  const needle = (search ?? "").toLowerCase();
  return users.filter((user) =>
    [user.name, user.key, user.displayName, user.emailAddress].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

function parseExclusions(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return new Set(
    values
      .flatMap((entry) => String(entry).split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function roleBody(role: ApplicationRole): ApplicationRole {
  return structuredClone(role);
}

function groupBody(
  name: string,
  memberNames: string[],
  users: JiraUser[],
  baseUrl: string,
) {
  const members = memberNames
    .map((member) => users.find((user) => user.name === member))
    .filter((user): user is JiraUser => user !== undefined)
    .map((user) => serializeUser(user, baseUrl));
  return {
    name,
    self: `${baseUrl}/rest/api/2/group?groupname=${encodeURIComponent(name)}`,
    users: {
      size: members.length,
      maxResults: members.length,
      backingListSize: members.length,
      items: members,
    },
  };
}

function passwordPolicyMessages(password: string, username: string): string[] {
  const messages: string[] = [];
  if (password.length < 8) messages.push("The password must have at least 8 characters.");
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    messages.push("The password must not contain the username.");
  }
  return messages;
}

function validateRoleVersion(queryHeaders: Record<string, unknown>): boolean {
  const supplied = queryHeaders["if-match"] ?? queryHeaders.versionhash;
  return supplied === undefined || supplied === roleVersion;
}

const userManagementRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const values = new URLSearchParams(String(body));
      const parsed: Record<string, string | string[]> = {};
      for (const [key, value] of values) {
        const current = parsed[key];
        parsed[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
      }
      done(null, parsed);
    },
  );
  app.addContentTypeParser(/^multipart\/form-data(?:;.*)?$/, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/rest/api/2/applicationrole", async (_request, reply) => {
    reply.header("ETag", roleVersion);
    return userManagementState(app.jira.store).roles.map(roleBody);
  });

  app.put("/rest/api/2/applicationrole", async (request, reply) => {
    if (!validateRoleVersion(request.headers as Record<string, unknown>)) {
      return error(reply, 412, "The application role configuration has changed.");
    }
    const state = userManagementState(app.jira.store);
    const submitted = Array.isArray(request.body) ? request.body : [request.body];
    if (!submitted.every((item) => item && typeof item === "object")) {
      return error(reply, 400, "Application role data is required.");
    }
    const updated: ApplicationRole[] = [];
    for (const raw of submitted as Body[]) {
      const key = stringValue(raw.key);
      const role = state.roles.find((candidate) => candidate.key === key);
      if (!role) return error(reply, 404, `Application role '${key ?? ""}' does not exist.`);
      if (Array.isArray(raw.groups) && raw.groups.every((value) => typeof value === "string")) {
        role.groups = [...new Set(raw.groups as string[])];
      }
      if (Array.isArray(raw.defaultGroups) && raw.defaultGroups.every((value) => typeof value === "string")) {
        role.defaultGroups = [...new Set(raw.defaultGroups as string[])];
      }
      updated.push(roleBody(role));
    }
    app.jira.store.save();
    reply.header("ETag", roleVersion);
    return Array.isArray(request.body) ? updated : updated[0];
  });

  app.get("/rest/api/2/applicationrole/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const role = userManagementState(app.jira.store).roles.find((candidate) => candidate.key === key);
    if (!role) return error(reply, 404, `Application role '${key}' does not exist.`);
    reply.header("ETag", roleVersion);
    return roleBody(role);
  });

  app.put("/rest/api/2/applicationrole/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    const query = request.query as Query;
    if (!validateRoleVersion({ ...request.headers, versionhash: query.versionHash })) {
      return error(reply, 412, "The application role configuration has changed.");
    }
    const state = userManagementState(app.jira.store);
    const role = state.roles.find((candidate) => candidate.key === key);
    if (!role) return error(reply, 404, `Application role '${key}' does not exist.`);
    const body = (request.body ?? {}) as Body;
    if (Array.isArray(body.groups) && body.groups.every((value) => typeof value === "string")) {
      role.groups = [...new Set(body.groups as string[])];
    }
    if (Array.isArray(body.defaultGroups) && body.defaultGroups.every((value) => typeof value === "string")) {
      role.defaultGroups = [...new Set(body.defaultGroups as string[])];
    }
    app.jira.store.save();
    reply.header("ETag", roleVersion);
    return roleBody(role);
  });

  app.post("/rest/api/2/group", async (request, reply) => {
    const name = stringValue((request.body as Body | undefined)?.name);
    if (!name) return error(reply, 400, "A group name is required.");
    const state = userManagementState(app.jira.store);
    if (state.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      return error(reply, 400, `Group '${name}' already exists.`);
    }
    const group = { name, members: [] as string[] };
    state.groups.push(group);
    app.jira.store.save();
    return reply.code(201).send(groupBody(name, group.members, app.jira.store.state.users, app.jira.baseUrl));
  });

  app.delete("/rest/api/2/group", async (request, reply) => {
    const query = request.query as Query;
    const name = stringValue(query.groupname);
    if (!name) return error(reply, 400, "A group name is required.");
    const state = userManagementState(app.jira.store);
    const index = state.groups.findIndex((group) => group.name.toLowerCase() === name.toLowerCase());
    if (index < 0) return error(reply, 404, `Group '${name}' does not exist.`);
    const swapName = stringValue(query.swapGroup);
    if (swapName && !state.groups.some((group) => group.name === swapName)) {
      return error(reply, 400, `Swap group '${swapName}' does not exist.`);
    }
    for (const role of state.roles) {
      role.groups = role.groups.map((group) => (group === state.groups[index].name && swapName ? swapName : group)).filter((group) => group !== state.groups[index].name || Boolean(swapName));
      role.defaultGroups = role.defaultGroups.map((group) => (group === state.groups[index].name && swapName ? swapName : group)).filter((group) => group !== state.groups[index].name || Boolean(swapName));
    }
    state.groups.splice(index, 1);
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.get("/rest/api/2/group/member", async (request, reply) => {
    const query = request.query as Query;
    const name = stringValue(query.groupname);
    if (!name) return error(reply, 400, "A group name is required.");
    const group = userManagementState(app.jira.store).groups.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!group) return error(reply, 404, `Group '${name}' does not exist.`);
    const includeInactive = booleanValue(query.includeInactiveUsers, false);
    const allMembers = group.members
      .map((member) => app.jira.store.state.users.find((user) => user.name === member))
      .filter((user): user is JiraUser => user !== undefined && (includeInactive || user.active));
    const startAt = parseInteger(query.startAt as string | undefined, 0);
    const maxResults = parseInteger(query.maxResults as string | undefined, 50, 1000);
    const values = allMembers.slice(startAt, startAt + maxResults).map((user) => serializeUser(user, app.jira.baseUrl));
    return {
      self: `${app.jira.baseUrl}/rest/api/2/group/member?groupname=${encodeURIComponent(name)}`,
      startAt,
      maxResults,
      total: allMembers.length,
      isLast: startAt + values.length >= allMembers.length,
      values,
    };
  });

  app.post("/rest/api/2/group/user", async (request, reply) => {
    const query = request.query as Query;
    const groupName = stringValue(query.groupname);
    if (!groupName) return error(reply, 400, "A group name is required.");
    const state = userManagementState(app.jira.store);
    const group = state.groups.find((candidate) => candidate.name.toLowerCase() === groupName.toLowerCase());
    if (!group) return error(reply, 404, `Group '${groupName}' does not exist.`);
    const username = stringValue((request.body as Body | undefined)?.name);
    const user = app.jira.store.state.users.find((candidate) => candidate.name === username);
    if (!user) return error(reply, 404, `User '${username ?? ""}' does not exist.`);
    if (group.members.includes(user.name)) return error(reply, 400, `User '${user.name}' already belongs to the group.`);
    group.members.push(user.name);
    app.jira.store.save();
    return reply.code(201).send(groupBody(group.name, group.members, app.jira.store.state.users, app.jira.baseUrl));
  });

  app.delete("/rest/api/2/group/user", async (request, reply) => {
    const query = request.query as Query;
    const groupName = stringValue(query.groupname);
    const username = stringValue(query.username);
    if (!groupName || !username) return error(reply, 400, "Both groupname and username are required.");
    const state = userManagementState(app.jira.store);
    const group = state.groups.find((candidate) => candidate.name.toLowerCase() === groupName.toLowerCase());
    if (!group) return error(reply, 404, `Group '${groupName}' does not exist.`);
    if (!app.jira.store.state.users.some((user) => user.name === username) || !group.members.includes(username)) {
      return error(reply, 404, `User '${username}' is not a member of the group.`);
    }
    group.members = group.members.filter((member) => member !== username);
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.get("/rest/api/2/groups/picker", async (request) => {
    const query = request.query as Query;
    const needle = stringValue(query.query)?.toLowerCase() ?? "";
    const excluded = parseExclusions(query.exclude);
    const state = userManagementState(app.jira.store);
    let groups = state.groups.filter((group) => group.name.toLowerCase().includes(needle) && !excluded.has(group.name.toLowerCase()));
    const username = stringValue(query.userName);
    if (username) groups = groups.filter((group) => group.members.includes(username));
    const total = groups.length;
    const maxResults = parseInteger(query.maxResults as string | undefined, 20, 1000);
    groups = groups.slice(0, maxResults);
    return {
      header: `Showing ${groups.length} of ${total} matching groups`,
      total,
      groups: groups.map((group) => ({ name: group.name, html: group.name, labels: [] })),
    };
  });

  app.get("/rest/api/2/groupuserpicker", async (request) => {
    const query = request.query as Query;
    const needle = stringValue(query.query) ?? "";
    const maxResults = parseInteger(query.maxResults as string | undefined, 50, 1000);
    const users = matchingUsers(app.jira.store.state.users, needle).slice(0, maxResults);
    const groups = userManagementState(app.jira.store).groups
      .filter((group) => group.name.toLowerCase().includes(needle.toLowerCase()))
      .slice(0, maxResults);
    return {
      users: {
        header: `Showing ${users.length} matching users`,
        total: users.length,
        users: users.map((user) => ({
          name: user.name,
          key: user.key,
          displayName: user.displayName,
          html: user.displayName,
          ...(booleanValue(query.showAvatar, true) ? { avatarUrl: serializeUser(user, app.jira.baseUrl).avatarUrls["48x48"] } : {}),
        })),
      },
      groups: {
        header: `Showing ${groups.length} matching groups`,
        total: groups.length,
        groups: groups.map((group) => ({ name: group.name, html: group.name, labels: [] })),
      },
    };
  });

  app.get("/rest/api/2/mypreferences", async (request, reply) => {
    const key = stringValue((request.query as Query).key);
    const username = app.jira.currentUser().name;
    const value = key ? userManagementState(app.jira.store).preferences[username]?.[key] : undefined;
    if (value === undefined) return error(reply, 404, "The preference key was not found.");
    return reply.type("application/json").send(JSON.stringify(value));
  });

  app.put("/rest/api/2/mypreferences", async (request, reply) => {
    const key = stringValue((request.query as Query).key);
    const value = typeof request.body === "string" ? request.body : undefined;
    if (!key || value === undefined) return error(reply, 404, "Both a preference key and value are required.");
    const state = userManagementState(app.jira.store);
    const username = app.jira.currentUser().name;
    (state.preferences[username] ??= {})[key] = value;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.delete("/rest/api/2/mypreferences", async (request, reply) => {
    const key = stringValue((request.query as Query).key);
    const preferences = userManagementState(app.jira.store).preferences[app.jira.currentUser().name];
    if (!key || preferences?.[key] === undefined) return error(reply, 404, "The preference key was not found.");
    delete preferences[key];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.put("/rest/api/2/myself", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const user = app.jira.currentUser();
    const suppliedPassword = stringValue(body.password);
    const expectedPassword = userManagementState(app.jira.store).passwords[user.name] ?? app.jira.auth.password;
    if (suppliedPassword !== expectedPassword) return error(reply, 400, "The current password is incorrect.");
    if (body.displayName !== undefined && !stringValue(body.displayName)) return error(reply, 400, "displayName must not be empty.");
    if (body.emailAddress !== undefined && !stringValue(body.emailAddress)) return error(reply, 400, "emailAddress must not be empty.");
    if (stringValue(body.displayName)) user.displayName = stringValue(body.displayName)!;
    if (stringValue(body.emailAddress)) user.emailAddress = stringValue(body.emailAddress)!;
    app.jira.store.save();
    return userWriteBean(user, app.jira.baseUrl);
  });

  app.put("/rest/api/2/myself/password", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const user = app.jira.currentUser();
    const state = userManagementState(app.jira.store);
    const current = stringValue(body.currentPassword);
    const next = stringValue(body.password);
    if (current !== (state.passwords[user.name] ?? app.jira.auth.password) || !next) {
      return error(reply, 400, "The current password is incorrect or the new password is missing.");
    }
    const policy = passwordPolicyMessages(next, user.name);
    if (policy.length) return error(reply, 400, policy.join(" "));
    state.passwords[user.name] = next;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/password/policy", async (request, reply) => {
    const hasOldPassword = booleanValue((request.query as Query).hasOldPassword, false);
    const message = `The password must have at least 8 characters.${hasOldPassword ? " The current password is required." : ""}`;
    return reply.type("application/json").send(JSON.stringify(message));
  });

  app.post("/rest/api/2/password/policy/createUser", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const username = stringValue(body.username);
    const password = stringValue(body.password);
    if (!username || !password) return error(reply, 400, "username and password are required.");
    return reply.type("application/json").send(JSON.stringify(passwordPolicyMessages(password, username).join(" ")));
  });

  app.post("/rest/api/2/password/policy/updateUser", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const username = stringValue(body.username);
    const password = stringValue(body.newPassword);
    if (!username || !password) return error(reply, 400, "username and newPassword are required.");
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    return reply.type("application/json").send(JSON.stringify(passwordPolicyMessages(password, username).join(" ")));
  });

  app.get("/rest/api/2/user", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user || (user.deleted && !booleanValue(query.includeDeleted, false))) return error(reply, 404, "The requested user does not exist.");
    return serializeUser(user, app.jira.baseUrl);
  });

  app.post("/rest/api/2/user", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const name = stringValue(body.name);
    const displayName = stringValue(body.displayName);
    const emailAddress = stringValue(body.emailAddress);
    if (!name || !displayName || !emailAddress) return error(reply, 400, "name, displayName, and emailAddress are required.");
    if (app.jira.store.state.users.some((user) => user.name.toLowerCase() === name.toLowerCase())) return error(reply, 400, `User '${name}' already exists.`);
    const user: JiraUser = {
      key: stringValue(body.key) ?? name,
      name,
      displayName,
      emailAddress,
      active: body.active === undefined ? true : booleanValue(body.active, true),
      avatarUrls: {
        "16x16": `/secure/useravatar?size=xsmall&ownerId=${encodeURIComponent(name)}`,
        "24x24": `/secure/useravatar?size=small&ownerId=${encodeURIComponent(name)}`,
        "32x32": `/secure/useravatar?size=medium&ownerId=${encodeURIComponent(name)}`,
        "48x48": `/secure/useravatar?size=large&ownerId=${encodeURIComponent(name)}`,
      },
      timeZone: "UTC",
      locale: "en_US",
    };
    app.jira.store.state.users.push(user);
    const state = userManagementState(app.jira.store);
    state.passwords[name] = stringValue(body.password) ?? "changeme123";
    state.applications[name] = Array.isArray(body.applicationKeys) ? body.applicationKeys.filter((key): key is string => typeof key === "string") : [];
    state.avatars[name] = [{ id: String(state.nextAvatarId++), owner: name, selected: true, system: true }];
    app.jira.store.save();
    return reply.code(201).send(userWriteBean(user, app.jira.baseUrl));
  });

  app.put("/rest/api/2/user", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user) return error(reply, 404, "The requested user does not exist.");
    const body = (request.body ?? {}) as Body;
    const newName = body.name === undefined ? user.name : stringValue(body.name);
    if (!newName) return error(reply, 400, "name must not be empty.");
    if (newName !== user.name && app.jira.store.state.users.some((candidate) => candidate.name === newName)) return error(reply, 400, `User '${newName}' already exists.`);
    const oldName = user.name;
    user.name = newName;
    if (body.key !== undefined && stringValue(body.key)) user.key = stringValue(body.key)!;
    if (body.displayName !== undefined && stringValue(body.displayName)) user.displayName = stringValue(body.displayName)!;
    if (body.emailAddress !== undefined && stringValue(body.emailAddress)) user.emailAddress = stringValue(body.emailAddress)!;
    if (body.active !== undefined) user.active = booleanValue(body.active, user.active);
    const state = userManagementState(app.jira.store);
    if (oldName !== newName) {
      for (const group of state.groups) group.members = group.members.map((member) => member === oldName ? newName : member);
      for (const record of [state.preferences, state.passwords, state.applications, state.properties, state.columns, state.avatars]) {
        if (oldName in record) {
          (record as Record<string, unknown>)[newName] = (record as Record<string, unknown>)[oldName];
          delete (record as Record<string, unknown>)[oldName];
        }
      }
      for (const avatar of state.avatars[newName] ?? []) avatar.owner = newName;
    }
    app.jira.store.save();
    return userWriteBean(user, app.jira.baseUrl);
  });

  app.delete("/rest/api/2/user", async (request, reply) => {
    const user = userByIdentity(app.jira.store.state.users, request.query as Query);
    if (!user) return error(reply, 404, "The requested user does not exist.");
    if (user.name === app.jira.currentUser().name) return error(reply, 400, "The currently authenticated user cannot be deleted.");
    app.jira.store.state.users = app.jira.store.state.users.filter((candidate) => candidate !== user);
    const state = userManagementState(app.jira.store);
    for (const group of state.groups) group.members = group.members.filter((member) => member !== user.name);
    delete state.preferences[user.name];
    delete state.passwords[user.name];
    delete state.applications[user.name];
    delete state.properties[user.name];
    delete state.columns[user.name];
    delete state.avatars[user.name];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/user/a11y/personal-settings", async () => [
    { key: "a11y-setting-underlined-links", enabled: false },
    { key: "a11y-setting-high-contrast", enabled: false },
  ]);

  const validationFor = (user: JiraUser, expand?: string) => ({
    success: true,
    businessLogicValidationFailed: false,
    deleted: Boolean(user.deleted),
    displayName: user.displayName,
    email: user.emailAddress,
    userKey: user.key,
    userName: user.name,
    expand: expand ?? "",
    operations: ["USER_DISABLE", "USER_KEY_CHANGE", "USER_NAME_CHANGE", "USER_ANONYMIZE_PLUGIN_POINTS"],
    affectedEntities: {},
    errors: {},
    warnings: {},
  });

  app.get("/rest/api/2/user/anonymization", async (request, reply) => {
    const query = request.query as Query;
    const userKey = stringValue(query.userKey);
    if (!userKey) return error(reply, 400, "userKey is required.");
    const user = app.jira.store.state.users.find((candidate) => candidate.key === userKey);
    if (!user) return error(reply, 400, `User '${userKey}' does not exist.`);
    return validationFor(user, stringValue(query.expand));
  });

  const scheduleAnonymization = async (request: { body: unknown }, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Body;
    const userKey = stringValue(body.userKey);
    if (!userKey) return error(reply, 400, "userKey is required.");
    const user = app.jira.store.state.users.find((candidate) => candidate.key === userKey);
    if (!user) return error(reply, 400, `User '${userKey}' does not exist.`);
    const state = userManagementState(app.jira.store);
    if (state.anonymizationTasks.some((task) => task.status === "IN_PROGRESS")) return error(reply, 409, "Another anonymization task is already in progress.");
    const task = { id: state.nextTaskId++, userKey, status: "IN_PROGRESS" as const, progress: 25, submittedAt: new Date().toISOString() };
    state.anonymizationTasks.push(task);
    app.jira.store.save();
    return reply.code(202).send({ taskId: task.id });
  };

  app.post("/rest/api/2/user/anonymization", scheduleAnonymization);

  app.get("/rest/api/2/user/anonymization/progress", async (request, reply) => {
    const id = Number((request.query as Query).taskId);
    const task = userManagementState(app.jira.store).anonymizationTasks.find((candidate) => candidate.id === id);
    if (!task) return error(reply, 404, "The anonymization task does not exist.");
    return { taskId: task.id, status: task.status, progress: task.progress, userKey: task.userKey, submittedAt: task.submittedAt };
  });

  app.get("/rest/api/2/user/anonymization/rerun", async (request, reply) => {
    const query = request.query as Query;
    const userKey = stringValue(query.userKey);
    const oldUserKey = stringValue(query.oldUserKey);
    const oldUserName = stringValue(query.oldUserName);
    if (!userKey || !oldUserKey || !oldUserName) return error(reply, 400, "userKey, oldUserKey, and oldUserName are required.");
    const user = app.jira.store.state.users.find((candidate) => candidate.key === userKey);
    if (!user) return error(reply, 400, `User '${userKey}' does not exist.`);
    return validationFor(user, stringValue(query.expand));
  });

  app.post("/rest/api/2/user/anonymization/rerun", scheduleAnonymization);

  app.delete("/rest/api/2/user/anonymization/unlock", async (_request, reply) => {
    const state = userManagementState(app.jira.store);
    const stale = state.anonymizationTasks.findIndex((task) => task.status === "IN_PROGRESS");
    if (stale < 0) return error(reply, 404, "There is no stale anonymization task.");
    state.anonymizationTasks.splice(stale, 1);
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.post("/rest/api/2/user/application", async (request, reply) => {
    const query = request.query as Query;
    const username = stringValue(query.username);
    const applicationKey = stringValue(query.applicationKey);
    if (!username || !applicationKey) return error(reply, 400, "username and applicationKey are required.");
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 400, `User '${username}' does not exist.`);
    const state = userManagementState(app.jira.store);
    if (!state.roles.some((role) => role.key === applicationKey)) return error(reply, 400, `Application '${applicationKey}' does not exist.`);
    const applications = (state.applications[username] ??= []);
    if (!applications.includes(applicationKey)) applications.push(applicationKey);
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/user/application", async (request, reply) => {
    const query = request.query as Query;
    const username = stringValue(query.username);
    const applicationKey = stringValue(query.applicationKey);
    if (!username || !applicationKey) return error(reply, 400, "username and applicationKey are required.");
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 400, `User '${username}' does not exist.`);
    const state = userManagementState(app.jira.store);
    state.applications[username] = (state.applications[username] ?? []).filter((key) => key !== applicationKey);
    app.jira.store.save();
    return reply.code(204).send();
  });

  const searchedUsers = (query: Query, maximum: number) => matchingUsers(app.jira.store.state.users, stringValue(query.username))
    .slice(0, parseInteger(query.maxResults as number | string | undefined, 50, maximum))
    .map((user) => serializeUser(user, app.jira.baseUrl));

  app.get("/rest/api/2/user/assignable/multiProjectSearch", async (request, reply) => {
    const query = request.query as Query;
    const keys = stringValue(query.projectKeys)?.split(",").map((key) => key.trim()).filter(Boolean);
    if (!keys?.length || keys.some((key) => !app.jira.store.state.projects.some((project) => project.key === key))) return error(reply, 404, "One or more projects do not exist.");
    return searchedUsers(query, 100);
  });

  app.get("/rest/api/2/user/assignable/search", async (request, reply) => {
    const query = request.query as Query;
    const issueKey = stringValue(query.issueKey);
    const projectKey = stringValue(query.project);
    if (issueKey && !app.jira.findIssue(issueKey)) return error(reply, 404, `Issue '${issueKey}' does not exist.`);
    if (projectKey && !app.jira.store.state.projects.some((project) => project.key === projectKey || project.id === projectKey)) return error(reply, 404, `Project '${projectKey}' does not exist.`);
    return searchedUsers(query, 100);
  });

  function avatarsFor(username: string): ManagedAvatar[] {
    const state = userManagementState(app.jira.store);
    return (state.avatars[username] ??= [{ id: String(state.nextAvatarId++), owner: username, selected: true, system: true }]);
  }

  app.put("/rest/api/2/user/avatar", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    const id = stringValue((request.body as Body | undefined)?.id);
    const avatars = avatarsFor(username);
    const avatar = avatars.find((candidate) => candidate.id === id);
    if (!avatar) return error(reply, 400, "The requested avatar does not exist.");
    for (const candidate of avatars) candidate.selected = candidate === avatar;
    app.jira.store.save();
    return structuredClone(avatar);
  });

  app.post("/rest/api/2/user/avatar", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    const body = (request.body ?? {}) as Body;
    for (const field of ["cropperOffsetX", "cropperOffsetY", "cropperWidth"]) {
      if (body[field] !== undefined && (!Number.isInteger(body[field]) || Number(body[field]) < 0)) return error(reply, 400, "Avatar cropping coordinates must be non-negative integers.");
    }
    const state = userManagementState(app.jira.store);
    const avatars = avatarsFor(username);
    for (const candidate of avatars) candidate.selected = false;
    const avatar = { id: String(state.nextAvatarId++), owner: username, selected: true };
    avatars.push(avatar);
    app.jira.store.save();
    return reply.code(201).send(avatar);
  });

  app.post("/rest/api/2/user/avatar/temporary", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    return reply.type("text/html").code(201).send(`<html><body><textarea>{"url":"${app.jira.baseUrl}/secure/temporaryavatar?owner=${encodeURIComponent(username)}","cropperWidth":120,"cropperOffsetX":0,"cropperOffsetY":0}</textarea></body></html>`);
  });

  app.delete("/rest/api/2/user/avatar/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    const avatars = avatarsFor(username);
    const index = avatars.findIndex((avatar) => avatar.id === id && !avatar.system);
    if (index < 0) return error(reply, 404, "The avatar does not exist or cannot be deleted.");
    const wasSelected = avatars[index].selected;
    avatars.splice(index, 1);
    if (wasSelected && avatars[0]) avatars[0].selected = true;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/user/avatars", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    const avatars = avatarsFor(username).map((avatar) => structuredClone(avatar));
    return { system: avatars.filter((avatar) => avatar.system), custom: avatars.filter((avatar) => !avatar.system) };
  });

  app.get("/rest/api/2/user/columns", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    return { columns: structuredClone(userManagementState(app.jira.store).columns[username] ?? defaultColumns) };
  });

  app.put("/rest/api/2/user/columns", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const username = stringValue(body.username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    const rawColumns = Array.isArray(body.columns) ? body.columns : typeof body.columns === "string" ? [body.columns] : [];
    const columns = rawColumns.flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
    if (!columns.length) return error(reply, 400, "At least one column is required.");
    userManagementState(app.jira.store).columns[username] = columns;
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.delete("/rest/api/2/user/columns", async (request, reply) => {
    const username = stringValue((request.query as Query).username) ?? app.jira.currentUser().name;
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    delete userManagementState(app.jira.store).columns[username];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/user/duplicated/count", async () => ({ count: 0 }));
  app.get("/rest/api/2/user/duplicated/list", async () => ({ duplicates: [] }));

  app.get("/rest/api/2/user/list", async (request) => {
    const query = request.query as Query;
    const cursor = parseInteger(query.cursor as number | string | undefined, 0);
    const maxResults = parseInteger(query.maxResults as number | string | undefined, 2000, 10000);
    const users = app.jira.store.state.users.slice(cursor, cursor + maxResults).map((user) => serializeUser(user, app.jira.baseUrl));
    const nextCursor = cursor + users.length;
    const isLast = nextCursor >= app.jira.store.state.users.length;
    const self = `${app.jira.baseUrl}/rest/api/2/user/list?cursor=${cursor}&maxResults=${maxResults}`;
    return { self, maxResults, isLast, values: users, ...(!isLast ? { nextCursor: String(nextCursor), nextPage: `${app.jira.baseUrl}/rest/api/2/user/list?cursor=${nextCursor}&maxResults=${maxResults}` } : {}) };
  });

  app.put("/rest/api/2/user/password", async (request, reply) => {
    const user = userByIdentity(app.jira.store.state.users, request.query as Query);
    if (!user) return error(reply, 404, "The requested user does not exist.");
    const password = stringValue((request.body as Body | undefined)?.password);
    if (!password) return error(reply, 400, "A new password is required.");
    const policy = passwordPolicyMessages(password, user.name);
    if (policy.length) return error(reply, 400, policy.join(" "));
    userManagementState(app.jira.store).passwords[user.name] = password;
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/user/permission/search", async (request, reply) => {
    const query = request.query as Query;
    const issueKey = stringValue(query.issueKey);
    const projectKey = stringValue(query.projectKey);
    const permissions = stringValue(query.permissions)?.split(",").map((permission) => permission.trim()).filter(Boolean);
    if ((!issueKey && !projectKey) || !permissions?.length) return error(reply, 400, "A project or issue and at least one permission are required.");
    if (issueKey && !app.jira.findIssue(issueKey)) return error(reply, 404, `Issue '${issueKey}' does not exist.`);
    if (projectKey && !app.jira.store.state.projects.some((project) => project.key === projectKey)) return error(reply, 404, `Project '${projectKey}' does not exist.`);
    const startAt = parseInteger(query.startAt as number | string | undefined, 0);
    return matchingUsers(app.jira.store.state.users.filter((user) => user.active), stringValue(query.username))
      .slice(startAt, startAt + parseInteger(query.maxResults as number | string | undefined, 50, 1000))
      .map((user) => serializeUser(user, app.jira.baseUrl));
  });

  app.get("/rest/api/2/user/picker", async (request) => {
    const query = request.query as Query;
    const search = stringValue(query.query) ?? "";
    const excluded = parseExclusions(query.exclude);
    const matches = matchingUsers(app.jira.store.state.users, search)
      .filter((user) => !excluded.has(user.name.toLowerCase()) && !excluded.has(user.key.toLowerCase()));
    const total = matches.length;
    const users = matches.slice(0, parseInteger(query.maxResults as number | string | undefined, 50, 1000));
    return {
      header: `Showing ${users.length} of ${total} matching users`,
      total,
      users: users.map((user) => ({
        name: user.name,
        key: user.key,
        displayName: user.displayName,
        html: user.displayName,
        ...(booleanValue(query.showAvatar, false) ? { avatarUrl: serializeUser(user, app.jira.baseUrl).avatarUrls["48x48"] } : {}),
      })),
    };
  });

  app.get("/rest/api/2/user/properties", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user) return error(reply, query.username === undefined && query.userKey === undefined ? 400 : 404, "The requested user does not exist.");
    const properties = userManagementState(app.jira.store).properties[user.name] ?? {};
    return { keys: Object.keys(properties).sort().map((key) => ({ key, self: `${app.jira.baseUrl}/rest/api/2/user/properties/${encodeURIComponent(key)}?userKey=${encodeURIComponent(user.key)}` })) };
  });

  app.get("/rest/api/2/user/properties/:propertyKey", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user) return error(reply, query.username === undefined && query.userKey === undefined ? 400 : 404, "The requested user does not exist.");
    const { propertyKey } = request.params as { propertyKey: string };
    const value = userManagementState(app.jira.store).properties[user.name]?.[propertyKey];
    if (value === undefined) return error(reply, 404, `Property '${propertyKey}' does not exist.`);
    return { key: propertyKey, value };
  });

  app.put("/rest/api/2/user/properties/:propertyKey", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user) return error(reply, query.username === undefined && query.userKey === undefined ? 400 : 404, "The requested user does not exist.");
    const { propertyKey } = request.params as { propertyKey: string };
    if (!propertyKey || Buffer.byteLength(propertyKey) > 255) return error(reply, 400, "The property key must be at most 255 bytes.");
    const state = userManagementState(app.jira.store);
    const properties = (state.properties[user.name] ??= {});
    const existed = propertyKey in properties;
    properties[propertyKey] = request.body;
    app.jira.store.save();
    return reply.code(existed ? 200 : 201).send();
  });

  app.delete("/rest/api/2/user/properties/:propertyKey", async (request, reply) => {
    const query = request.query as Query;
    const user = userByIdentity(app.jira.store.state.users, query);
    if (!user) return error(reply, query.username === undefined && query.userKey === undefined ? 400 : 404, "The requested user does not exist.");
    const { propertyKey } = request.params as { propertyKey: string };
    const properties = userManagementState(app.jira.store).properties[user.name];
    if (!properties || !(propertyKey in properties)) return error(reply, 404, `Property '${propertyKey}' does not exist.`);
    delete properties[propertyKey];
    app.jira.store.save();
    return reply.code(204).send();
  });

  app.get("/rest/api/2/user/search", async (request, reply) => {
    const query = request.query as Query;
    const includeActive = booleanValue(query.includeActive, true);
    const includeInactive = booleanValue(query.includeInactive, false);
    if (!includeActive && !includeInactive) return error(reply, 400, "At least one of includeActive or includeInactive must be true.");
    const startAt = parseInteger(query.startAt as number | string | undefined, 0);
    const maxResults = parseInteger(query.maxResults as number | string | undefined, 50, 1000);
    return matchingUsers(app.jira.store.state.users, stringValue(query.username))
      .filter((user) => (user.active ? includeActive : includeInactive))
      .slice(startAt, startAt + maxResults)
      .map((user) => serializeUser(user, app.jira.baseUrl));
  });

  app.delete("/rest/api/2/user/session/:username", async (request, reply) => {
    const { username } = request.params as { username: string };
    if (!app.jira.store.state.users.some((user) => user.name === username)) return error(reply, 404, `User '${username}' does not exist.`);
    return reply.code(200).send();
  });

  app.get("/rest/api/2/user/viewissue/search", async (request, reply) => {
    const query = request.query as Query;
    const issueKey = stringValue(query.issueKey);
    const projectKey = stringValue(query.projectKey);
    if (!issueKey && !projectKey) return error(reply, 400, "Either issueKey or projectKey is required.");
    if (issueKey && !app.jira.findIssue(issueKey)) return error(reply, 404, `Issue '${issueKey}' does not exist.`);
    if (projectKey && !app.jira.store.state.projects.some((project) => project.key === projectKey)) return error(reply, 404, `Project '${projectKey}' does not exist.`);
    const username = stringValue(query.username);
    if (!username) return [];
    return matchingUsers(app.jira.store.state.users.filter((user) => user.active), username)
      .slice(0, parseInteger(query.maxResults as number | string | undefined, 50, 100))
      .map((user) => serializeUser(user, app.jira.baseUrl));
  });
};

export default userManagementRoutes;
