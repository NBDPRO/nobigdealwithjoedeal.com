/**
 * roof-rep-rules.js — the pure half of the 2026-10-25 Roof Rep revamp (gameplay depth + NBD playbook content).
 *
 * Loaded before roof-rep.js; also required by tests/roof-rep-revamp-2026-10-25.test.js. No DOM, no storage.
 *
 * - OBJECTIONS: what homeowners push back with at the pitch, and the lines a rep can answer with. One `best` answer per
 *   objection (the NBD way), an `ok` one, a `weak` one, and on the Kentucky-rule objections a `trap` that is dirty and loses
 *   the door. Traps never win: the test breaks if one ever does.
 * - Quests: three daily quests picked from the challenge pool (deterministic per day), and one weekly quest.
 * - Storm Run: the 60-second objection gauntlet's scoring.
 * - Seasons: 28 days; a rank from the XP earned in the season.
 * - Crew ranks: "#n this week · #m all time" from the crew-board rows, and a duel between two reps' week XP.
 */
(function (root) {
  'use strict';

  var SEASON_LEN = 28;

  // Kentucky rules the whole game teaches: the homeowner owns the claim; no deductible games; no money up front; no AOB;
  // never sign a check over; pull the permit; only real damage goes on a scope.
  var OBJECTIONS = [
    { k: 'price', text: "That's a lot more than I expected.", answers: [
      { kind: 'best', say: "Fair. Let me show you what's in the number: tear-off, ice-and-water at the eaves, drip edge, new boots and flashing, the permit, and the warranty in writing. You can compare it line by line.", trust: 15, tip: { good: true, text: 'Price objections want the breakdown, not a discount.' } },
      { kind: 'ok', say: "The Good option gets you a sound roof for less. Want me to price that too?", trust: 5 },
      { kind: 'weak', say: "I can knock 10% off if you sign today.", trust: -10, tip: { bad: true, text: 'A sudden discount tells them the first number was padded.' } },
    ] },
    { k: 'think', text: "I need to think about it.", answers: [
      { kind: 'best', say: "Of course. What would you want to know to feel good about a decision? I'd rather answer it now than leave you guessing.", trust: 12, tip: { good: true, text: '"Think about it" usually hides one question. Ask for it.' } },
      { kind: 'ok', say: "No problem. Here's the estimate and my card. I'll check back tomorrow.", trust: 4 },
      { kind: 'weak', say: "Prices go up Monday, so today's the day.", trust: -12, tip: { bad: true, text: 'Fake deadlines are what the storm chasers use.' } },
    ] },
    { k: 'quotes', text: "I'm getting three quotes. The last guy was cheaper.", answers: [
      { kind: 'best', say: "Smart. Put the three side by side: same shingle, ice-and-water, drip edge, permit, workmanship warranty in writing. Cheaper usually means something's missing.", trust: 15, tip: { good: true, text: 'Help them compare properly and the cheap quote falls apart on its own.' } },
      { kind: 'ok', say: "Totally fair. Call me when you have the other two and I'll go through them with you.", trust: 5 },
      { kind: 'trap', say: "I'll beat anyone by $500 and cover your deductible on top.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Covering a deductible is insurance fraud in Kentucky. That line ends the conversation, and should.' } },
    ] },
    { k: 'insurance', text: "My insurance will handle it. I don't need you.", answers: [
      { kind: 'best', say: "Insurance pays for the roof; you still choose who builds it. You file the claim, I'll be at the adjuster meeting with the photos so nothing gets missed.", trust: 15, tip: { good: true, text: 'The homeowner files. You bring the evidence.' } },
      { kind: 'ok', say: "Sure. When the adjuster comes out, call me and I'll meet them on the roof.", trust: 6 },
      { kind: 'trap', say: "Sign this and I'll deal with your insurance company for you, start to finish.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'An assignment of benefits or "I\'ll handle your claim" is the line a Kentucky contractor can never say.' } },
    ] },
    { k: 'nephew', text: "My nephew does roofs on the side. He'll do it for half.", answers: [
      { kind: 'best', say: "Family's great. Ask him three things: who pulls the permit, what his insurance covers if someone gets hurt on your roof, and what the warranty says in writing.", trust: 12, tip: { good: true, text: 'Three honest questions beat any dig at the nephew.' } },
      { kind: 'ok', say: "Understood. If it ever leaks, I'm a phone call away.", trust: 3 },
      { kind: 'weak', say: "Side jobs are how roofs end up in the news.", trust: -10, tip: { bad: true, text: 'You just insulted their family.' } },
    ] },
    { k: 'spring', text: "I'll wait till spring and see.", answers: [
      { kind: 'best', say: "That's your call. Two things to know: open hail hits let water into the decking all winter, and most claims have a filing window. Let's at least get it documented today.", trust: 12, tip: { good: true, text: 'Give the real reasons, then leave the decision with them.' } },
      { kind: 'ok', say: "Sure. I'll leave the photos with you so you have them.", trust: 4 },
      { kind: 'weak', say: "By spring the whole thing'll cave in.", trust: -12, tip: { bad: true, text: 'Scare lines cost trust, and this one isn\'t true.' } },
    ] },
    { k: 'spouse', text: "I have to ask my wife first.", answers: [
      { kind: 'best', say: "Absolutely. When are you both home? I'll come back with the photos and walk you both through it together.", trust: 12, tip: { good: true, text: 'Book the time with both decision makers.' } },
      { kind: 'ok', say: "Of course. Here's everything in writing to share with her.", trust: 5 },
      { kind: 'weak', say: "She'll be glad you took care of it. Let's get it signed.", trust: -15, tip: { bad: true, text: 'Going around a spouse loses the house, and the referral.' } },
    ] },
    { k: 'deductible', text: "The other company said they'd eat my deductible.", answers: [
      { kind: 'best', say: "In Kentucky that's illegal for them to offer and risky for you to accept; it's insurance fraud, and you're the policyholder. The deductible is yours. I'll make everything else as clean as it can be.", trust: 15, tip: { good: true, text: 'Say the rule plainly. Honest homeowners respect it.' } },
      { kind: 'ok', say: "I can't do that. I can make sure the scope has everything it should.", trust: 5 },
      { kind: 'trap', say: "We can do that too. Just between us.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Waiving a deductible is fraud, and now you\'ve said it out loud.' } },
    ] },
    { k: 'dents', text: "It's a few dents. The roof still works.", answers: [
      { kind: 'best', say: "It does, today. A hail hit knocks the granules off, and that spot ages years in one summer. Look at this photo: see the bruise? That's where it'll leak first.", trust: 12, tip: { good: true, text: 'Teach with the photo. One real bruise beats a lecture.' } },
      { kind: 'ok', say: "Could be. Want me to check again after the next storm?", trust: 3 },
      { kind: 'weak', say: "Trust me, it's shot.", trust: -8, tip: { bad: true, text: '"Trust me" is the opposite of proof.' } },
    ] },
    { k: 'cash', text: "How much do you need from me today?", answers: [
      { kind: 'best', say: "Nothing today. The deposit is in the contract and comes when materials are ordered, by card or check, never cash at the door.", trust: 15, tip: { good: true, text: 'No money up front at the door. Ever.' } },
      { kind: 'ok', say: "Nothing until we're scheduled. The contract spells it out.", trust: 6 },
      { kind: 'trap', say: "Half now in cash and you jump the line.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Cash at the door is how homeowners get robbed, and how reps get fired.' } },
    ] },
    { k: 'permit', text: "Do we really need a permit? The last guy skipped it.", answers: [
      { kind: 'best', say: "Yes. I pull it, and the city inspection is for you: it proves the job was done right when you sell the house.", trust: 12, tip: { good: true, text: 'The permit protects the homeowner. Say so.' } },
      { kind: 'ok', say: "We always pull the permit. It's included.", trust: 5 },
      { kind: 'trap', say: "We can skip it and save you the fee.", trust: -25, dirty: true, lose: true, tip: { bad: true, text: 'Skipping the permit is the trap. It voids warranties and insurance.' } },
    ] },
    { k: 'check', text: "Insurance already sent me a check. Can I just sign it over to you?", answers: [
      { kind: 'best', say: "Please don't sign a check over to anyone. Deposit it, and pay per the contract as the work gets done.", trust: 15, tip: { good: true, text: 'Never take a signed-over insurance check.' } },
      { kind: 'ok', say: "Hold onto it. We'll invoice you as the job moves.", trust: 6 },
      { kind: 'trap', say: "Sure, sign it over and we'll take care of everything.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'A contractor holding the insurance check is the setup for every roofing scam story.' } },
    ] },
    { k: 'warranty', text: "What happens if it leaks in three years?", answers: [
      { kind: 'best', say: "You call me and I fix it. The workmanship warranty is in writing on the estimate, and the shingle's manufacturer warranty is on top of it.", trust: 12, tip: { good: true, text: 'Specifics, in writing.' } },
      { kind: 'ok', say: "It's warrantied. The details are on page two.", trust: 4 },
      { kind: 'weak', say: "Lifetime warranty on everything, don't worry about it.", trust: -10, tip: { bad: true, text: 'Vague "lifetime" promises sound like the last guy.' } },
    ] },
    { k: 'mess', text: "How long is my house going to be a mess?", answers: [
      { kind: 'best', say: "One day for most roofs. The dumpster goes in the driveway, tarps cover the beds, and we run a magnet over the yard before we leave.", trust: 12, tip: { good: true, text: 'Answer the day-of worries before they ask twice.' } },
      { kind: 'ok', say: "A day, maybe two. We clean up when we're done.", trust: 4 },
      { kind: 'weak', say: "Construction's messy. That's just how it is.", trust: -8 },
    ] },
    { k: 'unknown', text: "I've never heard of you.", answers: [
      { kind: 'best', say: "We're local. Here's our address, the reviews, and two neighbors you can call. The truck will be on this street for the next month.", trust: 12, tip: { good: true, text: 'Local proof: address, reviews, neighbors.' } },
      { kind: 'ok', say: "Fair. Look us up tonight and I'll come back tomorrow.", trust: 4 },
      { kind: 'weak', say: "We're the biggest in the state.", trust: -8, tip: { bad: true, text: 'A claim they can\'t check is worth nothing.' } },
    ] },
    { k: 'chaser', text: "Are you one of those storm chasers?", answers: [
      { kind: 'best', say: "No. I live twenty minutes from here, and I'll be here next year when a warranty means something. Chasers leave when the storm does.", trust: 14, tip: { good: true, text: 'Local and still-here is the whole answer.' } },
      { kind: 'ok', say: "No, we're local. Here's my card.", trust: 5 },
      { kind: 'weak', say: "Everybody's a storm chaser after a storm.", trust: -10 },
    ] },
    { k: 'pad', text: "Can you add my old gutters to the claim so insurance covers them?", answers: [
      { kind: 'best', say: "Only damage from the storm goes on the claim. If the hail hit the gutters I'll document it; if it didn't, I'll price them separately and honestly.", trust: 15, tip: { good: true, text: 'Padding a scope is fraud. Document what is there.' } },
      { kind: 'ok', say: "I can only put what's damaged on the claim.", trust: 6 },
      { kind: 'trap', say: "Sure, we'll pad the scope a little. Everybody does.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Padding a supplement is insurance fraud. Game over at this door.' } },
    ] },
    { k: 'recent', text: "My roof was replaced five years ago. It can't be bad already.", answers: [
      { kind: 'best', say: "Age isn't the question after hail; impact is. A five-year-old roof can take hits a twenty-year-old one shrugs off, and it's still under warranty, which matters. Let me look and show you either way.", trust: 12, tip: { good: true, text: 'Hail damage is about impact, not age. Say it kindly and offer proof.' } },
      { kind: 'ok', say: "Probably fine then. Want me to check anyway while I'm here?", trust: 4 },
      { kind: 'weak', say: "Five years is old for the cheap stuff builders use.", trust: -8, tip: { bad: true, text: 'You just insulted the roof they paid for.' } },
    ] },
    { k: 'adjusterNo', text: "The adjuster already came out and said there's no damage.", answers: [
      { kind: 'best', say: "Then let's get you the photos I take, with a chalk circle on every hit, and you can ask for a re-inspection. Adjusters look at a lot of roofs fast; a second look with evidence is normal.", trust: 14, tip: { good: true, text: 'A denial is a bad first look, not a verdict. The homeowner asks for the re-inspection, you supply the proof.' } },
      { kind: 'ok', say: "That happens. If you want a second opinion, I'll document what I find.", trust: 5 },
      { kind: 'trap', say: "Adjusters always say that. I'll call your carrier and get it overturned.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'You can\'t work the claim for them. Only the policyholder, or a licensed public adjuster, can.' } },
    ] },
    { k: 'rates', text: "If I file a claim my rates will go up. I'd rather not.", answers: [
      { kind: 'best', say: "That's a fair worry. A storm claim is an act-of-God claim; carriers can't single you out for it in Kentucky, though rates move with the whole area after a big storm. Ask your agent before you decide; I'll give you the photos either way.", trust: 12, tip: { good: true, text: 'Answer honestly and send them to their agent. Never promise what rates will do.' } },
      { kind: 'ok', say: "Ask your agent; it's their call to explain. I'll leave the photos with you.", trust: 5 },
      { kind: 'trap', say: "Just don't mention it was hail. Call it wear and tear and the rate won't move.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Coaching a homeowner to misstate a claim is fraud.' } },
    ] },
    { k: 'patch', text: "Can't you just patch the bad spots?", answers: [
      { kind: 'best', say: "If it's a few spots, yes, and I'll tell you that. If the hail hit the whole slope, a patch leaves the rest of it leaking next year. Let me see which one you've got.", trust: 12, tip: { good: true, text: 'Say yes when a repair is the honest answer. The game pays for honest calls.' } },
      { kind: 'ok', say: "Sometimes. Let me look first.", trust: 4 },
      { kind: 'weak', say: "Nobody patches hail. It's a full roof or nothing.", trust: -10, tip: { bad: true, text: 'That is a sales line, not a diagnosis.' } },
    ] },
    { k: 'selling', text: "We're selling the house next spring. Why would I put a roof on it?", answers: [
      { kind: 'best', say: "Because the buyer's inspector will find the hail before you do, and a known roof problem comes off the price twice over. A new roof with a transferable warranty sells a house.", trust: 12, tip: { good: true, text: 'Sellers think in resale. Talk inspection and transferable warranty.' } },
      { kind: 'ok', say: "Fair. Want the photos so you know what the inspector will see?", trust: 5 },
      { kind: 'weak', say: "Then it's the buyer's problem.", trust: -10, tip: { bad: true, text: 'Disclosure law says otherwise, and so does decency.' } },
    ] },
    { k: 'match', text: "Can you match this other quote? It's $2,000 less.", answers: [
      { kind: 'best', say: "Let me see it. If it's the same shingle, same underlayment, ice-and-water, drip edge, permit and the warranty in writing, I'll explain my number line by line. If something's missing, you'll see why it's cheaper.", trust: 12, tip: { good: true, text: 'Compare scopes, not totals.' } },
      { kind: 'ok', say: "I can't match blind, but I'll price the same scope honestly.", trust: 5 },
      { kind: 'weak', say: "Sure, I'll match it. Where do I sign?", trust: -8, tip: { bad: true, text: 'Matching a number you haven\'t read means your first number was padded, or the match will cut corners.' } },
    ] },
    { k: 'financing', text: "I can't pay for a roof right now.", answers: [
      { kind: 'best', say: "If it's storm damage, insurance pays most of it and you cover the deductible. If it isn't, we have financing with a real monthly number, no pressure. Let's find out which first.", trust: 12, tip: { good: true, text: 'Separate the insurance question from the money question.' } },
      { kind: 'ok', say: "Understood. We do have payment plans if it ever helps.", trust: 4 },
      { kind: 'trap', say: "We'll just raise the insurance claim enough to cover your deductible too.", trust: -30, dirty: true, lose: true, tip: { bad: true, text: 'Inflating a claim to cover the deductible is fraud, twice.' } },
    ] },
    { k: 'solar', text: "I've got solar panels up there. Nobody wants to touch them.", answers: [
      { kind: 'best', say: "We do: the panels come off and go back on with the installer or a licensed electrician, and it's a line item on the estimate so there's no surprise.", trust: 12, tip: { good: true, text: 'Name the plan and put the panel work on the estimate.' } },
      { kind: 'ok', say: "We've worked around panels before. Let me look at the layout.", trust: 5 },
      { kind: 'weak', say: "We'll roof around them and it'll be fine.", trust: -10, tip: { bad: true, text: 'You can\'t replace shingles under a panel without moving it.' } },
    ] },
  ];

  // A small seeded shuffle (mulberry32) so a day's quests and a door's objections are the same on a reload.
  function seeded(seed) { var a = (seed >>> 0) || 1; return function () { a += 0x6D2B79F5; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function shuffleWith(list, rand) { var a = list.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /** n distinct quests from the pool (already filtered by availability), the same set for the same seed. */
  function pickQuests(pool, n, seed) {
    return shuffleWith(pool, seeded(seed)).slice(0, n).map(function (c) { return { k: c.k, need: c.need, text: c.text, done: false }; });
  }
  var WEEKLY = [
    { k: 'sign', need: 5, text: 'Sign 5 jobs this week', cash: 2000, xp: 150 },
    { k: 'insp', need: 10, text: 'Inspect 10 roofs this week', cash: 1200, xp: 120 },
    { k: 'knock', need: 30, text: 'Knock 30 doors this week', cash: 1000, xp: 120 },
    { k: 'honest', need: 3, text: 'Tell 3 homeowners their roof is fine', cash: 1500, xp: 150 },
    { k: 'clean', need: 5, text: '5 clean days this week', cash: 2500, xp: 200 },
  ];
  function weekFor(day) { return Math.ceil(Math.max(1, day) / 7); }
  function pickWeekly(day, seed) { var w = weekFor(day); return Object.assign({ week: w, done: false }, WEEKLY[(w - 1 + (seed || 0)) % WEEKLY.length]); }
  /** Two objections for a door: never the same one twice at that door, seeded by the house so a reload asks the same. */
  function pickObjections(n, seed, exclude) {
    var pool = OBJECTIONS.filter(function (o) { return !exclude || exclude.indexOf(o.k) < 0; });
    return shuffleWith(pool, seeded(seed)).slice(0, n);
  }
  function answersShuffled(objection, seed) { return shuffleWith(objection.answers, seeded(seed)); }

  /** Storm Run: 60 seconds, best answers score, traps strike, three strikes end it. */
  var RUN = { seconds: 60, strikes: 3, perBest: 12, perOk: 4, perfectBonus: 80 };
  function runScore(r) {
    var xp = r.best * RUN.perBest + r.ok * RUN.perOk + (r.best >= 8 && !r.weak && !r.trap ? RUN.perfectBonus : 0);
    var grade = r.trap >= RUN.strikes ? 'Struck out' : r.best >= 8 && !r.weak && !r.trap ? 'Perfect run' : r.best >= 6 ? 'Strong run' : r.best >= 3 ? 'Decent run' : 'Rough run';
    return { xp: xp, grade: grade };
  }

  var SEASON_RANKS = [[3000, 'Storm Legend'], [2000, 'Roof Boss'], [1200, 'Closer'], [600, 'Estimator'], [250, 'Door Knocker'], [0, 'Rookie']];
  function seasonOf(day) { return Math.ceil(Math.max(1, day) / SEASON_LEN); }
  function seasonEndsOn(day) { return day % SEASON_LEN === 0; }
  function seasonRank(seasonXp) { for (var i = 0; i < SEASON_RANKS.length; i++) if (seasonXp >= SEASON_RANKS[i][0]) return SEASON_RANKS[i][1]; return 'Rookie'; }

  /** rows: crew-board rows ({id, xp, weekXp, weekKey}); returns my 1-based ranks. */
  function crewRanks(rows, uid, weekKey) {
    var wk = rows.slice().sort(function (a, b) { return (b.weekKey === weekKey ? b.weekXp || 0 : 0) - (a.weekKey === weekKey ? a.weekXp || 0 : 0) || (b.xp || 0) - (a.xp || 0); });
    var all = rows.slice().sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); });
    var w = wk.findIndex(function (r) { return r.id === uid; }), a = all.findIndex(function (r) { return r.id === uid; });
    return { week: w < 0 ? null : w + 1, all: a < 0 ? null : a + 1, of: rows.length };
  }
  function duelState(rows, uid, rivalId, weekKey) {
    var me = rows.filter(function (r) { return r.id === uid; })[0], them = rows.filter(function (r) { return r.id === rivalId; })[0];
    var mx = me && me.weekKey === weekKey ? me.weekXp || 0 : 0, tx = them && them.weekKey === weekKey ? them.weekXp || 0 : 0;
    return { me: mx, them: tx, name: (them && them.name) || 'A rep', lead: mx > tx ? 'me' : tx > mx ? 'them' : 'tie', gone: !them };
  }

  var api = { SEASON_LEN: SEASON_LEN, OBJECTIONS: OBJECTIONS, WEEKLY: WEEKLY, RUN: RUN, SEASON_RANKS: SEASON_RANKS, seeded: seeded, pickQuests: pickQuests, weekFor: weekFor, pickWeekly: pickWeekly, pickObjections: pickObjections, answersShuffled: answersShuffled, runScore: runScore, seasonOf: seasonOf, seasonEndsOn: seasonEndsOn, seasonRank: seasonRank, crewRanks: crewRanks, duelState: duelState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RoofRepRules = api;
})(typeof window !== 'undefined' ? window : null);
