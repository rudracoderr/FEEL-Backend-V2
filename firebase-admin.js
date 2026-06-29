const fs = require("fs");
const path = require("path");

// firebase-admin v14 uses modular subpackage imports
const { initializeApp, getApps, getApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");


function loadServiceAccountFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return require(filePath);
}

function loadServiceAccountFromEnv() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
        return null;
    }

    return {
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, "\n")
    };
}

function getServiceAccount() {
    const rootServiceAccountPath = path.join(__dirname, "serviceAccountKey.json");
    const legacyServiceAccountPath = path.join(__dirname, "Config", "Firebase-admin.json");

    return (
        loadServiceAccountFromFile(rootServiceAccountPath) ||
        loadServiceAccountFromEnv() ||
        loadServiceAccountFromFile(legacyServiceAccountPath)
    );
}

// Initialize only once
if (!getApps().length) {
    const serviceAccount = getServiceAccount();

    if (serviceAccount) {
        initializeApp({ credential: cert(serviceAccount) });
        console.log("Firebase Admin SDK initialized.");
    } else {
        console.warn("Firebase Admin SDK: no service account found. Auth verification will fail.");
    }
}

// Export a unified interface compatible with how the rest of the codebase uses this module
module.exports = {
    // Auth instance for token verification
    auth: () => getAuth(),

    // Messaging instance for push notifications
    messaging: () => getMessaging(),

    // Compatibility helpers
    isFirebaseAdminInitialized: () => getApps().length > 0,
    getApps,
    getApp,
    cert,
};