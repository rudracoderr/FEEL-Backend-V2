const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const Report = require("./Models/report-model");
const User = require("./Models/usermodel");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const reportRoutes = require("./Routes/report-routes");
const userRoutes = require("./Routes/users-routes");
const adminRoutes = require("./Routes/admin-routes");
const adoptionRoutes = require("./Routes/adoption-routes");
const ngoRoutes = require("./Routes/ngo-routes");
const admin = require("./firebase-admin");
console.log("SERVER STARTED", new Date().toISOString());

require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const app = express();

app.use(helmet());

// Trust the first proxy hop (Render / Railway sits behind one layer of reverse proxy).
// Without this, req.ip would always be the proxy's IP, making IP-based rate limiting useless.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// GLOBAL RATE LIMITER
// 100 requests per 15 minutes per IP across all routes.
// Acts as a broad abuse shield; stricter limiters are applied per sensitive route.
// ---------------------------------------------------------------------------
const globalLimiter = rateLimit({
   windowMs: 15 * 60 * 1000, // 15 minutes
   max: 1000,
   standardHeaders: "draft-7", // Return rate-limit info in `RateLimit-*` headers (RFC draft 7)
   legacyHeaders: false,       // Disable the deprecated `X-RateLimit-*` headers
   handler: (req, res) => {
      return res.status(429).json({
         success: false,
         message: "Too many requests. Please try again later."
      });
   }
});

const corsOptions = {
   origin: true,
   methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
   allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
   credentials: true,
   optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(globalLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/reports", reportRoutes);
app.use("/api/users", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/adoptions", adoptionRoutes);
app.use("/api/ngo", ngoRoutes);

app.get("/test-firebase-admin", (req, res) => {
   if (!admin.isFirebaseAdminInitialized()) {
      return res.status(500).json({
         success: false
      });
   }

   res.json({
      success: true
   });
});


app.get("/", (req, res) => {

   res.json({
      message: "Server Running"
   });



});

async function startServer() {
   try {
      await mongoose.connect(process.env.MONGO_URI, {
         maxPoolSize: 500, // Prevents pool bottleneck under high concurrent load (300 VUs)
         minPoolSize: 50
      });
      console.log("MongoDB Connected");

      app.listen(5000, () => {
         console.log("Server running on port 5000");
      });
   } catch (error) {
      console.error(error.stack);
      process.exit(1);
   }
}

startServer();