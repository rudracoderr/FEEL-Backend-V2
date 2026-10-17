/**
 * Regression Test: Safe Malformed JSON Parsing Error Handling
 *
 * Verifies that:
 * 1. An unauthenticated request with malformed JSON body returns HTTP 400.
 * 2. Content-Type is 'application/json'.
 * 3. Body matches { success: false, message: "Invalid JSON format" }.
 * 4. Response does NOT leak stack traces, local paths (C:\ or /node_modules/), or internal dependency details.
 * 5. Valid JSON requests continue to be parsed correctly.
 *
 * Run:
 *   node --test "middleware/json-parser-error.test.js"
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

test("Malformed JSON parser regression suite", async (t) => {
    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // The centralized safe JSON error handler (mirrored from server.js)
    app.use((err, req, res, next) => {
        if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400) && ("body" in err || err.type === "entity.parse.failed")) {
            return res.status(400).json({
                success: false,
                message: "Invalid JSON format"
            });
        }
        next(err);
    });

    // Dummy test route
    app.post("/test-endpoint", (req, res) => {
        res.status(200).json({ success: true, received: req.body });
    });

    // Start ephemeral local server
    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/test-endpoint`;

    await t.test("Malformed JSON returns HTTP 400 with safe JSON error and no stack traces", async () => {
        const malformedPayload = '{"brokenKey": "value", invalidSyntax: ';
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: malformedPayload
        });

        assert.strictEqual(res.status, 400, "Expected status 400 Bad Request");

        const contentType = res.headers.get("content-type") || "";
        assert.ok(contentType.includes("application/json"), `Expected application/json, got ${contentType}`);

        const body = await res.json();
        assert.strictEqual(body.success, false, "Expected body.success === false");
        assert.strictEqual(body.message, "Invalid JSON format", "Expected message === 'Invalid JSON format'");

        const rawText = JSON.stringify(body);
        assert.strictEqual(/node_modules/i.test(rawText), false, "Must not leak node_modules path");
        assert.strictEqual(/[A-Za-z]:\\[a-zA-Z0-9_.\\]+/i.test(rawText), false, "Must not leak Windows path");
        assert.strictEqual(/\/(home|usr|etc|var|tmp|app|root)\//i.test(rawText), false, "Must not leak Unix path");
        assert.strictEqual(/SyntaxError:/i.test(rawText), false, "Must not leak SyntaxError exception details");
        assert.strictEqual(/\bat\s+.+\.js:\d+:\d+/i.test(rawText), false, "Must not leak call stack");
    });

    await t.test("Valid JSON requests continue to parse and work as expected", async () => {
        const validPayload = { greeting: "hello", count: 42 };
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(validPayload)
        });

        assert.strictEqual(res.status, 200, "Expected status 200 OK");
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.deepStrictEqual(body.received, validPayload);
    });

    // Tear down server
    await new Promise((resolve) => server.close(resolve));
});
