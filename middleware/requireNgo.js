const User = require("../Models/usermodel");

async function requireNgo(req, res, next) {
    try {
        if (!req.authUid) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const user = await User.findOne({ uid: req.authUid }).select("uid role email ngoId");

        if (!user || (user.role !== "ngo_admin" && user.role !== "ngo_member")) {
            return res.status(403).json({
                success: false,
                message: "Forbidden - NGO access required"
            });
        }

        req.ngoUser = user;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify NGO access"
        });
    }
}

module.exports = requireNgo;
