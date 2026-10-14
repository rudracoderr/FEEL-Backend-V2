const mongoose = require("mongoose");

// One document per manual admin announcement. FCM "accepted" only means FCM took the
// message; it is NOT proof of device delivery.
const broadcastSchema = new mongoose.Schema({
    sentByUid: { type: String, required: true },
    sentByEmail: { type: String, default: "" },
    audience: { type: String, required: true, enum: ["all", "volunteers", "paid_volunteers", "ngo_members", "user"] },
    targetUid: { type: String, default: null },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    status: { type: String, enum: ["sending", "completed", "partial", "failed"], default: "sending" },
    recipientCount: { type: Number, default: 0 },
    tokenCount: { type: Number, default: 0 },
    fcmAccepted: { type: Number, default: 0 },
    fcmFailed: { type: Number, default: 0 },
    staleTokensCleared: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null }
});

broadcastSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Broadcast", broadcastSchema);
