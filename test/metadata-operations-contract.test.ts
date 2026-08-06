import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertArrayItemsMatchResponse,
  assertEmptyResponseDocumented,
  assertMatchesResponse,
  assertMatchesSchema,
  authorization,
  operation,
  responseSchema,
  type OpenApiSchema,
} from "./helpers/official-contract.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jira-metadata-contract-"));
  const dataFile = join(directory, "state.json");
  const apps: ReturnType<typeof buildApp>[] = [];
  const open = () => {
    const app = buildApp({ dataFile, baseUrl: "http://jira.test" });
    apps.push(app);
    return app;
  };
  t.after(async () => {
    await Promise.all(apps.map(async (app) => app.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { dataFile, open };
}

async function json(app: ReturnType<typeof buildApp>, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) {
  const response = await app.inject({ method, url, headers: authorization, ...(payload === undefined ? {} : { payload }) });
  return { response, body: response.body.length > 0 ? response.json() : undefined };
}

function assertPageItems(path: string, method: string, body: unknown) {
  assert.ok(body && typeof body === "object");
  const page = body as { startAt: number; maxResults: number; total: number; values: unknown[] };
  assert.ok(Array.isArray(page.values));
  assert.ok(page.total >= page.values.length);
  for (const item of page.values) assertMatchesSchema(responseSchema(path, method, 200), item, `${method.toUpperCase()} ${path} page item`);
}

test("metadata read operations match the pinned Jira 10.3 schemas", async (t) => {
  const app = fixture(t).open();

  const fields = await json(app, "GET", "/rest/api/2/field");
  assert.equal(fields.response.statusCode, 200);
  assertArrayItemsMatchResponse("/api/2/field", "get", 200, fields.body);
  assert.ok((fields.body as { id: string }[]).some((field) => field.id === "customfield_10002"));

  const customFields = await json(app, "GET", "/rest/api/2/customFields?search=region&sortColumn=name&sortOrder=DESC&startAt=0&maxResults=1");
  assert.equal(customFields.response.statusCode, 200);
  assertMatchesResponse("/api/2/customFields", "get", 200, customFields.body);
  assertPageItems("/api/2/customFields", "get", customFields.body);
  assert.equal((customFields.body as { values: { name: string }[] }).values[0].name, "Delivery Region");

  const options = await json(app, "GET", "/rest/api/2/customFields/10003/options?query=west&page=1&maxResults=1&projectIds=10002&issueTypeIds=10001");
  assert.equal(options.response.statusCode, 200);
  assertMatchesResponse("/api/2/customFields/{customFieldId}/options", "get", 200, options.body);
  assert.equal((options.body as { total: number }).total, 1);

  const option = await json(app, "GET", "/rest/api/2/customFieldOption/20001");
  assert.equal(option.response.statusCode, 200);
  assertMatchesResponse("/api/2/customFieldOption/{id}", "get", 200, option.body);
  assert.equal((option.body as { value: string }).value, "US West");

  const issueTypes = await json(app, "GET", "/rest/api/2/issuetype");
  assert.equal(issueTypes.response.statusCode, 200);
  assertArrayItemsMatchResponse("/api/2/issuetype", "get", 200, issueTypes.body);
  const issueTypePage = await json(app, "GET", "/rest/api/2/issuetype/page?query=story&startAt=0&maxResults=1&projectIds=10002");
  assert.equal(issueTypePage.response.statusCode, 200);
  assertPageItems("/api/2/issuetype/page", "get", issueTypePage.body);
  assert.equal((issueTypePage.body as { total: number }).total, 1);
  const issueType = await json(app, "GET", "/rest/api/2/issuetype/10001");
  assertMatchesResponse("/api/2/issuetype/{id}", "get", 200, issueType.body);
  const alternatives = await json(app, "GET", "/rest/api/2/issuetype/10001/alternatives");
  assert.equal(alternatives.response.statusCode, 200);
  assertArrayItemsMatchResponse("/api/2/issuetype/{id}/alternatives", "get", 200, alternatives.body);

  const priorities = await json(app, "GET", "/rest/api/2/priority");
  assertArrayItemsMatchResponse("/api/2/priority", "get", 200, priorities.body);
  const priorityPage = await json(app, "GET", "/rest/api/2/priority/page?query=high&startAt=0&maxResults=1&projectIds=10002");
  assertPageItems("/api/2/priority/page", "get", priorityPage.body);
  assert.equal((priorityPage.body as { total: number }).total, 2);
  const priority = await json(app, "GET", "/rest/api/2/priority/1");
  assertMatchesResponse("/api/2/priority/{id}", "get", 200, priority.body);

  const resolutions = await json(app, "GET", "/rest/api/2/resolution");
  assertArrayItemsMatchResponse("/api/2/resolution", "get", 200, resolutions.body);
  const resolutionPage = await json(app, "GET", "/rest/api/2/resolution/page?query=fixed&startAt=0&maxResults=1");
  assertPageItems("/api/2/resolution/page", "get", resolutionPage.body);
  const resolution = await json(app, "GET", "/rest/api/2/resolution/1");
  assertMatchesResponse("/api/2/resolution/{id}", "get", 200, resolution.body);

  const statuses = await json(app, "GET", "/rest/api/2/status");
  assertArrayItemsMatchResponse("/api/2/status", "get", 200, statuses.body);
  const statusPage = await json(app, "GET", "/rest/api/2/status/page?query=progress&startAt=0&maxResults=1&projectIds=10002&issueTypeIds=10001");
  assertPageItems("/api/2/status/page", "get", statusPage.body);
  const status = await json(app, "GET", "/rest/api/2/status/In%20Progress");
  assertMatchesResponse("/api/2/status/{idOrName}", "get", 200, status.body);
  assert.equal((status.body as { id: string }).id, "3");

  const categories = await json(app, "GET", "/rest/api/2/statuscategory?request=synthetic&uriInfo=synthetic");
  assertArrayItemsMatchResponse("/api/2/statuscategory", "get", 200, categories.body);
  const category = await json(app, "GET", "/rest/api/2/statuscategory/done");
  assertMatchesResponse("/api/2/statuscategory/{idOrKey}", "get", 200, category.body);

  const linkTypes = await json(app, "GET", "/rest/api/2/issueLinkType");
  assertMatchesResponse("/api/2/issueLinkType", "get", 200, linkTypes.body);
  assert.ok((linkTypes.body as { issueLinkTypes: unknown[] }).issueLinkTypes.length > 0);
  const linkType = await json(app, "GET", "/rest/api/2/issueLinkType/10000");
  assertMatchesResponse("/api/2/issueLinkType/{issueLinkTypeId}", "get", 200, linkType.body);

  const propertyKeys = await json(app, "GET", "/rest/api/2/issuetype/10001/properties");
  assertMatchesResponse("/api/2/issuetype/{issueTypeId}/properties", "get", 200, propertyKeys.body);
  assert.deepEqual((propertyKeys.body as { keys: unknown[] }).keys, []);
});

test("metadata write operations persist and return documented empty bodies", async (t) => {
  const app = fixture(t).open();

  const createdField = await json(app, "POST", "/rest/api/2/field", {
    name: "Release Train", description: "Synthetic train selector", type: "com.example:select", searcherKey: "com.example:searcher", projectIds: [10002], issueTypeIds: ["10001"],
  });
  assert.equal(createdField.response.statusCode, 201);
  assertMatchesResponse("/api/2/field", "post", 201, createdField.body);
  const customFieldId = (createdField.body as { id: string }).id;

  const deletedFields = await json(app, "DELETE", `/rest/api/2/customFields?ids=${customFieldId},customfield_99999`);
  assert.equal(deletedFields.response.statusCode, 200);
  assertMatchesResponse("/api/2/customFields", "delete", 200, deletedFields.body);
  assert.deepEqual((deletedFields.body as { deletedCustomFields: string[] }).deletedCustomFields, [customFieldId]);

  const linkCreate = await json(app, "POST", "/rest/api/2/issueLinkType", { name: "Causes", inward: "is caused by", outward: "causes" });
  assert.equal(linkCreate.response.statusCode, 201);
  assert.equal(linkCreate.response.body, "");
  assertEmptyResponseDocumented("/api/2/issueLinkType", "post", 201);
  const links = await json(app, "GET", "/rest/api/2/issueLinkType");
  const linkId = (links.body as { issueLinkTypes: { id: string; name: string }[] }).issueLinkTypes.find((value) => value.name === "Causes")?.id;
  assert.ok(linkId);
  const linkUpdate = await json(app, "PUT", `/rest/api/2/issueLinkType/${linkId}`, { name: "Causes", inward: "is triggered by", outward: "triggers" });
  assert.equal(linkUpdate.response.statusCode, 200);
  assert.equal(linkUpdate.response.body, "");
  assertEmptyResponseDocumented("/api/2/issueLinkType/{issueLinkTypeId}", "put", 200);
  const linkDelete = await json(app, "DELETE", `/rest/api/2/issueLinkType/${linkId}`);
  assert.equal(linkDelete.response.statusCode, 204);
  assert.equal(linkDelete.response.body, "");
  assertEmptyResponseDocumented("/api/2/issueLinkType/{issueLinkTypeId}", "delete", 204);

  const typeCreate = await json(app, "POST", "/rest/api/2/issuetype", { name: "Spike", description: "Time-boxed research", type: "standard" });
  assert.equal(typeCreate.response.statusCode, 201);
  assert.equal(typeCreate.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetype", "post", 201);
  const types = await json(app, "GET", "/rest/api/2/issuetype");
  const typeId = (types.body as { id: string; name: string }[]).find((value) => value.name === "Spike")?.id;
  assert.ok(typeId);
  const typeUpdate = await json(app, "PUT", `/rest/api/2/issuetype/${typeId}`, { name: "Research Spike", description: "Updated" });
  assert.equal(typeUpdate.response.statusCode, 200);
  assert.equal(typeUpdate.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetype/{id}", "put", 200);

  const setProperty = await json(app, "PUT", `/rest/api/2/issuetype/${typeId}/properties/agent.config`, { value: "{\"enabled\":true}" });
  assert.equal(setProperty.response.statusCode, 201);
  assert.equal(setProperty.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetype/{issueTypeId}/properties/{propertyKey}", "put", 201);
  const property = await json(app, "GET", `/rest/api/2/issuetype/${typeId}/properties/agent.config`);
  assert.equal(property.response.statusCode, 200);
  assertMatchesResponse("/api/2/issuetype/{issueTypeId}/properties/{propertyKey}", "get", 200, property.body);
  assert.equal((property.body as { value: string }).value, "{\"enabled\":true}");
  const propertyUpdate = await json(app, "PUT", `/rest/api/2/issuetype/${typeId}/properties/agent.config`, { value: "{\"enabled\":false}" });
  assert.equal(propertyUpdate.response.statusCode, 200);
  assertEmptyResponseDocumented("/api/2/issuetype/{issueTypeId}/properties/{propertyKey}", "put", 200);
  const propertyDelete = await json(app, "DELETE", `/rest/api/2/issuetype/${typeId}/properties/agent.config`);
  assert.equal(propertyDelete.response.statusCode, 204);
  assert.equal(propertyDelete.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetype/{issueTypeId}/properties/{propertyKey}", "delete", 204);

  const boundary = "jira-metadata-boundary";
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\nsynthetic-png\r\n--${boundary}--\r\n`;
  const temporary = await app.inject({ method: "POST", url: `/rest/api/2/issuetype/${typeId}/avatar/temporary`, headers: { ...authorization, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart });
  assert.equal(temporary.statusCode, 201);
  assert.match(temporary.headers["content-type"] ?? "", /text\/html/);
  const cropping = JSON.parse(temporary.body);
  const temporarySchema = (operation("/api/2/issuetype/{id}/avatar/temporary", "post").responses["201"] as unknown as { content: { "text/html": { schema: OpenApiSchema } } }).content["text/html"].schema;
  assertMatchesSchema(temporarySchema, cropping, "POST /api/2/issuetype/{id}/avatar/temporary");
  const avatar = await json(app, "POST", `/rest/api/2/issuetype/${typeId}/avatar`, { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 128, needsCropping: true, url: cropping.url });
  assert.equal(avatar.response.statusCode, 201);
  assertMatchesResponse("/api/2/issuetype/{id}/avatar", "post", 201, avatar.body);
  assert.equal((avatar.body as { selected: boolean }).selected, true);

  const typeDelete = await json(app, "DELETE", `/rest/api/2/issuetype/${typeId}`);
  assert.equal(typeDelete.response.statusCode, 204);
  assert.equal(typeDelete.response.body, "");
  assertEmptyResponseDocumented("/api/2/issuetype/{id}", "delete", 204);
});

test("metadata validates references, survives restart, and resets deterministically", async (t) => {
  const { open } = fixture(t);
  const first = open();
  const missing = await json(first, "GET", "/rest/api/2/status/not-a-status");
  assert.equal(missing.response.statusCode, 404);
  assert.deepEqual(Object.keys(missing.body as object).sort(), ["errorMessages", "errors"]);
  const badPage = await json(first, "GET", "/rest/api/2/priority/page?startAt=-1");
  assert.equal(badPage.response.statusCode, 400);
  const badReference = await json(first, "POST", "/rest/api/2/field", { name: "Bad Reference", type: "com.example:text", projectIds: [99999] });
  assert.equal(badReference.response.statusCode, 400);
  assert.ok((badReference.body as { errors: Record<string, string> }).errors.projectIds);
  const associatedDelete = await json(first, "DELETE", "/rest/api/2/issuetype/10002");
  assert.equal(associatedDelete.response.statusCode, 400);

  const persistentField = await json(first, "POST", "/rest/api/2/field", { name: "Persistent Metadata", type: "com.example:text" });
  assert.equal(persistentField.response.statusCode, 201);
  const persistentId = (persistentField.body as { id: string }).id;
  await first.close();

  const second = open();
  const afterRestart = await json(second, "GET", `/rest/api/2/customFields?search=${encodeURIComponent("Persistent Metadata")}`);
  assert.ok((afterRestart.body as { values: { id: string }[] }).values.some((field) => field.id === persistentId));
  const reset = await json(second, "POST", "/__admin/reset");
  assert.equal(reset.response.statusCode, 204);
  assert.equal(reset.response.body, "");
  const afterReset = await json(second, "GET", `/rest/api/2/customFields?search=${encodeURIComponent("Persistent Metadata")}`);
  assert.equal((afterReset.body as { total: number }).total, 0);
  const seeded = await json(second, "GET", "/rest/api/2/issuetype/10001");
  assert.equal((seeded.body as { name: string }).name, "Story");
});
