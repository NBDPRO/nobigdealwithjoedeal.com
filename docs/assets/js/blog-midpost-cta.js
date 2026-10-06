// blog-midpost-cta.js
// Injects a mobile-only CTA block after the 2nd <h2> of any blog post's .prose body.
// Desktop (>=992px) keeps using the existing .cta-sidebar; this file is a no-op there.
(function(){
  function inject(){
    if (window.matchMedia('(min-width: 992px)').matches) return;
    var prose = document.querySelector('article.prose, .prose, .blog-post-body');
    if (!prose) return;
    if (prose.querySelector('.blog-midpost-cta')) return; // already injected
    var h2s = prose.querySelectorAll('h2');
    if (h2s.length < 2) return;
    var anchor = h2s[1]; // after the 2nd h2
    var cta = document.createElement('aside');
    cta.className = 'blog-midpost-cta';
    cta.setAttribute('aria-label','Talk to Joe');
    cta.innerHTML =
      '<div class="bmc-eyebrow">Got a question?</div>'+
      '<h3>Joe answers his own phone.</h3>'+
      '<p>No call center, no gatekeeper. If you want a straight answer about your roof, text or call.</p>'+
      '<div class="bmc-actions">'+
        '<a href="tel:8594207382" class="bmc-btn bmc-btn-primary">📞 (859) 420-7382</a>'+
        '<a href="/estimate" class="bmc-btn bmc-btn-secondary">Get a Free Estimate →</a>'+
      '</div>';
    // Find where this h2 sits inside prose, insert the CTA after the NEXT <p> so it feels mid-thought
    var insertAfter = anchor;
    var probe = anchor.nextElementSibling;
    var hops = 0;
    while (probe && hops < 3){
      if (probe.tagName === 'P'){ insertAfter = probe; break; }
      probe = probe.nextElementSibling; hops++;
    }
    insertAfter.parentNode.insertBefore(cta, insertAfter.nextSibling);
  }
  function enhanceByline(){
    var box = document.querySelector('.author-box');
    if (!box) return;
    if (box.querySelector('.author-credentials')) return;
    var info = box.querySelector('.author-info');
    if (!info) return;
    var row = document.createElement('div');
    row.className = 'author-credentials';
    row.innerHTML =
      '<span class="author-cred">GAF Certified&trade; Contractor</span>'+
      '<span class="author-cred">Fully Insured</span>'+
      '<span class="author-cred">Goshen / Greater Cincinnati</span>';
    info.appendChild(row);
  }
  function go(){ inject(); enhanceByline(); }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', go);
  } else {
    go();
  }
})();
