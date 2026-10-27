const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { buildRAGContext } = require("./ragService");

// ---------------------------------------------------------------------------
// Gemini Structured Output schema — eliminates regex parsing entirely.
// Gemini is constrained to return this exact JSON shape on every response.
// ---------------------------------------------------------------------------
const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    reply: {
      type: SchemaType.STRING,
      description: "Your conversational response to the user.",
    },
    bookingData: {
      type: SchemaType.OBJECT,
      description:
        "Booking fields collected so far. Only include fields the user has EXPLICITLY provided. null if no booking discussion.",
      nullable: true,
      properties: {
        date: {
          type: SchemaType.STRING,
          description: "Pickup date in YYYY-MM-DD format.",
          nullable: true,
        },
        time: {
          type: SchemaType.STRING,
          description: "Time slot like '10:00 AM - 1:00 PM'.",
          nullable: true,
        },
        address: {
          type: SchemaType.STRING,
          description: "Full street address provided by user.",
          nullable: true,
        },
        pincode: {
          type: SchemaType.STRING,
          description: "6-digit Indian postal code.",
          nullable: true,
        },
        weight: {
          type: SchemaType.STRING,
          description: "Estimated weight range like '5-10 kg'.",
          nullable: true,
        },
        remarks: {
          type: SchemaType.STRING,
          description: "Optional remarks about scrap items.",
          nullable: true,
        },
      },
    },
  },
  required: ["reply"],
};

// ---------------------------------------------------------------------------
// Sliding window: keep only the last N message pairs for Gemini context
// ---------------------------------------------------------------------------
const MAX_HISTORY_PAIRS = 10; // 10 user+model pairs = 20 messages

function trimHistory(history) {
  if (!history || history.length <= MAX_HISTORY_PAIRS * 2) return history;
  return history.slice(-(MAX_HISTORY_PAIRS * 2));
}

// ---------------------------------------------------------------------------
// Normalize conversation history into Gemini's { role, parts } format
// ---------------------------------------------------------------------------
function formatHistoryForGemini(history = []) {
  return history
    .filter((msg) => msg && (msg.role === "user" || msg.role === "model"))
    .map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.content || "" }],
    }));
}

