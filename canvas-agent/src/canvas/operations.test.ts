import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>) {
    const request = buildCanvasToolRequest(name, input, null);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

test("plugin node types pass validation and reach the canvas as add_node ops", async () => {
    const { toolInputSchemas, canvasOpSchema } = await import("./schemas.js");
    assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType: "film:shot", metadata: { shotId: "S01" } }).success, true);
    assert.equal(canvasOpSchema.safeParse({ type: "add_node", nodeType: "film:card" }).success, true);
    assert.equal(toolInputSchemas.canvas_create_node.safeParse({ nodeType: "not a type" }).success, false);
    const ops = opsOf("canvas_create_node", { nodeType: "film:shot", title: "S01", metadata: { duration: 10 } });
    assert.equal(ops[0].nodeType, "film:shot");
    assert.deepEqual(ops[0].metadata, { duration: 10 });
});
