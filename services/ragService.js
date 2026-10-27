const path = require("path");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const ScrapItem = require("../models/ScrapItem");

// ---------------------------------------------------------------------------
// Load static knowledge base
// ---------------------------------------------------------------------------
const kbPath = path.join(__dirname, "../data/knowledgeBase.json");
let knowledgeChunks = [];

try {
  const raw = fs.readFileSync(kbPath, "utf-8");
  knowledgeChunks = JSON.parse(raw);
} catch (err) {
  console.error("[RAG] Failed to load knowledge base file:", err.message);
  knowledgeChunks = [];
}

// ---------------------------------------------------------------------------
// Embedding caches
// ---------------------------------------------------------------------------
let kbEmbeddingCache = {};          // { [chunkId]: number[] }
let isKBEmbeddingReady = false;
let isKBEmbeddingInProgress = false;

let scrapEmbeddingCache = {};       // { [itemId]: { embedding: number[], item: object } }
let isScrapEmbeddingReady = false;
let isScrapEmbeddingInProgress = false;

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Keyword fallback scorer (used when embeddings API is unavailable)
// ---------------------------------------------------------------------------
function keywordRelevanceScore(query, text) {
  const qTokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (qTokens.length === 0) return 0;

  const lowerText = text.toLowerCase();
  let matches = 0;
  for (const token of qTokens) {
    if (lowerText.includes(token)) matches++;
  }
  return matches / qTokens.length;
}

