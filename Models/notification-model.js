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
            "TRANSFER_CANCELLED",
            "TRANSFER_CLOSED",
            "RESCUE_TRANSFERRED_TO_NGO",

            // ── Volunteer & Rescue Progress ──────────────────────────────
            // volunteer_accepted: sent to admins when a volunteer accepts a rescue.
            // rescue_progress:    fallback/initial progress notification to reporter.
            // rescue_on_the_way:  sent to reporter when volunteer status = "On The Way".
            // rescue_reached_location: sent to reporter when volunteer arrives on site.
            // rescue_completed:   sent to admins when a rescue is fully resolved.
            // rescue_completed_reporter: sent to reporter when rescue is resolved.
            "volunteer_accepted",
            "rescue_progress",
            "rescue_on_the_way",
            "rescue_reached_location",
            "rescue_completed",
            "rescue_completed_reporter"
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
