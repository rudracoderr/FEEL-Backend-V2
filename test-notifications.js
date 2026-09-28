const express = require("express");
const mongoose = require("mongoose");
const http = require("http");

// 1. Mock requireAuth
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "../middleware/requireAuth") {
        return (req, res, next) => {
            req.authUid = req.headers["mock-uid"] || "test-user-A";
            next();
        };
    }
    return originalLoad.apply(this, arguments);
};

const Notification = require("./Models/notification-model");
const notificationRoutes = require("./Routes/notification-routes");
Module._load = originalLoad;

const app = express();
app.use(express.json());
app.use("/api/notifications", notificationRoutes);

const server = http.createServer(app);

// Simple fetch wrapper
const request = (method, path, mockUid = "test-user-A") => {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "localhost",
            port: server.address().port,
            path,
            method,
            headers: {
                "mock-uid": mockUid
            }
        }, res => {
            let data = "";
            res.on("data", d => data += d);
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
};

const runTests = async () => {
    console.log("\n=== Starting Notification Integration Tests ===");
    
    // Connect to local MongoDB instance
    await mongoose.connect("mongodb://127.0.0.1:27017/feel-test-db", {
        useNewUrlParser: true,
        useUnifiedTopology: true
    });
    console.log("Connected to test DB");

    // Clear test db
    await Notification.deleteMany({});

    // Seed test data
    // User A: 55 notifications (to test pagination > 50)
    const userANotifs = Array.from({ length: 55 }).map((_, i) => ({
        recipientUid: "test-user-A",
        type: "rescue_progress",
        title: `Notification ${i}`,
        body: `Body ${i}`,
        read: i < 5, // 5 are read, 50 unread
        createdAt: new Date(Date.now() - i * 1000) // oldest have highest i
    }));
    
    // User B: 1 notification
    const userBNotifs = [{
        recipientUid: "test-user-B",
        type: "rescue_progress",
        title: "User B Notification",
        body: "Body",
        read: false
    }];

    await Notification.insertMany([...userANotifs, ...userBNotifs]);
    console.log("Seeded database");

    server.listen(0, async () => {
        try {
            let pass = 0, fail = 0;
            const assert = (label, cond) => {
                if (cond) {
                    console.log(`  ✅ PASS: ${label}`);
                    pass++;
                } else {
                    console.log(`  ❌ FAIL: ${label}`);
                    fail++;
                }
            };

            // Test 1: GET /api/notifications
            let res = await request("GET", "/api/notifications?page=1&limit=20", "test-user-A");
            assert("GET / returns 200", res.status === 200);
            assert("Returns only User A's notifications", res.body.notifications.every(n => n.recipientUid === "test-user-A"));
            assert("Pagination works (limit enforced)", res.body.notifications.length === 20);
            assert("Pagination metadata correct", res.body.pagination.total === 55 && res.body.pagination.hasMore === true);
            assert("Newest first", res.body.notifications[0].title === "Notification 0"); // 0 is newest based on seed

            res = await request("GET", "/api/notifications?page=1&limit=100", "test-user-A");
            assert("Maximum page limit is enforced (requested 100, capped at 50)", res.body.notifications.length === 50);

            // Test 2: GET /unread-count
            res = await request("GET", "/api/notifications/unread-count", "test-user-A");
            assert("GET /unread-count matches unread notifications (50 unread out of 55)", res.body.count === 50);

            // Test 3: PATCH /:id/read
            const notifToRead = await Notification.findOne({ recipientUid: "test-user-A", read: false });
            res = await request("PATCH", `/api/notifications/${notifToRead._id}/read`, "test-user-A");
            assert("Owner can mark notification as read", res.status === 200 && res.body.notification.read === true);

            const notifB = await Notification.findOne({ recipientUid: "test-user-B" });
            res = await request("PATCH", `/api/notifications/${notifB._id}/read`, "test-user-A");
            assert("Another user's notification returns 403", res.status === 403);

            res = await request("PATCH", `/api/notifications/000000000000000000000000/read`, "test-user-A");
            assert("Nonexistent notification returns 404", res.status === 404);

            res = await request("PATCH", `/api/notifications/${notifToRead._id}/read`, "test-user-A");
            assert("Marking already-read is safe/idempotent", res.status === 200);

            console.log(`\n=== API Tests Complete: ${pass} passed, ${fail} failed ===\n`);
        } catch (e) {
            console.error("Test error:", e);
        } finally {
            await mongoose.disconnect();
            server.close();
            process.exit(0);
        }
    });
};

runTests();
