const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const User = require("../models/UserAuth");
const pickmodel = require("../models/pickup");
const { requireUserAuth } = require("../middleware/auth");
const { sendMail } = require("../utils/mailer");

// ---------------------------------------------------------------------------
// Rate Limiters
// Design decision: Per-IP limiting on OTP and login endpoints.
//   - OTP: 4-digit = 10,000 combinations. Without limiting, trivially brute-forced.
//   - Login: Prevents credential stuffing.
//   - Why per-IP and not per-account? Per-account limiting can be weaponised
//     by attackers to lock out a target user (DoS). Per-IP is safer.
// ---------------------------------------------------------------------------
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: "Too many requests. Please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again after 15 minutes.",
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Homepage (checks all three session types)
// ---------------------------------------------------------------------------
router.get(["/", "/index"], (req, res) => {
  let account = "Login";
  if (req.session.Name) account = req.session.Name;
  else if (req.session.pickupName) account = req.session.pickupName;
  else if (req.session.adminName) account = "Admin";
  res.render("index", { Account: account });
});

// AskPage — redirect to Profile if already logged in
router.get("/AskPage", (req, res) => {
  if (req.session.Name || req.session.pickupName || req.session.adminName) {
    return res.redirect("/Profile");
  }
  res.render("AskPage");
});

// ChooseOptionPage — regular users only
router.get("/ChooseOptionPage", requireUserAuth, (req, res) => {
  res.render("ChooseOptionPage", { nm: req.session.Name });
});

// Checkoptions — shows Scheduled / Completed buttons
router.get("/Checkoptions", (req, res) => {
  res.render("Checkoption");
});

// Goback
router.get("/Goback", (req, res) => {
  res.redirect("/ChooseOptionPage");
});

// ---------------------------------------------------------------------------
// Profile — role-based rendering
// ---------------------------------------------------------------------------
router.get("/Profile", (req, res) => {
  if (req.session.Email) {
    return res.render("userProfile", {
      user: { Name: req.session.Name, Email: req.session.Email },
    });
  }
  if (req.session.pickupEmail) {
    return res.render("pickupProfile", {
      user: { Name: req.session.pickupName, Email: req.session.pickupEmail },
    });
  }
  if (req.session.adminName) {
    return res.render("AdminProfile", {
      user: { Name: req.session.adminName, Email: process.env.ADMIN_EMAIL },
    });
  }
  res.redirect("/LoginPage");
});

// Logout — single handler for all roles
router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.redirect("/index");
  });
});

// Also handle /Logout (used in some older links)
router.get("/Logout", (req, res) => res.redirect("/logout"));

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------
router.get("/Signup", (req, res) => {
  res.render("Signup", { errorMessage: " " });
});

router.post(
  "/Signup",
  otpLimiter,
  [
    body("email").isEmail().withMessage("Invalid email address"),
    body("name").trim().isLength({ min: 2 }).withMessage("Name must be at least 2 characters"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("Signup", { errorMessage: errors.array()[0].msg });
    }

    const { email, name, password, confpassword } = req.body;

    if (password !== confpassword) {
      return res.render("Signup", { errorMessage: "Passwords do not match" });
    }

    const existingUser = await User.findOne({ Email: email });
    if (existingUser) {
      return res.render("Signup", { errorMessage: "Email already registered" });
    }

    req.session.name = name;
    req.session.email = email;
    req.session.password = password;
    req.session.otp = Math.floor(Math.random() * 9000) + 1000;
    req.session.redirect = 1;

    console.log(`[OTP] Signup OTP for ${email}: ${req.session.otp}`);
    sendMail(email, "Confirm your Sustainify signup", `Your signup code is ${req.session.otp}`);

    res.redirect("/otp");
  }
);

// ---------------------------------------------------------------------------
// OTP verification (shared for signup + forgot-password)
// ---------------------------------------------------------------------------
router.get("/otp", (req, res) => res.render("otp", { errorMessage: "" }));

