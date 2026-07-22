const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
    recipientUid: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: [
            "admin_assigned",
            "self_accepted",
            "admin_reassigned",
            "admin_unassigned",

            "adoption_application",
            "adoption_approved",
            "adoption_rejected",
            "adoption_reservation_cancelled",

            // ── Paid volunteer assistance ─────────────────────────────────
            // assistance_requested: sent to nearby approved paid volunteers
            //   when the assigned regular volunteer taps "Request Assistance".
            // assistance_accepted: sent to the assigned regular volunteer
            //   when a paid volunteer accepts the assistance request.
            "assistance_requested",
            "assistance_accepted",
            
            // ── NGO Transfer System ─────────────────────────────────────
            "TRANSFER_REQUESTED",
            "TRANSFER_ACCEPTED",
            "TRANSFER_REJECTED",
            "TRANSFER_CANCELLED"
            // ─────────────────────────────────────────────────────────────────────
        ],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    body: {
        type: String,
        required: true
    },
    data: {
        reportId: { type: String, default: "" },
        reportTitle: { type: String, default: "" },
        reportAddress: { type: String, default: "" },
        assignmentTimestamp: { type: String, default: "" }
    },
    read: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

notificationSchema.index({ recipientUid: 1, createdAt: -1 });
notificationSchema.index({ recipientUid: 1, read: 1 });

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = Notification;
