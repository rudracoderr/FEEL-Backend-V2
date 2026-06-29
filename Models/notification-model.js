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
            "rescue_progress",
            "rescue_on_the_way",
            "rescue_reached_location",
            "rescue_completed_reporter",
            "rescue_completed",
            "volunteer_accepted"
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
