import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.js";
import {
  assertMatchesResponse,
  assertMatchesSchema,
  authorization,
  responseSchema,
} from "./helpers/official-contract.js";

test("system assets cover avatars, templates, terminology, upgrades, and licenses", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jira-system-assets-"));
  const dataFile = join(directory, "state.json");
  let app = buildApp({ dataFile, baseUrl: "http://jira.test" });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const jsonRequest = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: string | Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...authorization,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      payload,
    });

  {
    const response = await jsonRequest("GET", "/rest/api/2/avatar/project/system");
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertMatchesResponse("/api/2/avatar/{type}/system", "get", 200, body);
    assert.equal(body.owner, "system");
    assert.equal(typeof body.id, "string");

    const temporary = await jsonRequest(
      "POST",
      "/rest/api/2/avatar/project/temporary?filename=logo.png&size=160",
    );
    assert.equal(temporary.statusCode, 201);
    assertMatchesResponse("/api/2/avatar/{type}/temporary", "post", 201, temporary.json());
    assert.equal(temporary.json().cropperWidth, 160);

    const cropped = await jsonRequest("POST", "/rest/api/2/avatar/project/temporaryCrop", {
      cropperOffsetX: 0,
      cropperOffsetY: 0,
      cropperWidth: 128,
    });
    assert.equal(cropped.statusCode, 201);
    assertMatchesSchema(
      responseSchema(
        "/api/2/universal_avatar/type/{type}/owner/{owningObjectId}/avatar",
        "post",
        201,
      ),
      cropped.json(),
      "POST /api/2/avatar/{type}/temporaryCrop compatibility response",
    );
    assert.equal(cropped.json().owner, "system");
  }

  let customAvatarId: string;
  {
    const initial = await jsonRequest(
      "GET",
      "/rest/api/2/universal_avatar/type/project/owner/T100ZB",
    );
    assert.equal(initial.statusCode, 200);
    assertMatchesResponse(
      "/api/2/universal_avatar/type/{type}/owner/{owningObjectId}",
      "get",
      200,
      initial.json(),
    );
    assert.equal(initial.json().owner, "T100ZB");

    const multipart = await app.inject({
      method: "POST",
      url: "/rest/api/2/universal_avatar/type/project/owner/T100ZB/temp",
      headers: {
        ...authorization,
        "content-type": "multipart/form-data; boundary=mock-boundary",
      },
      payload: Buffer.from("--mock-boundary\r\nsynthetic-avatar\r\n--mock-boundary--\r\n"),
    });
    assert.equal(multipart.statusCode, 200);
    assertMatchesResponse(
      "/api/2/universal_avatar/type/{type}/owner/{owningObjectId}/temp",
      "post",
      200,
      multipart.json(),
    );
    assert.equal(multipart.json().needsCropping, true);

    const created = await jsonRequest(
      "POST",
      "/rest/api/2/universal_avatar/type/project/owner/T100ZB/avatar",
      { cropperOffsetX: 0, cropperOffsetY: 0, cropperWidth: 128 },
    );
    assert.equal(created.statusCode, 201);
    assertMatchesResponse(
      "/api/2/universal_avatar/type/{type}/owner/{owningObjectId}/avatar",
      "post",
      201,
      created.json(),
    );
    assert.equal(created.json().selected, true);
    customAvatarId = created.json().id;

    const missingOwner = await jsonRequest(
      "GET",
      "/rest/api/2/universal_avatar/type/project/owner/MISSING",
    );
    assert.equal(missingOwner.statusCode, 404);
    assert.ok(Array.isArray(missingOwner.json().errorMessages));
  }

  {
    const archive = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const beforeUpload = await jsonRequest("POST", "/rest/api/2/email-templates/apply");
    assert.equal(beforeUpload.statusCode, 400);

    const upload = await app.inject({
      method: "POST",
      url: "/rest/api/2/email-templates",
      headers: { ...authorization, "content-type": "application/zip" },
      payload: archive,
    });
    assert.equal(upload.statusCode, 200);
    assert.equal(upload.body, "");

    const download = await jsonRequest("GET", "/rest/api/2/email-templates");
    assert.equal(download.statusCode, 200);
    assert.match(download.headers["content-type"] ?? "", /^application\/zip/);
    assert.equal(download.rawPayload.subarray(0, 4).toString("hex"), "504b0506");

    const types = await jsonRequest("GET", "/rest/api/2/email-templates/types");
    assert.equal(types.statusCode, 200);
    assert.match(types.body, /html/);
  }

  {
    const entries = await jsonRequest("GET", "/rest/api/2/terminology/entries");
    assert.equal(entries.statusCode, 200);
    const values = entries.json();
    assert.ok(Array.isArray(values));
    assert.equal(values.length, 2);
    const schema = responseSchema("/api/2/terminology/entries", "get", 200);
    for (const [index, value] of values.entries()) {
      assertMatchesSchema(schema, value, `GET /api/2/terminology/entries[${index}]`);
      assert.equal(typeof value.originalName, "string");
    }

    const epic = await jsonRequest("GET", "/rest/api/2/terminology/entries/Epic");
    assert.equal(epic.statusCode, 200);
    assertMatchesResponse(
      "/api/2/terminology/entries/{originalName}",
      "get",
      200,
      epic.json(),
    );

    const updated = await jsonRequest("POST", "/rest/api/2/terminology/entries", {
      originalName: "Epic",
      newName: "Theme",
      newNamePlural: "Themes",
    });
    assert.equal(updated.statusCode, 204);
    assert.equal(updated.body, "");
  }

  {
    const absent = await jsonRequest("GET", "/rest/api/2/upgrade");
    assert.equal(absent.statusCode, 404);
    const run = await jsonRequest("POST", "/rest/api/2/upgrade");
    assert.equal(run.statusCode, 200);
    assert.equal(run.body, "");
    const result = await jsonRequest("GET", "/rest/api/2/upgrade");
    assert.equal(result.statusCode, 200);
    assertMatchesResponse("/api/2/upgrade", "get", 200, result.json());
    assert.equal(result.json().outcome, "SUCCESS");
  }

  {
    const valid = await jsonRequest(
      "POST",
      "/rest/api/2/licenseValidator",
      JSON.stringify("MOCK-JIRA-DC-10.3.5"),
    );
    assert.equal(valid.statusCode, 200);
    assertMatchesResponse("/api/2/licenseValidator", "post", 200, valid.json());
    assert.deepEqual(valid.json().errors, {});

    const invalid = await jsonRequest(
      "POST",
      "/rest/api/2/licenseValidator",
      JSON.stringify("SYNTHETIC-INVALID"),
    );
    assert.equal(invalid.statusCode, 200);
    assert.equal(typeof invalid.json().errors.license, "string");
  }

  await app.close();
  app = buildApp({ dataFile, baseUrl: "http://jira.test" });

  {
    const avatar = await jsonRequest(
      "GET",
      "/rest/api/2/universal_avatar/type/project/owner/T100ZB",
    );
    assert.equal(avatar.json().id, customAvatarId);
    const terminology = await jsonRequest("GET", "/rest/api/2/terminology/entries/Epic");
    assert.equal(terminology.json().newName, "Theme");
    const upgrade = await jsonRequest("GET", "/rest/api/2/upgrade");
    assert.equal(upgrade.json().outcome, "SUCCESS");

    const apply = await jsonRequest("POST", "/rest/api/2/email-templates/apply");
    assert.equal(apply.statusCode, 200);
    assert.equal(apply.body, "");
    const revert = await jsonRequest("POST", "/rest/api/2/email-templates/revert");
    assert.equal(revert.statusCode, 200);
    assert.equal(revert.body, "");

    const removeAvatar = await jsonRequest(
      "DELETE",
      `/rest/api/2/universal_avatar/type/project/owner/T100ZB/avatar/${customAvatarId}`,
    );
    assert.equal(removeAvatar.statusCode, 200);
    assert.equal(removeAvatar.body, "");
  }

  {
    const reset = await jsonRequest("POST", "/__admin/reset");
    assert.equal(reset.statusCode, 204);
    const terminology = await jsonRequest("GET", "/rest/api/2/terminology/entries/Epic");
    assert.equal(terminology.json().newName, "Epic");
    const upgrade = await jsonRequest("GET", "/rest/api/2/upgrade");
    assert.equal(upgrade.statusCode, 404);
  }
});
