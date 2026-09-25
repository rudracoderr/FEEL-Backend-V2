const admin = require("../firebase-admin");
const User = require("../Models/usermodel");


async function requireAuth(req, res, next) {
    if (req.method === "OPTIONS") {
        return next();
    }

    if (!admin.isFirebaseAdminInitialized()) {
        return res.status(401).json({
            message: "Unauthorized"
        });
    }

    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");

    if (!match) {
        return res.status(401).json({
            message: "Unauthorized"
        });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(match[1]);
        req.authUid = decoded.uid;
        console.log("[requireAuth] req.authUid =", req.authUid);
        
        // Update user's last activity date in background
        User.updateOne(
            { uid: decoded.uid },
            { $set: { lastActivityAt: new Date() } }
        ).catch(err => console.error("Failed to update last activity date:", err));

        next();
    } catch (err) {
        console.error("[requireAuth] Token verification failed:", err.code || err.message);
        return res.status(401).json({
            message: "Unauthorized"
        });
    }
}

module.exports = requireAuth;
