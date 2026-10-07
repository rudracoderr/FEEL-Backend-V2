const express = require("express");
const router = express.Router();
const Notification = require("../Models/notification-model");
const requireAuth = require("../middleware/requireAuth");

// All routes require a verified Firebase token.
// req.authUid is set by requireAuth and is the authoritative identity —
// the client never supplies its own UID.
router.use(requireAuth);
router.param("id", require("../middleware/validateObjectId")("id"));
const { validate, pagination } = require("../middleware/validate");

// ---------------------------------------------------------------------------
// GET /api/notifications
// Returns the authenticated user's notifications, newest first.
// Pagination: ?page=1&limit=20 (max 50 per request).
// ---------------------------------------------------------------------------
router.get("/", validate(pagination), async (req, res) => {
    try {
        const uid = req.authUid;
        const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const skip  = (page - 1) * limit;

        const [notifications, total] = await Promise.all([
            Notification.find({ recipientUid: uid })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.countDocuments({ recipientUid: uid })
        ]);

        return res.json({
            success: true,
            notifications,
            pagination: {
                page,
                limit,
                total,
                hasMore: skip + notifications.length < total
            }
        });
    } catch (err) {
        console.error("[notifications] GET / error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch notifications." });
    }
});

// ---------------------------------------------------------------------------
// GET /api/notifications/unread-count
// Returns count of unread notifications for the authenticated user.
// ---------------------------------------------------------------------------
router.get("/unread-count", async (req, res) => {
    try {
        const count = await Notification.countDocuments({ recipientUid: req.authUid, read: false });
        return res.json({ success: true, count });
    } catch (err) {
        console.error("[notifications] GET /unread-count error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch unread count." });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/notifications/:id/read
// Marks a notification as read.
// Security: recipientUid on the document must match req.authUid.
// Returns 404 if not found, 403 if it belongs to another user.
// ---------------------------------------------------------------------------
router.patch("/:id/read", async (req, res) => {
    try {
        const uid = req.authUid;
        const notification = await Notification.findById(req.params.id);

        if (!notification) {
            return res.status(404).json({ success: false, message: "Notification not found." });
        }

        if (notification.recipientUid !== uid) {
            return res.status(403).json({ success: false, message: "Forbidden." });
        }

        if (!notification.read) {
            notification.read = true;
            await notification.save();
        }

        return res.json({ success: true, notification });
    } catch (err) {
        console.error("[notifications] PATCH /:id/read error:", err);
        return res.status(500).json({ success: false, message: "Failed to mark notification as read." });
    }
});

module.exports = router;