router.post("/otp", async (req, res, next) => {
  const { otp } = req.body;

  if (String(otp) !== String(req.session.otp)) {
    return res.render("otp", { errorMessage: "Wrong OTP. Please try again." });
  }

  if (req.session.redirect === 1) {
    try {
      const hashedPassword = await bcrypt.hash(req.session.password, 10);
      await new User({
        Name: req.session.name,
        Email: req.session.email,
        Password: hashedPassword,
      }).save();

      delete req.session.name;
      delete req.session.email;
      delete req.session.password;
      delete req.session.otp;
      delete req.session.redirect;

      return res.redirect("/LoginPage");
    } catch (err) {
      return next(err);
    }
  } else {
    delete req.session.otp;
    delete req.session.redirect;
    return res.redirect("/NewPass");
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
router.get("/LoginPage", (req, res) => {
  res.render("LoginPage", { errorMessage: " " });
});

router.post("/LoginPage", loginLimiter, async (req, res, next) => {
  const { email, password, forgetemail } = req.body;

  if (forgetemail) {
    try {
      const user = await User.findOne({ Email: forgetemail });
      if (!user) return res.render("LoginPage", { errorMessage: "Email not found" });

      req.session.otp = Math.floor(Math.random() * 9000) + 1000;
      req.session.redirect = 0;
      req.session.forgotEmail = forgetemail;

      console.log(`[OTP] Reset OTP for ${forgetemail}: ${req.session.otp}`);
      sendMail(forgetemail, "Sustainify password reset", `Your reset code is ${req.session.otp}`);

      return res.redirect("/otp");
    } catch (err) {
      return next(err);
    }
  }

  try {
    const user = await User.findOne({ Email: email });
    if (!user) return res.render("LoginPage", { errorMessage: "User not found" });

    const isMatch = await bcrypt.compare(password, user.Password);
    if (!isMatch) return res.render("LoginPage", { errorMessage: "Incorrect password" });

    req.session.Email = user.Email;
    req.session.Name = user.Name;
    res.redirect("/ChooseOptionPage");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// New Password (after forgot-password OTP)
// ---------------------------------------------------------------------------
router.get("/NewPass", (req, res) => res.render("NewPass"));

router.post("/NewPass", async (req, res, next) => {
  try {
    const user = await User.findOne({ Email: req.session.forgotEmail });
    if (!user) return res.status(404).send("User not found");

    user.Password = await bcrypt.hash(req.body.newpass, 10);
    await user.save();

    delete req.session.forgotEmail;
    res.redirect("/LoginPage");
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Schedule Pickup
// ---------------------------------------------------------------------------
router.post("/SchedulePickup", requireUserAuth, (req, res) => {
  res.render("SchedulePickup", { username: req.session.Name, errorMessage: "" });
});

router.post(
  "/CreatePickup",
  requireUserAuth,
  [
    body("date").notEmpty().withMessage("Date is required"),
    body("time").notEmpty().withMessage("Time is required"),
    body("address").trim().isLength({ min: 5 }).withMessage("Address must be at least 5 characters"),
    body("pincode")
      .isNumeric()
      .isLength({ min: 6, max: 6 })
      .withMessage("Pincode must be exactly 6 digits"),
    body("weight").notEmpty().withMessage("Please select estimated weight"),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render("SchedulePickup", {
        username: req.session.Name,
        errorMessage: errors.array()[0].msg,
      });
    }

    try {
      const { date, time, address, weight, remarks, pincode } = req.body;
      await pickmodel.create({
        date, time, address, weight, remarks, pincode,
        email: req.session.Email,
      });
      res.redirect("/Checkoptions");
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// View Pickups
// ---------------------------------------------------------------------------
router.get("/ScheduledPickups", requireUserAuth, async (req, res, next) => {
  try {
    const pickups = await pickmodel.find({ email: req.session.Email, status: "Pending" });
    res.render("ScheduledPickups", { pickups });
  } catch (err) { next(err); }
});

router.get("/CompletedPickups", requireUserAuth, async (req, res, next) => {
  try {
    const pickups = await pickmodel.find({ email: req.session.Email, status: "Completed" });
    res.render("CompletedPickups", { pickups });
  } catch (err) { next(err); }
});

router.get("/cancelPickup/:id", requireUserAuth, async (req, res, next) => {
  try {
    // IDOR fix: scope deletion to the logged-in user's email only
    const deleted = await pickmodel.findOneAndDelete({
      _id: req.params.id,
      email: req.session.Email,
    });
    if (!deleted) {
      return res.status(403).send("Pickup not found or you do not have permission to cancel it.");
    }
    res.redirect("/ScheduledPickups");
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Gemini — AI Recycling Suggestions
// Design decision: API call happens on the backend, not the frontend.
//   - API key stays in .env — not exposed in browser source.
//   - We use gemini-1.5-flash (not pro) — faster and cheaper for short text.
// ---------------------------------------------------------------------------
router.get("/RecycleSuggestions", requireUserAuth, (req, res) => {
  res.render("RecycleSuggestions", { username: req.session.Name });
});

router.post("/api/gemini-suggest", requireUserAuth, async (req, res, next) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "Gemini API key not configured. Add GEMINI_API_KEY to .env" });
    }

    const { scrapType } = req.body;
    if (!scrapType || !scrapType.trim()) {
      return res.status(400).json({ error: "scrapType is required" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `You are a sustainability and recycling expert. The user has "${scrapType.trim()}" as scrap or waste material.
Give them exactly 10 practical, creative DIY ideas to reuse or upcycle it before sending it for recycling.
Format as a numbered list (1. to 10.). Each entry: a short idea name, colon, then a one-line description.
Keep it concise, beginner-friendly, and specific to ${scrapType.trim()}.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const suggestions = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d+\./.test(l));

    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
