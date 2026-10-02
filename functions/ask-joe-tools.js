'use strict';
/**
 * ask-joe-tools.js — the tools Ask Joe may call (Jo, 2026-10-02: "Ask Joe
 * that does things, not just answers" — idea #1 from the GameForce review).
 *
 * The tool LIST lives here, server-side, and claudeProxy attaches it by name
 * (`toolset: 'joe-actions-v1'`). A browser can pick a toolset; it can never
 * send its own tool definitions. The tools RUN in the CRM page
 * (docs/pro/js/ask-joe-actions.js) as the signed-in user, through the same
 * functions and Firestore rules as tapping the buttons yourself:
 *
 *   read   find_customer, get_schedule        → run at once, results go back
 *   action send_text, add_reminder, move_stage → a confirm card first; nothing
 *          is sent or changed until the user taps Confirm
 *
 * Bulk sends (texting a list) are deliberately NOT here yet: they need the
 * consent gate (tcpaConsent / STOP register / quiet hours) first.
 */

const STAGE_HINT = 'Pipeline stage key, e.g. new, contacted, inspected, estimate_sent_cash, negotiating, contract_signed, job_created, materials_ordered, crew_scheduled, install_complete, final_payment, closed, lost. The page checks it against the real pipeline.';

const JOE_ACTIONS_V1 = [
  {
    name: 'find_customer',
    description: 'Look up customers/leads in the CRM by name, address, phone or customer number. ALWAYS use this to get a lead_id before any action — never guess an id. Returns up to 5 matches with lead_id, name, address, stage and whether a phone is on file.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name, street, phone digits or NBD-#### customer number.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_schedule',
    description: 'What is on the schedule for one day: appointments, scheduled jobs, adjuster meetings and calendar events. Date in YYYY-MM-DD (resolve "today"/"tomorrow"/"Friday" yourself from the current date given in the system prompt).',
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
    },
  },
  {
    name: 'send_text',
    description: 'Text ONE customer from the business line. The user sees the exact message and must tap Confirm before it sends (they can edit it). Opted-out numbers are refused by the server. Keep it short, friendly, signed as Joe. Never promise to handle or negotiate an insurance claim.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'From find_customer.' },
        message: { type: 'string', description: 'The text message, under 320 characters.' },
      },
      required: ['lead_id', 'message'],
    },
  },
  {
    name: 'add_reminder',
    description: 'Add a reminder/task on a customer, due on a date. The user confirms first.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'From find_customer.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        note: { type: 'string', description: 'What to do, e.g. "Call Bob about the gutter quote".' },
      },
      required: ['lead_id', 'due_date', 'note'],
    },
  },
  {
    name: 'add_note',
    description: 'Write a note on a customer\'s card (what happened, what they said, what to remember). The user confirms first. Nothing is sent to the customer.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'From find_customer.' },
        text: { type: 'string', description: 'The note, in plain words.' },
      },
      required: ['lead_id', 'text'],
    },
  },
  {
    name: 'agent_inbox_summary',
    description: 'What the bot team (Chief of Staff, Marcus, Quinn…) has filed in the Agent inbox and is still waiting on Jo: counts by bot and kind, plus the newest few. Read-only.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'move_stage',
    description: 'Move a customer to a different pipeline stage. The user confirms first and can undo it afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'From find_customer.' },
        stage: { type: 'string', description: STAGE_HINT },
      },
      required: ['lead_id', 'stage'],
    },
  },
];

const TOOLSETS = Object.freeze({ 'joe-actions-v1': Object.freeze(JOE_ACTIONS_V1) });

/** The tool list for a toolset name, or null for an unknown / absent name. */
function toolsFor(name) {
  return (typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOLSETS, name)) ? TOOLSETS[name] : null;
}

module.exports = { TOOLSETS, toolsFor };