// ---------------------------------------------------------------------------
// Server-side slot validation (deterministic — not controlled by LLM)
// ---------------------------------------------------------------------------
function validateBookingSlots(data) {
  if (!data) return ["No booking data provided."];

  const errors = [];
  const required = ["date", "time", "address", "pincode", "weight"];

  // Check completeness first
  for (const field of required) {
    if (!data[field] || String(data[field]).trim() === "") {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (errors.length > 0) return errors;

  // Date: valid future date
  const parsedDate = new Date(data.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(parsedDate.getTime())) {
    errors.push("Date format is invalid. Use YYYY-MM-DD (e.g. 2026-12-01).");
  } else if (parsedDate < today) {
    errors.push("Date must be today or in the future.");
  }

  // Pincode: exactly 6 digits
  const pin = String(data.pincode).trim();
  if (!/^\d{6}$/.test(pin)) {
    errors.push("Pincode must be exactly 6 digits.");
  }

  // Time: should contain AM/PM indication
  if (!/\d{1,2}[:.]\d{2}\s*(AM|PM)/i.test(data.time)) {
    errors.push("Please provide a valid time slot between 9:00 AM and 6:00 PM.");
  }

  // Address: meaningful length
  if (data.address.trim().length < 5) {
    errors.push("Address is too short. Please provide a complete doorstep address.");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Fallback response when GEMINI_API_KEY is not configured
// ---------------------------------------------------------------------------
function generateOfflineResponse(userMessage, ragContext) {
  const lower = userMessage.toLowerCase();
  let reply =
    "Hello! I am EcoBot, Sustainify's recycling and scheduling assistant.\n\n";

  if (ragContext) {
    reply += `Here is what I found in our database:\n\n${ragContext}\n\n`;
  }

  if (
    lower.includes("schedule") ||
    lower.includes("book") ||
    lower.includes("pickup")
  ) {
    reply +=
      "To schedule a doorstep pickup, please provide:\n" +
      "1. Pickup Date\n" +
      "2. Time Slot (e.g. 10:00 AM - 1:00 PM)\n" +
      "3. Full Address\n" +
      "4. 6-digit Pincode\n" +
      "5. Estimated Weight (e.g. 5-10 kg)\n\n" +
      "You can also use our direct form at `/SchedulePickup`.";
  } else {
    reply +=
      "Feel free to ask me about scrap rates, accepted materials, minimum weights, or scheduling a pickup!";
  }

  return { reply, bookingData: null };
}

// ---------------------------------------------------------------------------
// Main chat function — structured output + RAG + sliding window
// ---------------------------------------------------------------------------
async function chatWithAssistant(userMessage, history = [], sessionUser = {}) {
  // 1. Build RAG Context (Knowledge Base + Live DB Scrap Rates)
  const ragContext = await buildRAGContext(userMessage);

  if (!process.env.GEMINI_API_KEY) {
    return generateOfflineResponse(userMessage, ragContext);
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Model with structured output — Gemini is FORCED to return our JSON schema
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const todayDate = new Date().toISOString().split("T")[0];
    const userName = sessionUser.Name || "User";
    const userEmail = sessionUser.Email || "";

    const systemInstruction = `You are 'EcoBot', the friendly AI Eco-Assistant for Sustainify — an eco-friendly scrap recycling and doorstep collection platform.
User's Name: ${userName}
User's Email: ${userEmail}
Current System Date: ${todayDate}

=== RETRIEVED RAG CONTEXT (USE THIS TO ANSWER ACCURATELY) ===
${ragContext || "No specific knowledge base entry retrieved. Rely on Sustainify general knowledge (we buy paper, metals, plastics, appliances, e-waste; 9 AM - 6 PM operating hours; 5 kg minimum recommended)."}
=============================================================

Your Capabilities:
1. Answer questions about scrap prices, recyclable categories, non-acceptable items, and eco-impact using the RAG context above.
2. Assist users in estimating scrap value.
3. Conversational Scheduling Assistant: Walk the user through scheduling a scrap pickup.

SCHEDULING RULES:
You need these 5 details from the user to schedule a pickup:
1. Date — A valid upcoming date. Output it in YYYY-MM-DD format.
2. Time — A preferred time slot between 9:00 AM and 6:00 PM (e.g. "10:00 AM - 1:00 PM").
3. Address — Complete doorstep address with house/flat number and street.
4. Pincode — Exactly 6 digits (Indian postal code). Do NOT guess or assume a pincode.
5. Weight — Estimated weight range (e.g. "5-10 kg", "10-20 kg", "20-50 kg", "50+ kg").

Important:
- When the user wants to schedule, warmly guide them and ask for missing details one or two at a time.
- NEVER invent, guess, or hallucinate any field the user has not explicitly stated.
- Populate bookingData with ONLY the fields the user has explicitly provided so far.
- When all 5 fields are provided, summarize them neatly with emojis in your reply and tell the user to click the "Confirm & Book Pickup" button.
- Keep your tone conversational, enthusiastic about sustainability, and helpful.`;

    // Apply sliding window to history
    const trimmedHistory = trimHistory(history);
    const formattedHistory = formatHistoryForGemini(trimmedHistory);

    const chat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: systemInstruction }],
        },
        {
          role: "model",
          parts: [
            {
              text: JSON.stringify({
                reply: `Hello ${userName}! I'm EcoBot, your Sustainify assistant. How can I help you today with scrap rates, recycling info, or scheduling a pickup?`,
                bookingData: null,
              }),
            },
          ],
        },
        ...formattedHistory,
      ],
    });

    const result = await chat.sendMessage(userMessage);
    const rawText = result.response.text();

    // Parse structured JSON response (guaranteed by responseSchema)
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.warn("[Assistant] Failed to parse structured response, treating as plain text:", parseErr.message);
      return { reply: rawText, bookingData: null };
    }

    return {
      reply: parsed.reply || rawText,
      bookingData: parsed.bookingData || null,
    };
  } catch (err) {
    console.error("[Assistant] Gemini chat error:", err.message);
    return generateOfflineResponse(userMessage, ragContext);
  }
}

module.exports = {
  chatWithAssistant,
  validateBookingSlots,
};
