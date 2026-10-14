/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 087ec489fd.  Do not edit by hand. */
// FAQ accordion
document.querySelectorAll('.faq-q').forEach(q => {
  q.addEventListener('click', () => {
    const item = q.parentElement;
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!wasOpen) item.classList.add('open');
  });
});
// Decision helper
(function(){
  const answers = {1:null, 2:null, 3:null};
  const recommendations = {
    Standard: { title: "I'd suggest Standard.", body: "You're not the buyer this house is built for in 20 years. Spend the savings somewhere else — landscaping, kitchen, vacation. The Standard tier is a real GAF Timberline NS roof with my NBD Pledge. That's enough." },
    Preferred: { title: "I'd suggest Preferred.", body: "The honest middle. Better shingle, premium pipe boots that won't fail at year 7, full GAF system install, and a warranty that transfers to the next owner if you sell. This is what I'd put on my own house if I weren't planning to die in it." },
    Elite: { title: "I'd suggest Elite.", body: "You want to be done thinking about the roof. Top-tier GAF UHDZ shingle, LumaNail visible fasteners so you can verify the install, contractual annual inspection in the paperwork, full GAF System Plus system install, and the NBD Pledge that follows the house through every sale. The roof you don't think about again." }
  };
  document.querySelectorAll('.decide-options button').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q, v = btn.dataset.v;
      answers[q] = v;
      btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      if (answers[1] && answers[2] && answers[3]) {
        let score = 0;
        if (answers[1] === 'short') score -= 2;
        if (answers[1] === 'medium') score += 0;
        if (answers[1] === 'long') score += 2;
        if (answers[2] === 'rental') score -= 2;
        if (answers[2] === 'market') score += 1;
        if (answers[2] === 'family') score += 2;
        if (answers[3] === 'ok') score -= 1;
        if (answers[3] === 'prefer') score += 1;
        if (answers[3] === 'never') score += 2;
        const tier = score <= -1 ? 'Standard' : score >= 4 ? 'Elite' : 'Preferred';
        const rec = recommendations[tier];
        document.getElementById('decideResultTitle').textContent = rec.title;
        document.getElementById('decideResultBody').textContent = rec.body;
        const result = document.getElementById('decideResult');
        result.classList.add('shown');
        setTimeout(() => result.scrollIntoView({behavior:'smooth', block:'center'}), 100);
      }
    });
  });
})();
// Announcement bar rotator
(function(){
  const slides = document.querySelectorAll('.ann-slide');
  let current = 0;
  if(slides.length < 2) return;
  setInterval(()=>{
    slides[current].classList.remove('active');
    slides[current].classList.add('exit');
    const prev = current;
    current = (current + 1) % slides.length;
    slides[current].classList.add('active');
    slides[current].classList.remove('exit');
    setTimeout(()=> slides[prev].classList.remove('exit'), 600);
  }, 4000);
})();
