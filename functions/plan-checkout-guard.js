'use strict';

/**
 * Is this completed Checkout Session a real NBD Pro plan purchase?
 *
 * stripeWebhook's checkout.session.completed case writes subscriptions/{id}
 * and sets plan claims for session.client_reference_id. Stripe lets ANYONE
 * set client_reference_id on a Payment Link by URL (?client_reference_id=…),
 * and every tenant invoice link lives on the platform account, so without
 * this check paying a $1 invoice link with someone else's company id wrote
 * an "active" Starter plan onto that company (wiping its real Stripe ids).
 *
 * The only session that may grant a plan is the one createCheckoutSession
 * mints: mode 'subscription', a subscription id, and server-set
 * metadata.companyId equal to client_reference_id.
 *
 * @returns {string} '' when the session may grant a plan, else the reason.
 */
function planCheckoutRefusal(session) {
  const s = session || {};
  const ref = typeof s.client_reference_id === 'string' ? s.client_reference_id : '';
  if (!ref) return 'no_client_reference_id';
  if (s.mode !== 'subscription') return 'not_subscription_mode';
  if (!s.subscription) return 'no_subscription';
  const meta = (s.metadata && typeof s.metadata === 'object') ? s.metadata : {};
  if (meta.companyId !== ref) return 'company_mismatch';
  return '';
}

module.exports = { planCheckoutRefusal };
