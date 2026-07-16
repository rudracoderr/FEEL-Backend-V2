
const User = require("../Models/usermodel");
const Notification = require("../Models/notification-model");
const admin = require("../firebase-admin");

const REPORT_RADIUS_KM = 10; // Define the radius in kilometers for nearby users
const MAX_SYSTEM_RADIUS_KM = 50; // Max search radius before in-memory filtering

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function isStaleTokenError(error) {
    const errorCode = error?.code || "";
    return (
        errorCode === "messaging/registration-token-not-registered" ||
        errorCode === "messaging/invalid-registration-token" ||
        errorCode === "messaging/invalid-recipient"
    );
}

async function notifyUsersWithinRadius(report) {
    try {
        if (!report || !report.location || !Array.isArray(report.location.coordinates)) {
            console.warn("Invalid report location:", report);
            return {
                nearbyUsers: [],
                tokenCount: 0,
                fcmResponse: null,
                error: "Invalid report location"
            };
        }

        const [longitude, latitude] = report.location.coordinates;
        const reporterUid = typeof report.reporterUid === "string" ? report.reporterUid.trim() : "";

        const nearbyUserQuery = {
            location: {
                $near: {
                    $geometry: {
                        type: "Point",
                        coordinates: [longitude, latitude]
                    },
                    $maxDistance: REPORT_RADIUS_KM * 1000
                }
            },
            deviceToken: { $exists: true, $ne: "" }
        };

        if (reporterUid) {
            nearbyUserQuery.uid = { $ne: reporterUid };
        }

        const nearbyusers = await User.find(nearbyUserQuery).select("uid deviceToken fullName");

        const recipients = nearbyusers.filter((user) => {
            if (!reporterUid) {
                return true;
            }

            return String(user?.uid || "") !== reporterUid;
        });

        console.log(
            "Nearby users found for report:",
            report._id,
            "count:",
            recipients.length
        );

        const locationSummary = [report.address, report.landmark].filter(Boolean).join(" • ");

        const tokens = [...new Set(recipients.map((user) => user.deviceToken).filter(Boolean))];

        const recipientSnapshot = recipients.map((user) => ({
            fullName: user.fullName || "",
            uid: user.uid || "",
            deviceToken: user.deviceToken || ""
        }));

        console.log("FCM multicast recipients:", JSON.stringify(recipientSnapshot, null, 2));

        if (!recipients.length) {
            console.log("No nearby users found within radius for report:", report._id);
            return {
                nearbyUsers: [],
                tokenCount: 0,
                fcmResponse: null
            };
        }

        if (!tokens.length) {
            console.log(
                "Nearby users found but none had a usable deviceToken for report:",
                report._id,
                "userCount:",
                recipients.length
            );
            return {
                nearbyUsers: recipients,
                tokenCount: 0,
                fcmResponse: null
            };
        }

        console.log(`Sending notifications to ${tokens.length} nearby users for report ${report._id}`);

        const fcmResponse = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: {
                title: report.title || "New report nearby",
                body: locationSummary
                    ? `${report.description || "A new report was posted"} at ${locationSummary}`
                    : (report.description || "A new report was posted near your location")
            },
            data: {
                reportId: String(report._id || ""),
                title: report.title || "",
                description: report.description || "",
                address: report.address || "",
                landmark: report.landmark || ""
            },
            // Prevent notification from being shown twice
            webpush: {
                fcmOptions: {
                    link: "/" // Add link to prevent auto-show in some cases
                }
            }
        });

        // Log delivery status
        console.log(`FCM response - Success: ${fcmResponse.successCount}, Failure: ${fcmResponse.failureCount}`);
        
        if (fcmResponse.failureCount > 0) {
            const staleTokens = [];

            fcmResponse.responses.forEach((response, index) => {
                const recipient = recipients[index];
                const recipientInfo = {
                    fullName: recipient?.fullName || "",
                    uid: recipient?.uid || "",
                    deviceToken: recipient?.deviceToken || ""
                };

                if (response.success) {
                    console.log("FCM send result SUCCESS:", JSON.stringify(recipientInfo, null, 2));
                    return;
                }

                if (!response.success) {
                    console.error("FCM send result FAILURE:", JSON.stringify(recipientInfo, null, 2));
                    console.error("FCM error details:", {
                        code: response.error?.code || null,
                        message: response.error?.message || null,
                        details: response.error?.errorInfo || null
                    });

                    if (isStaleTokenError(response.error)) {
                        const staleToken = tokens[index];
                        if (staleToken) {
                            staleTokens.push(staleToken);
                        }
                    }
                }
            });

            if (staleTokens.length > 0) {
                await User.updateMany(
                    { deviceToken: { $in: staleTokens } },
                    { $set: { deviceToken: null } }
                );

                console.warn(
                    `Cleared ${staleTokens.length} stale deviceToken value(s) after FCM reported not-registered/invalid-token.`
                );
            }
        }

        if (fcmResponse.successCount > 0) {
            fcmResponse.responses.forEach((response, index) => {
                if (!response.success) {
                    return;
                }

                const recipient = recipients[index];
                console.log("FCM multicast success recipient:", JSON.stringify({
                    fullName: recipient?.fullName || "",
                    uid: recipient?.uid || "",
                    deviceToken: recipient?.deviceToken || ""
                }, null, 2));
            });
        }

        return {
            nearbyUsers: recipients,
            tokenCount: tokens.length,
            fcmResponse,
            successCount: fcmResponse.successCount,
            failureCount: fcmResponse.failureCount
        };
    } catch (error) {
        console.error("Error notifying users:", error);
        return {
            nearbyUsers: [],
            tokenCount: 0,
            fcmResponse: null,
            error: error.message
        };
    }
}

