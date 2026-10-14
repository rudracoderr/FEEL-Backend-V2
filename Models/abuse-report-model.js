const mongoose = require("mongoose");

const abuseReportSchema = new mongoose.Schema({
    reportId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Report",
        required: true
    },
    reportedByUid: {
        type: String,
        required: true
    },
    reason: {
        type: String,
        required: true,
        enum: ["Fake Report", "Spam", "Wrong Location", "Duplicate Report", "Other"]
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    // Lifecycle. Legacy documents lack this field and are treated as "pending" by admin queries.
    status: {
        type: String,
        enum: ["pending", "dismissed", "action_taken"],
        default: "pending"
    },
    reviewedByUid: { type: String, default: null },
    reviewedByEmail: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: "" }
});

// Compound unique index to prevent the same user from reporting the same rescue multiple times
abuseReportSchema.index({ reportId: 1, reportedByUid: 1 }, { unique: true });

const AbuseReport = mongoose.model("AbuseReport", abuseReportSchema);

module.exports = AbuseReport;
