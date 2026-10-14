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
            "Volunteer Unassigned",
            "Report Resolved", "Report Marked Fake", "Report Marked Pending", "Report Deleted",
            "NGO Created", "NGO Updated", "NGO Archived",
            "Paid Volunteer Created", "Paid Volunteer Approved", "Paid Volunteer Rejected",
            "Paid Volunteer Suspended", "Paid Volunteer Unsuspended",
            "Abuse Report Dismissed", "Notification Broadcast"
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

auditLogSchema.index({ timestamp: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
