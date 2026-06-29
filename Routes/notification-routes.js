const express = require("express");

const router = express.Router();

// Notification routes placeholder — kept minimal to avoid startup crash.
// Implementations live in Services/notification-service.js and other modules.

router.get("/health", (req, res) => {
	res.json({ success: true, message: "Notifications route healthy" });
});

module.exports = router;
