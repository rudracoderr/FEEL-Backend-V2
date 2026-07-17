const mongoose = require("mongoose");

const validateMongoId = (paramName = "id") => {
    return (req, res, next) => {
        const id = req.params[paramName];

        if (!mongoose.Types.ObjectId.isValid(id)) {
            // Determine resource name based on paramName or URL context for generic 'id'
            let resource = paramName;
            
            if (paramName === "id") {
                if (req.originalUrl.includes("/reports/")) resource = "report id";
                else if (req.originalUrl.includes("/ngos/")) resource = "ngo id";
                else if (req.originalUrl.includes("/adoptions/")) resource = "adoption id";
                else resource = "id"; // fallback
            }

            return res.status(400).json({
                success: false,
                message: `Invalid ${resource}.`
            });
        }

        next();
    };
};

module.exports = validateMongoId;
