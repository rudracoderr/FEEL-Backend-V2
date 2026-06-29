const User = require("../Models/usermodel");

async function requireAdmin(req, res, next) {
    try {
        if (!req.authUid) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const user = await User.findOne({ uid: req.authUid }).select("uid role email");

        if (!user || user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Forbidden"
            });
        }

        req.adminUser = user;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify admin access"
        });
    }
}

module.exports = requireAdmin;
