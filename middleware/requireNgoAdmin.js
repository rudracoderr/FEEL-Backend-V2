const User = require("../Models/usermodel");

async function requireNgoAdmin(req, res, next) {
    try {
        if (!req.authUid) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const user = await User.findOne({ uid: req.authUid }).select("uid role email ngoId");

        if (!user || user.role !== "ngo_admin") {
            return res.status(403).json({
                success: false,
                message: "Forbidden - NGO Admin access required"
            });
        }

        req.ngoUser = user;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify NGO Admin access"
        });
    }
}

module.exports = requireNgoAdmin;
