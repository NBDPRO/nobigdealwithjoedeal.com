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

    // Server proxy ONLY (2026-10-04). claudeProxy (window.callClaude from
    // claude-proxy.js) holds the Anthropic key on the server, checks the plan
    // and the daily budget, and counts the spend. The old fallback read a
    // personal sk-ant key from sessionStorage and called api.anthropic.com
    // from the browser (anthropic-dangerous-allow-browser) — removed, along
    // with every read of that stored key.
    if (typeof window.callClaude !== 'function') {
      typingDiv.remove();
      addMessage('Joe AI is not available right now — refresh the page and try again.', 'ai');
      sendBtn.disabled = false;
      return;
    }
    const data = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: _systemPrompt,
      feature: 'ask-joe-page',
      messages: [{ role: 'user', content: message }]
    });

    // Remove typing indicator
    typingDiv.remove();

    // Add AI response
    // The answer's text blocks (never assume content[0] is text).
    const _rt = (Array.isArray(data && data.content) ? data.content : []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('').trim();
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
