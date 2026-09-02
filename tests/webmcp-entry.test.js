import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "../src/engine.js";
import { registerWebMCP, resolveModelContext } from "../src/webmcp.js";

function stubModelContext() {
  const registered = [];
  return {
    registered,
    async registerTool(tool) {
      if (!tool?.name || registered.some((entry) => entry.name === tool.name)) throw new Error("duplicate");
      registered.push(tool);
    }
  };
}

function harnessContext() {
  const state = createInitialState({ preferenceSeed: "entry-point" });
  const clock = { pause() {}, resume() {}, setSpeed() {} };
  return { state, clock, onChange: () => {} };
}

test("resolveModelContext prefers document.modelContext and falls back to navigator.modelContext", () => {
  const documentStub = stubModelContext();
  const navigatorStub = stubModelContext();
  assert.equal(resolveModelContext({ document: { modelContext: documentStub }, navigator: { modelContext: navigatorStub } }).entryPoint, "document");
  assert.equal(resolveModelContext({ navigator: { modelContext: navigatorStub } }).entryPoint, "navigator");
  assert.equal(resolveModelContext({ document: {}, navigator: {} }).entryPoint, null);
  assert.equal(resolveModelContext({}).modelContext, null);
});

test("registration succeeds when only navigator.modelContext is available", async () => {
  const navigatorStub = stubModelContext();
  const status = await registerWebMCP(harnessContext(), { scope: { navigator: { modelContext: navigatorStub } } });

  assert.equal(status.supported, true);
  assert.equal(status.entryPoint, "navigator");
  assert.equal(status.registered, status.total);
  assert.deepEqual(status.failures, []);
  assert.equal(navigatorStub.registered.length, status.total);
  assert.equal(globalThis.__HOST_STAND_WEBMCP_STATUS__.entryPoint, "navigator");
});

test("registration uses document.modelContext when both entry points exist", async () => {
  const documentStub = stubModelContext();
  const navigatorStub = stubModelContext();
  const status = await registerWebMCP(harnessContext(), {
    scope: { document: { modelContext: documentStub }, navigator: { modelContext: navigatorStub } }
  });

  assert.equal(status.entryPoint, "document");
  assert.equal(documentStub.registered.length, status.total);
  assert.equal(navigatorStub.registered.length, 0);
});

test("registration reports unavailable without throwing when no entry point exists", async () => {
  const status = await registerWebMCP(harnessContext(), { scope: {} });
  assert.equal(status.supported, false);
  assert.equal(status.entryPoint, null);
  assert.equal(status.registered, 0);
  assert.equal(typeof globalThis.hostStandInvokeTool, "function");
  const floor = await globalThis.hostStandInvokeTool("get_floor", {});
  assert.equal(floor.tables.length, 33);
});
