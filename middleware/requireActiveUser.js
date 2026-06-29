const User = require("../Models/usermodel");

async function requireActiveUser(req, res, next) {
    try {
        if (!req.authUid) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const user = await User.findOne({ uid: req.authUid });

        if (user && user.isSuspended) {
            return res.status(403).json({
                success: false,
                message: `Your account is suspended. Reason: ${user.suspensionReason || "Violating platform policies"}`
            });
        }

        req.activeUser = user;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify account status"
        });
    }
}

module.exports = requireActiveUser;
