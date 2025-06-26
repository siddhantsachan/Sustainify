# 🌱 Sustainify

**Sustainify** is a full-stack scrap recycling platform aimed at streamlining the process of scrap collection and promoting sustainable practices. It allows users to schedule pickups, view recycling suggestions, and enables admin control over rates and logistics.

---

## 🚀 Features

- 📦 Scrap pickup scheduling with real-time location capture
- 🗺️ Google Maps API integration for geolocation and address autocomplete
- 🤖 Google Gemini API integration to suggest dynamic DIY recycling ideas
- 🔐 Secure user authentication using bcrypt and express-session
- 📊 Admin dashboard to manage pickups, update scrap rates, and approve user requests
- 🌐 External image linking for item management, reducing storage overhead

---

## 🛠 Tech Stack

**Frontend:**  
- HTML  
- CSS  
- JavaScript  

**Backend:**  
- Node.js  
- Express.js  
- MongoDB  

**APIs & Libraries:**  
- Google Maps API (Geolocation + Autocomplete)  
- Google Gemini API (AI-powered suggestions)  
- Bcrypt (Password hashing)  
- Express-session (Session management)

---

## 📦 Folder Structure

```bash
Sustainify/
│
├── backend/               # Node.js + Express server
│   ├── routes/            # API routes (users, pickups, admin)
│   ├── controllers/       # Business logic
│   ├── models/            # MongoDB schemas
│   └── utils/             # Helper functions (authentication, validation)
│
├── frontend/              # HTML/CSS/JS interface
│   └── public/            # Static assets
│
├── .env                   # API keys and environment variables
└── README.md
