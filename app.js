/**
 * Sustainify — Main Application Entry Point
 *
 * This file is intentionally kept thin. All route logic lives in:
 *   routes/user.js       — user auth, pickups, Gemini AI
 *   routes/pickupboy.js  — pickup boy auth & operations
 *   routes/admin.js      — admin dashboard & management
 *   routes/scrap.js      — scrap rates & price calculator
 */
require("dotenv").config();

const express    = require("express");
const mongoose   = require("mongoose");
const session    = require("express-session");
const bodyparser = require("body-parser");

const app = express();

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
mongoose
  .connect("mongodb://127.0.0.1:27017/ScrapData")
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ---------------------------------------------------------------------------
// View engine
// ---------------------------------------------------------------------------
app.set("view engine", "ejs");
app.use(express.static("Public"));

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
app.use(bodyparser.urlencoded({ extended: true }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "software_engineering",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }, // 1 hour
  })
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use("/", require("./routes/user"));
app.use("/", require("./routes/pickupboy"));
app.use("/", require("./routes/admin"));
app.use("/", require("./routes/scrap"));

// ---------------------------------------------------------------------------
// Centralised error handler
// Must be defined after all routes (4 parameters = error handler in Express)
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("[Error]", err.stack || err.message);
  const status = err.status || 500;
  const message = status === 500 ? "An internal server error occurred." : err.message;
  res.status(status).render("error", { message });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(3000, () => {
  console.log("Sustainify server running at http://localhost:3000");
});
