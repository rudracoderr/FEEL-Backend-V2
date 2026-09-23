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
        
        console.log("[requireAdmin] req.authUid =", req.authUid);
        console.log("[requireAdmin] user =", user);
        console.log("[requireAdmin] user.role =", user?.role);

        if (!user || user.role !== "admin") {
            console.log("[requireAdmin] Forbidden: User is not admin");
            return res.status(403).json({
                success: false,
                message: "Forbidden"
            });
        }

        req.adminUser = user;
        next();
        // move to next middleware automatically
        
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify admin access"
        });
    }
}

module.exports = requireAdmin;
