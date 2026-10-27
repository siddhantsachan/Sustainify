(function () {
  // Prevent duplicate initialization
  if (document.getElementById("sustainify-chat-root")) return;

  const root = document.createElement("div");
  root.id = "sustainify-chat-root";
  root.innerHTML = `
    <!-- Floating Trigger Bubble -->
    <button class="sustainify-chat-trigger" id="sustainifyChatTrigger" title="Chat with Sustainify AI Assistant">
      <span class="badge-pulse"></span>
      <i class="fas fa-robot"></i>
    </button>

    <!-- Floating Chat Window Drawer -->
    <div class="sustainify-chat-window" id="sustainifyChatWindow">
      <div class="widget-header">
        <div class="widget-header-title">
          <div class="widget-avatar">🌱</div>
          <div>
            <h4>EcoBot Assistant</h4>
            <p>RAG Grounded • Live Scrap Rates</p>
          </div>
        </div>
        <div class="widget-actions">
          <a href="/assistant" class="widget-btn-icon" title="Expand Fullscreen" target="_blank">
            <i class="fas fa-expand-alt"></i>
          </a>
          <button class="widget-btn-icon" id="widgetCloseBtn" title="Close Chat">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>

      <div class="widget-messages" id="widgetMessages">
        <div class="widget-msg bot">
          <div class="widget-bubble">
            <p>👋 Hi! Need scrap rates or want to schedule a doorstep pickup? Ask me anything!</p>
          </div>
        </div>
      </div>

      <form class="widget-input-bar" id="widgetChatForm">
        <input type="text" id="widgetUserInput" placeholder="Type a message or 'schedule pickup'..." autocomplete="off" required />
        <button type="submit" class="widget-send-btn" id="widgetSendBtn">
          <i class="fas fa-paper-plane"></i>
        </button>
      </form>
    </div>
  `;

  document.body.appendChild(root);

  const trigger = document.getElementById("sustainifyChatTrigger");
  const chatWindow = document.getElementById("sustainifyChatWindow");
  const closeBtn = document.getElementById("widgetCloseBtn");
  const form = document.getElementById("widgetChatForm");
  const input = document.getElementById("widgetUserInput");
  const messages = document.getElementById("widgetMessages");
  const sendBtn = document.getElementById("widgetSendBtn");

  // No client-side history — server manages it via session

  function toggleChat() {
    chatWindow.classList.toggle("open");
    if (chatWindow.classList.contains("open")) {
      setTimeout(() => input.focus(), 200);
    }
  }

  trigger.addEventListener("click", toggleChat);
  closeBtn.addEventListener("click", toggleChat);

  function scrollWidget() {
    messages.scrollTop = messages.scrollHeight;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function appendWidgetMsg(role, text, bookingData, draftReady) {
    const msg = document.createElement("div");
    msg.className = "widget-msg " + role;

    let content = escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
      .replace(/\n/g, "<br>");

    // Show booking confirmation card only when server validates the draft
    if (draftReady && bookingData) {
      const bId = "wb-" + Date.now();
      content += `
        <div class="widget-booking-card" id="${bId}">
          <div><b>📅 Date:</b> ${escapeHtml(bookingData.date || 'TBD')}</div>
          <div><b>⏰ Time:</b> ${escapeHtml(bookingData.time || 'Morning')}</div>
          <div><b>📍 Address:</b> ${escapeHtml(bookingData.address || '')} (${escapeHtml(bookingData.pincode || '')})</div>
          <div><b>⚖️ Weight:</b> ${escapeHtml(bookingData.weight || '5-10 kg')}</div>
          <button class="widget-booking-btn" id="btn-${bId}">
            Confirm & Book Pickup
          </button>
        </div>
      `;
      setTimeout(() => {
        const btn = document.getElementById(`btn-${bId}`);
        if (btn) {
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "Booking...";
            try {
              // No booking data sent — server uses session draft (HITL gate)
              const res = await fetch("/api/assistant/confirm-booking", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              });
              const data = await res.json();
              if (data.success) {
                document.getElementById(bId).innerHTML = `
                  <div style="color: #065f46; font-weight: bold; text-align: center;">
                    🎉 Pickup Scheduled! (ID: ${data.pickupId})<br>
                    <a href="/ScheduledPickups" style="color: #047857; text-decoration: underline;">View Pickups &rarr;</a>
                  </div>
                `;
              } else {
                btn.disabled = false;
                btn.textContent = "Retry Booking";
              }
            } catch (e) {
              btn.disabled = false;
              btn.textContent = "Error - Retry";
            }
          });
        }
      }, 50);
    }

    msg.innerHTML = `<div class="widget-bubble"><p>${content}</p></div>`;
    messages.appendChild(msg);
    scrollWidget();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    input.value = "";
    appendWidgetMsg("user", query);

    sendBtn.disabled = true;

    try {
      // Send only the message — server manages history
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: query }),
      });
      const data = await res.json();
      sendBtn.disabled = false;

      if (!res.ok || data.error) {
        appendWidgetMsg("bot", "⚠️ " + (data.error || "Something went wrong."));
        return;
      }

      appendWidgetMsg("bot", data.reply, data.bookingData, data.draftReady);
    } catch (err) {
      sendBtn.disabled = false;
      appendWidgetMsg("bot", "⚠️ Network error connecting to EcoBot.");
    }
  });
})();