async function sendNotificationToToken(token, title, body, data = {}, context = {}) {
    if (!token) {
        return {
            success: false,
            error: "Missing device token"
        };
    }

    try {
        console.log("FCM direct recipient:", JSON.stringify({
            fullName: context.fullName || "",
            uid: context.uid || "",
            deviceToken: token
        }, null, 2));

        const message = {
            token,
            notification: {
                title,
                body
            },
            data: Object.fromEntries(
                Object.entries(data).map(([key, value]) => [key, String(value ?? "")])
            )
        };

        const response = await admin.messaging().send(message);

        console.log("FCM direct send result SUCCESS:", JSON.stringify({
            fullName: context.fullName || "",
            uid: context.uid || "",
            deviceToken: token,
            response
        }, null, 2));

        return {
            success: true,
            response
        };
    } catch (error) {
        console.error("FCM direct send result FAILURE:", JSON.stringify({
            fullName: context.fullName || "",
            uid: context.uid || "",
            deviceToken: token,
            code: error?.code || null,
            message: error?.message || null,
            details: error?.errorInfo || null
        }, null, 2));
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Create an in-app notification in the database and optionally send a push notification.
 * Deduplicates: skips creation if an unread notification of the same type already exists
 * for the same recipient + reportId combination.
 */
async function createNotification({
    recipientUid,
    type,
    title,
    body,
    data = {},
    deviceToken = null,
    context = {}
}) {
    try {
        if (!recipientUid || !type || !title) {
            console.warn("createNotification: missing required fields", { recipientUid, type, title });
            return { success: false, error: "Missing required fields" };
        }

        // Deduplication: check if an unread notification of the same type exists
        // for this recipient on the same report
        const dedupQuery = {
            recipientUid,
            type,
            read: false
        };

        if (data.reportId) {
            dedupQuery["data.reportId"] = data.reportId;
        }

        const existingNotification = await Notification.findOne(dedupQuery);
        if (existingNotification) {
            console.log("Duplicate notification blocked:", { recipientUid, type, reportId: data.reportId });
            return { success: true, notification: existingNotification, deduplicated: true };
        }

        const notification = await Notification.create({
            recipientUid,
            type,
            title,
            body,
            data: {
                reportId: data.reportId || "",
                reportTitle: data.reportTitle || "",
                reportAddress: data.reportAddress || "",
                assignmentTimestamp: data.assignmentTimestamp || new Date().toISOString()
            },
            read: false
        });

        console.log("In-app notification created:", {
            id: notification._id,
            recipientUid,
            type
        });

        // Send push notification if device token is available
        let pushResult = null;
        if (deviceToken) {
            pushResult = await sendNotificationToToken(
                deviceToken,
                title,
                body,
                {
                    type,
                    notificationId: String(notification._id),
                    reportId: data.reportId || "",
                    reportTitle: data.reportTitle || "",
                    reportAddress: data.reportAddress || ""
                },
                context
            );
        }

        return {
            success: true,
            notification,
            pushResult
        };
    } catch (error) {
        console.error("Error creating notification:", error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    createNotification
};

async function getPaidVolunteersInRange(report) {
    if (!report || !report.location || !Array.isArray(report.location.coordinates)) {
        return [];
    }

    const [longitude, latitude] = report.location.coordinates;
    const reporterUid = typeof report.reporterUid === "string" ? report.reporterUid.trim() : "";
    const assignedUid = report.assignedVolunteer?.uid || "";

    const query = {
        isPaidVolunteer: true,
        paidVolunteerStatus: "approved",
        isAvailable: true,
        deviceToken: { $exists: true, $ne: "" },
        location: {
            $near: {
                $geometry: {
                    type: "Point",
                    coordinates: [longitude, latitude]
                },
                $maxDistance: MAX_SYSTEM_RADIUS_KM * 1000
            }
        }
    };

    const candidates = await User.find(query).select("uid deviceToken fullName location rescueRadius");
    
    // Filter out the reporter, the assigned volunteer, and strictly enforce rescueRadius
    return candidates.filter(user => {
        if (reporterUid && String(user.uid) === reporterUid) return false;
        if (assignedUid && String(user.uid) === assignedUid) return false;

        if (user.location && Array.isArray(user.location.coordinates)) {
            const [uLon, uLat] = user.location.coordinates;
            const dist = calculateDistanceKm(latitude, longitude, uLat, uLon);
            const rRadius = user.rescueRadius || 10;
            return dist <= rRadius;
        }
        return false;
    });
}

async function checkNearbyPaidVolunteersExist(report) {
    try {
        const matchingUsers = await getPaidVolunteersInRange(report);
        return matchingUsers.length > 0;
    } catch (error) {
        console.error("Error checking nearby paid volunteers:", error);
        return false;
    }
}

async function notifyNearbyPaidVolunteers(report) {
    try {
        const recipients = await getPaidVolunteersInRange(report);

        if (!recipients.length) {
            console.log("No approved paid volunteers found within their rescue radii for report:", report._id);
            return { notifiedCount: 0 };
        }

        const tokens = [...new Set(recipients.map(u => u.deviceToken).filter(Boolean))];
        if (!tokens.length) return { notifiedCount: 0 };

        const locationSummary = [report.address, report.landmark].filter(Boolean).join(" • ");
        
        console.log(`Sending assistance requests to ${tokens.length} paid volunteers for report ${report._id}`);

        const fcmResponse = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: {
                title: "Assistance Requested",
                body: `A volunteer needs help with a rescue at ${locationSummary || "your area"}.`
            },
            data: {
                reportId: String(report._id || ""),
                type: "assistance_requested"
            },
            webpush: { fcmOptions: { link: "/" } }
        });

        // Create in-app notifications for these users
        for (const user of recipients) {
            await createNotification({
                recipientUid: user.uid,
                type: "assistance_requested",
                title: "Assistance Requested",
                body: `A volunteer needs help with a rescue at ${locationSummary || "your area"}.`,
                data: {
                    reportId: String(report._id || ""),
                    reportTitle: report.title || "",
                    reportAddress: report.address || ""
                }
            });
        }

        return { notifiedCount: fcmResponse.successCount };
    } catch (error) {
        console.error("Error notifying paid volunteers:", error);
        return { notifiedCount: 0, error: error.message };
    }
}

module.exports = {
    notifyUsersWithinRadius,
    sendNotificationToToken,
    createNotification,
    checkNearbyPaidVolunteersExist,
    notifyNearbyPaidVolunteers,
    calculateDistanceKm
};
