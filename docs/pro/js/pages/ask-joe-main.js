const messagesDiv = document.getElementById('messages');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');

// Auto-resize textarea
userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = this.scrollHeight + 'px';
});

// Send on Enter (Shift+Enter for new line)
userInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const message = userInput.value.trim();
  if (!message) return;
  
  // Clear input
  userInput.value = '';
  userInput.style.height = 'auto';
  
  // Remove welcome message if present
  const welcome = messagesDiv.querySelector('.welcome');
  if (welcome) welcome.remove();
  
  // Add user message
  addMessage(message, 'user');
  
  // Show typing indicator
  const typingDiv = addTypingIndicator();
  
  // Disable send button
  sendBtn.disabled = true;
  
  try {
    // Ground rules come from js/ask-joe-rules.js — the same ones the CRM's Ask
    // Joe uses (2026-10-02). This page used to say Joe knew "adjuster
    // negotiations", which is illegal in Kentucky and public adjusting in Ohio.
    const _rules = (window.NBDAskJoeRules && window.NBDAskJoeRules.text()) ||
      '- The insurance claim belongs to the homeowner. Never coach negotiating the claim, an assignment of benefits, a waived deductible, or "we handle your claim". In Kentucky insurance jobs nothing is due at signing (KRS 367.626).';
    const _systemPrompt = 'You are Joe Deal, owner of No Big Deal Home Solutions in Greater Cincinnati — a battle-tested restoration contractor with 7+ years of experience. You help with roofing, siding, gutters, documenting storm damage, Xactimate estimates and supplements, meeting adjusters on the roof, and contractor business strategy. You are direct, actionable, and field-tested. You never recommend dishonest practices. Keep responses concise and practical.\n\nGROUND RULES (non-negotiable):\n' + _rules;

    let data;

    // Prefer the server-side Cloud Function proxy (window.callClaude
    // from claude-proxy.js). It holds the Anthropic key on the server
    // and avoids exposing `x-api-key` to any third-party script that
    // might be running on this page (analytics, sentry, etc.).
    if (typeof window.callClaude === 'function') {
      data = await window.callClaude({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: _systemPrompt,
        messages: [{ role: 'user', content: message }]
      });
    } else {
      // Fallback path — direct Anthropic call. Read the key from
      // sessionStorage (PR #28 migrated dashboard settings to this
      // store; the legacy localStorage value is migrated once and
      // wiped to narrow the XSS exfil window).
      let _apiKey = '';
      try {
        _apiKey = sessionStorage.getItem('nbd_joe_key') || '';
        if (!_apiKey) {
          const legacy = localStorage.getItem('nbd_joe_key');
          if (legacy) {
            sessionStorage.setItem('nbd_joe_key', legacy);
            localStorage.removeItem('nbd_joe_key');
            _apiKey = legacy;
          }
        }
      } catch (_) {}

      if (!_apiKey || !_apiKey.startsWith('sk-ant')) {
        typingDiv.remove();
        addMessage('⚙️ To use Joe AI, add your Anthropic API key in the CRM Dashboard → Settings → Ask Joe AI tab. Get a free key at console.anthropic.com.', 'ai');
        sendBtn.disabled = false;
        return;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-allow-browser': 'true',
          'x-api-key': _apiKey
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: _systemPrompt,
          messages: [{ role: 'user', content: message }]
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: { message: 'API error' } }));
        throw new Error(err?.error?.message || `HTTP ${response.status}`);
      }
      data = await response.json();
    }

    // Remove typing indicator
    typingDiv.remove();

    // Add AI response
    const _rt = data?.content?.[0]?.text;
    if (_rt) {
      addMessage(_rt, 'ai');
    } else {
      addMessage('Sorry, I encountered an error. Please try again.', 'ai');
    }

  } catch (error) {
    console.error('Error:', error);
    typingDiv.remove();
    addMessage('Oops! Something went wrong. Please try again.', 'ai');
  }
  
  // Re-enable send button
  sendBtn.disabled = false;
  userInput.focus();
}

function addMessage(text, type) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;
  
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = type === 'user' ? 'U' : '🤖';
  
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  
  messageDiv.appendChild(avatar);
  messageDiv.appendChild(bubble);
  messagesDiv.appendChild(messageDiv);
  
  // Scroll to bottom
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  return messageDiv;
}

function addTypingIndicator() {
  const typingDiv = document.createElement('div');
  typingDiv.className = 'message ai';
  typingDiv.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <div class="typing active">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  messagesDiv.appendChild(typingDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return typingDiv;
}

// Expose for onclick
window.sendMessage = sendMessage;
