const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");
const pickmodel = require("../models/pickup");
const { requireUserAuth } = require("../middleware/auth");
const { chatWithAssistant, validateBookingSlots } = require("../services/assistantService");
const { getKnowledgeStats } = require("../services/ragService");
const { sendMail } = require("../utils/mailer");
const { nominatimSearch } = require("../utils/geocoder");

// ---------------------------------------------------------------------------
// Rate Limiters
// ---------------------------------------------------------------------------
const assistantChatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // Limit each IP to 60 chat messages per 15 minutes
  message: { error: "Too many messages sent. Please wait a few minutes before chatting again." },
  standardHeaders: true,
  legacyHeaders: false,
});

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Limit each IP to 10 booking confirmation attempts per 15 minutes
  message: { error: "Too many booking attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Dedicated Full-Page Assistant View
// ---------------------------------------------------------------------------
router.get("/assistant", requireUserAuth, (req, res) => {
  res.render("assistant", {
    username: req.session.Name || "Friend",
    email: req.session.Email,
  });
});

// ---------------------------------------------------------------------------
// Assistant Chat API — State Machine + Server-Side History
//
// States:  idle → gathering → draft_ready
//   idle:        No booking in progress. General Q&A.
//   gathering:   User wants a booking. Collecting the 5 required fields.
//   draft_ready: All 5 fields validated. Draft staged in session.
//                Waiting for user to click "Confirm".
// ---------------------------------------------------------------------------
router.post(
  "/api/assistant/chat",
  requireUserAuth,
  assistantChatLimiter,
  [body("message").trim().notEmpty().withMessage("Message cannot be empty")],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
      const { message } = req.body;

      // --- Initialize session state if needed ---
      if (!req.session.chatHistory) req.session.chatHistory = [];
      if (!req.session.assistantState) req.session.assistantState = "idle";

      // --- Add user message to server-side history ---
      req.session.chatHistory.push({ role: "user", content: message });

      const sessionUser = {
        Name: req.session.Name,
        Email: req.session.Email,
      };

      // --- Call Gemini with server-side history (sliding window applied internally) ---
      const result = await chatWithAssistant(
        message,
        req.session.chatHistory,
        sessionUser
      );

      // --- Add model reply to server-side history ---
      req.session.chatHistory.push({ role: "model", content: result.reply });

      // --- Sliding window: trim server history to last 20 messages (10 pairs) ---
      const MAX_SESSION_MESSAGES = 20;
      if (req.session.chatHistory.length > MAX_SESSION_MESSAGES) {
        req.session.chatHistory = req.session.chatHistory.slice(-MAX_SESSION_MESSAGES);
      }

      // --- State Machine: evaluate bookingData from Gemini ---
      let draftReady = false;
      let validationErrors = null;
      let enrichedBookingData = result.bookingData;

      if (result.bookingData) {
        let bd = { ...result.bookingData };

        // --- Geocoding: auto-fill pincode from address if missing ---
        if (bd.address && (!bd.pincode || bd.pincode.trim() === "")) {
          try {
            const geo = await nominatimSearch(bd.address);
            if (geo && geo.pincode) {
              bd.pincode = geo.pincode;
              console.log(`[Geocoder] Auto-resolved pincode ${geo.pincode} from address: "${bd.address}"`);
            }
          } catch (geoErr) {
            console.warn("[Geocoder] Address lookup failed:", geoErr.message);
          }
        }

        // --- Server-side slot validation (deterministic, not LLM-controlled) ---
        const slotErrors = validateBookingSlots(bd);

        if (slotErrors.length === 0) {
          // All 5 fields present and valid → stage draft
          req.session.assistantState = "draft_ready";
          req.session.bookingDraft = bd;
          draftReady = true;
          enrichedBookingData = bd;
        } else {
          // Fields missing or invalid → stay in gathering
          req.session.assistantState = "gathering";
          validationErrors = slotErrors;
        }
      }

      // --- Check for cancellation / reset intent ---
      const lowerMsg = message.toLowerCase();
      if (
        lowerMsg.includes("cancel") ||
        lowerMsg.includes("start over") ||
        lowerMsg.includes("never mind") ||
        lowerMsg.includes("forget it")
      ) {
        req.session.assistantState = "idle";
        req.session.bookingDraft = null;
        draftReady = false;
        enrichedBookingData = null;
      }

      res.json({
        reply: result.reply,
        bookingData: enrichedBookingData,
        draftReady,
        validationErrors,
        state: req.session.assistantState,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Confirm Booking — Human-in-the-Loop (HITL) Gate
//
// Only writes to MongoDB if a validated draft exists in the session.
// Prevents hallucinated or accidental bookings.
// ---------------------------------------------------------------------------
router.post(
  "/api/assistant/confirm-booking",
  requireUserAuth,
  bookingLimiter,
  async (req, res, next) => {
    try {
      // --- HITL Gate: check session draft exists ---
      const draft = req.session.bookingDraft;
      const state = req.session.assistantState;

      if (state !== "draft_ready" || !draft) {
        return res.status(400).json({
          error: "No validated booking draft found. Please complete all pickup details with EcoBot first.",
        });
      }

      // --- Re-validate draft one final time (defense in depth) ---
      const finalErrors = validateBookingSlots(draft);
      if (finalErrors.length > 0) {
        req.session.assistantState = "gathering";
        req.session.bookingDraft = null;
        return res.status(400).json({
          error: "Booking validation failed: " + finalErrors.join("; "),
        });
      }

      // --- Normalize date ---
      let parsedDate = new Date(draft.date);
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date();
      }

      // --- Write to MongoDB ---
      const newPickup = await pickmodel.create({
        date: parsedDate,
        time: draft.time,
        address: draft.address,
        pincode: Number(draft.pincode),
        weight: draft.weight,
        remarks: draft.remarks || "Booked via Conversational AI Assistant",
        email: req.session.Email,
        status: "Pending",
      });

      // --- Reset state after successful booking ---
      req.session.assistantState = "idle";
      req.session.bookingDraft = null;

      // --- Send confirmation email (non-blocking) ---
      try {
        const mailBody =
          `Hello ${req.session.Name || "Sustainify User"},\n\n` +
          `Your scrap pickup has been confirmed via our AI Assistant!\n\n` +
          `Pickup ID: ${newPickup._id}\n` +
          `Date: ${parsedDate.toDateString()}\n` +
          `Time Slot: ${draft.time}\n` +
          `Address: ${draft.address} (Pincode: ${draft.pincode})\n` +
          `Estimated Weight: ${draft.weight}\n\n` +
          `A verified pickup boy will contact you on the scheduled date.\n\n` +
          `Thank you for helping keep the planet green!\nTeam Sustainify`;

        sendMail(req.session.Email, "Pickup Confirmation - Sustainify", mailBody);
      } catch (mailErr) {
        console.warn("[Assistant] Email dispatch warning:", mailErr.message);
      }

      res.json({
        success: true,
        pickupId: newPickup._id,
        message: "Pickup successfully scheduled!",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Reset conversation state (clear history + booking draft)
// ---------------------------------------------------------------------------
router.post("/api/assistant/reset", requireUserAuth, (req, res) => {
  req.session.chatHistory = [];
  req.session.assistantState = "idle";
  req.session.bookingDraft = null;
  res.json({ success: true, message: "Conversation reset." });
});

// ---------------------------------------------------------------------------
// Knowledge Base & RAG Status
// ---------------------------------------------------------------------------
router.get("/api/assistant/status", requireUserAuth, (req, res) => {
  res.json({
    status: "ok",
    state: req.session.assistantState || "idle",
    stats: getKnowledgeStats(),
  });
});

module.exports = router;
