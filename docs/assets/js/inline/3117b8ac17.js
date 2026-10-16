/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 3117b8ac17.  Do not edit by hand. */
// Leads save through submitPublicLead into guide_leads; onGuideLeadCreated
        // (functions/pro-prospects.js) alerts Jo. The old MailerLite stub
        // (FORM_ACTION_URL placeholder) was removed 2026-10-16: it never pointed anywhere.

        // Mobile menu toggle
        function toggleMobileNav() {
            const mobileNav = document.getElementById('mobileNav');
            mobileNav.classList.toggle('open');
        }

        // Close mobile nav when a link is clicked
        document.querySelectorAll('.mobile-nav a').forEach(link => {
            link.addEventListener('click', () => {
                document.getElementById('mobileNav').classList.remove('open');
            });
        });

        // Inline error — never leave the user thinking it worked when the lead
        // didn't actually save (server rejected it, or the network failed).
        function showFormError(form) {
            let p = form.querySelector('.nbd-form-error');
            if (!p) {
                p = document.createElement('p');
                p.className = 'nbd-form-error';
                p.setAttribute('role', 'alert');
                p.style.cssText = 'margin-top:12px;padding:12px 14px;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.35);border-radius:8px;color:#7f1d1d;font-size:.9rem;line-height:1.4';
                form.appendChild(p);
            }
            p.textContent = "Hmm — that didn't save. Please call or text Joe at (859) 420-7382 and he'll get your guide right to you.";
        }

        // Form submission handler
        function setupFormHandler(formId, successStateId) {
            const form = document.getElementById(formId);
            const successState = document.getElementById(successStateId);

            if (!form) return;

            form.addEventListener('submit', async (e) => {
                e.preventDefault();

                // Honeypot check (nbd_hp since 2026-08-05 — "website" gets autofilled)
                const hp = form.querySelector('input[name="nbd_hp"]');
                if (hp && hp.value) { console.warn('Bot detected'); return; }

                // Get form data
                const nameInput = form.querySelector('input[name="name"]');
                const emailInput = form.querySelector('input[name="email"]');
                const consentInput = form.querySelector('input[name="emailConsent"]');

                const formData = {
                    name: nameInput.value.trim(),
                    email: emailInput.value.trim(),
                    // Optional "also email me tips" box. Unticked = the guide only.
                    emailConsent: !!(consentInput && consentInput.checked)
                };

                try {
                    // Capture via the hardened submitPublicLead pipeline.
                    // _captureGuideLeads returns the result object; a non-ok
                    // result (rate limit, validation, Turnstile/App Check) must
                    // NOT be reported to the user as success.
                    let res = { ok: true };
                    if (window._captureGuideLeads) {
                        res = await window._captureGuideLeads(formData.name, formData.email, formData.emailConsent);
                    }
                    if (!res || !res.ok) { showFormError(form); return; }

                    // Show success state
                    form.style.display = 'none';
                    successState.classList.add('active');

                    // Reset form after 2 seconds
                    setTimeout(() => {
                        form.reset();
                    }, 2000);

                } catch (error) {
                    // Network/JS error — surface it instead of faking success.
                    console.error('Form submission error:', error);
                    showFormError(form);
                }
            });
        }

        // Setup both forms
        setupFormHandler('optinForm', 'successState');
        setupFormHandler('optinForm2', 'successState2');