// ---------------------------------------------------------------------------
// Initialize KB embeddings (once, at first query)
// ---------------------------------------------------------------------------
async function initializeKBEmbeddings() {
  if (isKBEmbeddingReady || isKBEmbeddingInProgress) return;
  if (!process.env.GEMINI_API_KEY) {
    console.log("[RAG] GEMINI_API_KEY not found; using keyword-based retrieval fallback.");
    return;
  }

  isKBEmbeddingInProgress = true;
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

    console.log(`[RAG] Generating vector embeddings for ${knowledgeChunks.length} knowledge chunks...`);
    for (const chunk of knowledgeChunks) {
      if (!kbEmbeddingCache[chunk.id]) {
        const textToEmbed = `${chunk.title} (${chunk.category}): ${chunk.content}`;
        const res = await embeddingModel.embedContent(textToEmbed);
        kbEmbeddingCache[chunk.id] = res.embedding.values;
      }
    }
    isKBEmbeddingReady = true;
    console.log("[RAG] Knowledge base embeddings initialized successfully.");
  } catch (err) {
    console.warn("[RAG] KB embedding generation warning:", err.message);
  } finally {
    isKBEmbeddingInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Initialize scrap item embeddings for semantic material matching
// ---------------------------------------------------------------------------
async function initializeScrapEmbeddings() {
  if (isScrapEmbeddingReady || isScrapEmbeddingInProgress) return;
  if (!process.env.GEMINI_API_KEY) return;

  isScrapEmbeddingInProgress = true;
  try {
    const allItems = await ScrapItem.find().lean();
    if (!allItems || allItems.length === 0) {
      isScrapEmbeddingInProgress = false;
      return;
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

    console.log(`[RAG] Generating vector embeddings for ${allItems.length} scrap items...`);
    for (const item of allItems) {
      const id = item._id.toString();
      if (!scrapEmbeddingCache[id]) {
        const textToEmbed = `${item.name} (${item.category}) — recyclable scrap material`;
        const res = await embeddingModel.embedContent(textToEmbed);
        scrapEmbeddingCache[id] = { embedding: res.embedding.values, item };
      }
    }
    isScrapEmbeddingReady = true;
    console.log("[RAG] Scrap item embeddings initialized successfully.");
  } catch (err) {
    console.warn("[RAG] Scrap embedding generation warning:", err.message);
  } finally {
    isScrapEmbeddingInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Retrieve top-K relevant knowledge base chunks (hybrid: vector + keyword)
// ---------------------------------------------------------------------------
async function retrieveKnowledgeChunks(query, topK = 3) {
  if (!query || knowledgeChunks.length === 0) return [];

  // Try semantic vector search
  if (process.env.GEMINI_API_KEY) {
    if (!isKBEmbeddingReady && !isKBEmbeddingInProgress) {
      await initializeKBEmbeddings();
    }

    if (isKBEmbeddingReady) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const res = await embeddingModel.embedContent(query);
        const queryVector = res.embedding.values;

        const scored = knowledgeChunks.map((chunk) => {
          const chunkVector = kbEmbeddingCache[chunk.id];
          const sim = chunkVector ? cosineSimilarity(queryVector, chunkVector) : 0;
          return { chunk, score: sim };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK).map((item) => item.chunk);
      } catch (err) {
        console.warn("[RAG] Query embedding failed; falling back to keyword search:", err.message);
      }
    }
  }

  // Fallback: Keyword relevance
  const scored = knowledgeChunks.map((chunk) => {
    const text = `${chunk.title} ${chunk.category} ${chunk.content}`;
    const score = keywordRelevanceScore(query, text);
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((item) => item.chunk);
}

// ---------------------------------------------------------------------------
// Retrieve live scrap rates — semantic vector matching with keyword fallback
// ---------------------------------------------------------------------------
async function retrieveLiveScrapRates(query) {
  try {
    const allItems = await ScrapItem.find().lean();
    if (!allItems || allItems.length === 0) return [];

    const lowerQuery = query.toLowerCase();

    // Quick intent check: does the query relate to materials or pricing?
    const rateKeywords = ["rate", "price", "cost", "how much", "worth", "value", "kg", "per", "scrap", "sell"];
    const isRatesQuery = rateKeywords.some((kw) => lowerQuery.includes(kw));
    const mentionsMaterial = allItems.some((item) => {
      const name = (item.name || "").toLowerCase();
      return name.length > 2 && lowerQuery.includes(name);
    });

    if (!isRatesQuery && !mentionsMaterial) return [];

    // General rates query with no specific material → return a sample
    if (isRatesQuery && !mentionsMaterial) {
      return allItems.slice(0, 10);
    }

    // --- Semantic matching for specific material queries ---
    if (process.env.GEMINI_API_KEY) {
      if (!isScrapEmbeddingReady && !isScrapEmbeddingInProgress) {
        await initializeScrapEmbeddings();
      }

      if (isScrapEmbeddingReady) {
        try {
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
          const queryRes = await embeddingModel.embedContent(query);
          const queryVec = queryRes.embedding.values;

          const scored = Object.values(scrapEmbeddingCache).map(({ embedding, item }) => ({
            item,
            score: cosineSimilarity(queryVec, embedding),
          }));
          scored.sort((a, b) => b.score - a.score);

          // Return items above a relevance threshold, capped at 5
          const matches = scored.filter((s) => s.score > 0.45).slice(0, 5);
          if (matches.length > 0) return matches.map((s) => s.item);

          // If nothing above threshold, return top 3 anyway
          return scored.slice(0, 3).map((s) => s.item);
        } catch (err) {
          console.warn("[RAG] Semantic scrap matching failed, using keyword fallback:", err.message);
        }
      }
    }

    // --- Keyword fallback ---
    return allItems.filter((item) => {
      const name = (item.name || "").toLowerCase();
      const cat = (item.category || "").toLowerCase();
      return lowerQuery.includes(name) || lowerQuery.includes(cat);
    });
  } catch (err) {
    console.error("[RAG] Error fetching scrap rates from DB:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Assemble full RAG context string for the AI prompt
// ---------------------------------------------------------------------------
async function buildRAGContext(query) {
  const [relevantChunks, relevantScrapItems] = await Promise.all([
    retrieveKnowledgeChunks(query, 3),
    retrieveLiveScrapRates(query),
  ]);

  let contextParts = [];

  // 1. Live Database Scrap Rates
  if (relevantScrapItems.length > 0) {
    const ratesText = relevantScrapItems
      .map((item) => `• ${item.name} (${item.category}): ₹${item.price} per ${item.unit}`)
      .join("\n");
    contextParts.push(`### Live Scrap Database Rates (Real-Time from Sustainify DB):\n${ratesText}`);
  }

  // 2. Knowledge Base Documents
  if (relevantChunks.length > 0) {
    const kbText = relevantChunks
      .map((chunk) => `[Topic: ${chunk.title} | Category: ${chunk.category}]\n${chunk.content}`)
      .join("\n\n");
    contextParts.push(`### Sustainify Platform Knowledge & Guidelines:\n${kbText}`);
  }

  return contextParts.join("\n\n");
}

module.exports = {
  initializeKBEmbeddings,
  initializeScrapEmbeddings,
  retrieveKnowledgeChunks,
  retrieveLiveScrapRates,
  buildRAGContext,
  getKnowledgeStats: () => ({
    totalChunks: knowledgeChunks.length,
    kbEmbeddingsReady: isKBEmbeddingReady,
    scrapEmbeddingsReady: isScrapEmbeddingReady,
  }),
};
