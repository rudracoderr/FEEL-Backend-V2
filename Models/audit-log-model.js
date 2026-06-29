const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
    adminId: {
        type: String,
        required: true
    },
    adminEmail: {
        type: String,
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: [
            "User Suspended",
            "User Unsuspended",
            "Volunteer Approved",
            "Volunteer Rejected",
            "Volunteer Suspended",
            "Volunteer Unsuspended",
            "Volunteer Assigned",
            "Volunteer Reassigned",
            "Volunteer Unassigned"
        ]
    },
    targetId: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    reason: {
        type: String,
        trim: true,
        default: ""
    }
});

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
