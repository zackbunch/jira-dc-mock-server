import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { jiraError } from "../shared/errors.js";
import { getResourceState } from "../store.js";

interface AvatarRecord {
  id: string;
  owner: string;
  selected: boolean;
  type: string;
  system: boolean;
}

interface Cropping {
  cropperOffsetX: number;
  cropperOffsetY: number;
  cropperWidth: number;
  needsCropping: boolean;
  url: string;
}

interface TerminologyEntry {
  originalName: string;
  originalNamePlural: string;
  newName: string;
  newNamePlural: string;
  isDefault: boolean;
}

interface UpgradeResult {
  duration: number;
  message: string;
  outcome: string;
  startTime: string;
}

interface SystemAssetsState {
  avatarCounter: number;
  avatars: AvatarRecord[];
  temporaryAvatars: Record<string, Cropping>;
  emailTemplates: {
    uploadedHash: string | null;
    uploadedBytes: number;
    active: "default" | "uploaded";
  };
  terminology: TerminologyEntry[];
  upgradeResult: UpgradeResult | null;
}

function defaultSystemAssetsState(): SystemAssetsState {
  return {
    avatarCounter: 15004,
    avatars: [
      { id: "15000", owner: "system", selected: true, type: "project", system: true },
      { id: "15001", owner: "system", selected: true, type: "issuetype", system: true },
      { id: "15002", owner: "T100ZB", selected: true, type: "project", system: false },
      { id: "15003", owner: "developer", selected: true, type: "user", system: false },
    ],
    temporaryAvatars: {},
    emailTemplates: { uploadedHash: null, uploadedBytes: 0, active: "default" },
    terminology: [
      {
        originalName: "Epic",
        originalNamePlural: "Epics",
        newName: "Epic",
        newNamePlural: "Epics",
        isDefault: true,
      },
      {
        originalName: "Sprint",
        originalNamePlural: "Sprints",
        newName: "Sprint",
        newNamePlural: "Sprints",
        isDefault: true,
      },
    ],
    upgradeResult: null,
  };
}

const VALID_AVATAR_TYPES = new Set(["project", "issuetype", "user"]);

const systemAssetsRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/zip",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    /^multipart\/form-data(?:;.*)?$/,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  const state = () => getResourceState(app.jira.store, "system-assets", defaultSystemAssetsState);
  const avatarBean = (avatar: AvatarRecord) => ({
    id: avatar.id,
    owner: avatar.owner,
    selected: avatar.selected,
  });
  const validateAvatarType = (type: string) => VALID_AVATAR_TYPES.has(type.toLowerCase());
  const cropping = (key: string): Cropping => ({
    cropperOffsetX: 0,
    cropperOffsetY: 0,
    cropperWidth: 128,
    needsCropping: true,
    url: `${app.jira.baseUrl}/secure/temporaryavatar?key=${encodeURIComponent(key)}`,
  });

  app.get("/rest/api/2/avatar/:type/system", async (request, reply) => {
    const { type } = request.params as { type: string };
    if (!validateAvatarType(type)) {
      return reply.code(500).send(jiraError(["Avatar type is not supported."]));
    }
    const avatar = state().avatars.find(
      (candidate) => candidate.system && candidate.type === type.toLowerCase(),
    );
    if (!avatar) return reply.code(500).send(jiraError(["System avatar was not found."]));
    return avatarBean(avatar);
  });

  app.post("/rest/api/2/avatar/:type/temporary", async (request, reply) => {
    const { type } = request.params as { type: string };
    const query = request.query as { filename?: string; size?: string };
    if (!validateAvatarType(type)) {
      return reply.code(400).send(jiraError(["Avatar type is not supported."]));
    }
    const size = Number(query.size ?? 128);
    if (!Number.isFinite(size) || size < 1 || size > 4096) {
      return reply.code(400).send(jiraError(["Avatar size is invalid."]));
    }
    const key = `system:${type.toLowerCase()}`;
    const value = cropping(key);
    value.cropperWidth = Math.min(256, Math.floor(size));
    state().temporaryAvatars[key] = value;
    app.jira.store.save();
    return reply.code(201).send(structuredClone(value));
  });

  app.post(
    "/rest/api/2/avatar/:type/temporaryCrop",
    {
      schema: {
        body: {
          type: "object",
          required: ["cropperOffsetX", "cropperOffsetY", "cropperWidth"],
          properties: {
            cropperOffsetX: { type: "integer", minimum: 0 },
            cropperOffsetY: { type: "integer", minimum: 0 },
            cropperWidth: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { type } = request.params as { type: string };
      const key = `system:${type.toLowerCase()}`;
      if (!validateAvatarType(type) || !state().temporaryAvatars[key]) {
        return reply.code(400).send(jiraError(["No temporary avatar is available."]));
      }
      const avatar: AvatarRecord = {
        id: String(state().avatarCounter++),
        owner: "system",
        selected: false,
        type: type.toLowerCase(),
        system: true,
      };
      state().avatars.push(avatar);
      delete state().temporaryAvatars[key];
      app.jira.store.save();
      // The pinned contract omits the successful response entirely. Jira's
      // neighboring avatar-create operation returns AvatarBean with 201.
      return reply.code(201).send(avatarBean(avatar));
    },
  );

  const ownerExists = (type: string, owner: string) => {
    if (type === "project") {
      return app.jira.store.state.projects.some(
        (project) => project.id === owner || project.key === owner,
      );
    }
    if (type === "issuetype") {
      return app.jira.store.state.issueTypes.some((issueType) => issueType.id === owner);
    }
    if (type === "user") {
      return app.jira.store.state.users.some(
        (user) => user.key === owner || user.name === owner,
      );
    }
    return false;
  };

  app.get(
    "/rest/api/2/universal_avatar/type/:type/owner/:owningObjectId",
    async (request, reply) => {
      const { type, owningObjectId } = request.params as {
        type: string;
        owningObjectId: string;
      };
      if (!ownerExists(type, owningObjectId)) {
        return reply.code(404).send(jiraError(["Avatar owner was not found."]));
      }
      const avatar = state().avatars.find(
        (candidate) =>
          candidate.type === type && candidate.owner === owningObjectId && candidate.selected,
      ) ?? state().avatars.find(
        (candidate) => candidate.type === type && candidate.owner === owningObjectId,
      ) ?? state().avatars.find((candidate) => candidate.type === type && candidate.system);
      if (!avatar) return reply.code(404).send(jiraError(["Avatar was not found."]));
      return avatarBean(avatar);
    },
  );

  app.post(
    "/rest/api/2/universal_avatar/type/:type/owner/:owningObjectId/temp",
    async (request, reply) => {
      const { type, owningObjectId } = request.params as {
        type: string;
        owningObjectId: string;
      };
      if (!ownerExists(type, owningObjectId)) {
        return reply.code(404).send(jiraError(["Avatar owner was not found."]));
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send(jiraError(["A multipart avatar file is required."]));
      }
      const key = `${type}:${owningObjectId}`;
      state().temporaryAvatars[key] = cropping(key);
      app.jira.store.save();
      return structuredClone(state().temporaryAvatars[key]);
    },
  );

  app.post(
    "/rest/api/2/universal_avatar/type/:type/owner/:owningObjectId/avatar",
    {
      schema: {
        body: {
          type: "object",
          required: ["cropperOffsetX", "cropperOffsetY", "cropperWidth"],
          properties: {
            cropperOffsetX: { type: "integer", minimum: 0 },
            cropperOffsetY: { type: "integer", minimum: 0 },
            cropperWidth: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { type, owningObjectId } = request.params as {
        type: string;
        owningObjectId: string;
      };
      const key = `${type}:${owningObjectId}`;
      if (!ownerExists(type, owningObjectId)) {
        return reply.code(404).send(jiraError(["Avatar owner was not found."]));
      }
      if (!state().temporaryAvatars[key]) {
        return reply.code(400).send(jiraError(["No temporary avatar is available."]));
      }
      for (const existing of state().avatars) {
        if (existing.owner === owningObjectId && existing.type === type) existing.selected = false;
      }
      const avatar: AvatarRecord = {
        id: String(state().avatarCounter++),
        owner: owningObjectId,
        selected: true,
        type,
        system: false,
      };
      state().avatars.push(avatar);
      delete state().temporaryAvatars[key];
      app.jira.store.save();
      return reply.code(201).send(avatarBean(avatar));
    },
  );

  app.delete(
    "/rest/api/2/universal_avatar/type/:type/owner/:owningObjectId/avatar/:id",
    async (request, reply) => {
      const { type, owningObjectId, id } = request.params as {
        type: string;
        owningObjectId: string;
        id: string;
      };
      const index = state().avatars.findIndex(
        (avatar) => !avatar.system && avatar.type === type && avatar.owner === owningObjectId && avatar.id === id,
      );
      if (index < 0) return reply.code(404).send(jiraError(["Avatar was not found."]));
      state().avatars.splice(index, 1);
      app.jira.store.save();
      return reply.code(200).send();
    },
  );

  const emptyZip = Buffer.from([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);

  app.get("/rest/api/2/email-templates", async (_request, reply) =>
    reply
      .header("content-disposition", 'attachment; filename="jira-email-templates.zip"')
      .type("application/zip")
      .send(emptyZip),
  );
  app.post("/rest/api/2/email-templates", async (request, reply) => {
    if (!Buffer.isBuffer(request.body) || request.body.length < 4) {
      return reply.code(500).send(jiraError(["The uploaded template archive is invalid."]));
    }
    state().emailTemplates.uploadedHash = createHash("sha256").update(request.body).digest("hex");
    state().emailTemplates.uploadedBytes = request.body.length;
    app.jira.store.save();
    return reply.code(200).send();
  });
  app.post("/rest/api/2/email-templates/apply", async (_request, reply) => {
    if (!state().emailTemplates.uploadedHash) {
      return reply.code(400).send(jiraError(["No email templates have been uploaded."]));
    }
    state().emailTemplates.active = "uploaded";
    app.jira.store.save();
    return reply.code(200).send();
  });
  app.post("/rest/api/2/email-templates/revert", async (_request, reply) => {
    state().emailTemplates = { uploadedHash: null, uploadedBytes: 0, active: "default" };
    app.jira.store.save();
    return reply.code(200).send();
  });
  app.get("/rest/api/2/email-templates/types", async (_request, reply) =>
    reply.type("text/plain; charset=utf-8").send("html,text,subject"),
  );

  app.get("/rest/api/2/terminology/entries", async () => structuredClone(state().terminology));
  app.get("/rest/api/2/terminology/entries/:originalName", async (request, reply) => {
    const { originalName } = request.params as { originalName: string };
    const entry = state().terminology.find(
      (candidate) => candidate.originalName.toLowerCase() === originalName.toLowerCase(),
    );
    if (!entry) return reply.code(404).send(jiraError(["Terminology entry was not found."]));
    return structuredClone(entry);
  });
  app.post(
    "/rest/api/2/terminology/entries",
    {
      schema: {
        body: {
          type: "object",
          required: ["originalName", "newName", "newNamePlural"],
          properties: {
            originalName: { type: "string", minLength: 1 },
            newName: { type: "string", minLength: 1 },
            newNamePlural: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        originalName: string;
        newName: string;
        newNamePlural: string;
      };
      const entry = state().terminology.find(
        (candidate) => candidate.originalName.toLowerCase() === body.originalName.toLowerCase(),
      );
      if (!entry) return reply.code(404).send(jiraError(["Terminology entry was not found."]));
      entry.newName = body.newName;
      entry.newNamePlural = body.newNamePlural;
      entry.isDefault =
        entry.newName === entry.originalName && entry.newNamePlural === entry.originalNamePlural;
      app.jira.store.save();
      // The pinned operation has no success response. Use an empty 204 for the
      // successful persistent update and document this narrow compatibility rule.
      return reply.code(204).send();
    },
  );

  app.get("/rest/api/2/upgrade", async (_request, reply) => {
    if (!state().upgradeResult) {
      return reply.code(404).send(jiraError(["No upgrade task has been run."]));
    }
    return structuredClone(state().upgradeResult);
  });
  app.post("/rest/api/2/upgrade", async (_request, reply) => {
    state().upgradeResult = {
      duration: 1250,
      message: "Synthetic Jira Data Center upgrade checks completed.",
      outcome: "SUCCESS",
      startTime: new Date().toISOString(),
    };
    app.jira.store.save();
    return reply.code(200).send();
  });

  app.post(
    "/rest/api/2/licenseValidator",
    { schema: { body: { type: "string", minLength: 1 } } },
    async (request) => {
      const licenseString = request.body as string;
      const valid = licenseString === "MOCK-JIRA-DC-10.3.5";
      return {
        licenseString,
        errors: valid ? {} : { license: "Only the deterministic mock license is accepted." },
      };
    },
  );
};

export default systemAssetsRoutes;
