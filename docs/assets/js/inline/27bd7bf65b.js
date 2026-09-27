/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 27bd7bf65b.  Do not edit by hand. */
/* ──────────────────────────────────────────────────────────────────────
 * VIZ_OPTIONS — SINGLE SOURCE OF TRUTH
 * Every option group below drives (1) the rendered UI on panel 2,
 * (2) the AI prompt's `selectionsText`, and (3) the canvas-fallback
 * color overlay. Adding/changing an option only requires editing here.
 * ──────────────────────────────────────────────────────────────────── */
const VIZ_OPTIONS = {
  features: [
    { id: 'roof',     label: '🏠 Roof' },
    { id: 'siding',   label: '🏡 Siding' },
    { id: 'gutters',  label: '🌧️ Gutters' },
    { id: 'windows',  label: '🪟 Windows' },
    { id: 'garage',   label: '🚗 Garage Door' },
    { id: 'shutters', label: '🪟 Shutters' },
    { id: 'doors',    label: '🚪 Front Door' },
  ],

  // GAF residential shingle product lines — the lineup Joe actually installs.
  // Joe doesn't sell 3-tab (not worth it). UHDZ is his Class 4 impact pick.
  // Camelot II is the one designer line carried — most widely stocked GAF
  // designer shingle through Beacon/ABC Supply in the Cincinnati region.
  //
  // Each line carries a `colorsRef` pointing at the per-line color palette
  // below. The visualizer only shows colors that the selected line is
  // actually manufactured in — so picking UHDZ no longer surfaces NS-only
  // colors like "Sunset Brick", and picking Camelot II shows the slate-look
  // designer palette instead of the architectural lineup.
  // Each line carries `mfr` (brand prefix for the palette header) and `group`
  // (the manufacturer dimension surfaced as a labeled group in the pill picker).
  // GAF is Joe's default lineup; TAMKO's impact-resistant shingles are the hail/impact lane.
  roofLines: [
    { id: 'timberline-ns',   label: 'Timberline NS',      desc: 'Natural Shadow · entry architectural',
      mfr: 'GAF', group: 'GAF', colorsRef: 'timberlineNsColors',
      ai: 'GAF Timberline Natural Shadow (NS) architectural laminated asphalt shingles' },
    { id: 'timberline-hdz',  label: 'Timberline HDZ',     desc: 'Architectural · most chosen',
      mfr: 'GAF', group: 'GAF', colorsRef: 'timberlineHdzColors',
      ai: 'GAF Timberline HDZ architectural laminated asphalt shingles' },
    { id: 'timberline-uhdz', label: 'Timberline UHDZ',    desc: 'Premium · Class 4 impact-rated',
      mfr: 'GAF', group: 'GAF', colorsRef: 'timberlineUhdzColors',
      ai: 'GAF Timberline UHDZ premium architectural shingles with Class 4 impact rating (UL 2218)' },
    { id: 'camelot-2',       label: 'Camelot II',         desc: 'Designer · slate-look luxury',
      mfr: 'GAF', group: 'GAF', colorsRef: 'camelot2Colors',
      ai: 'GAF Camelot II designer slate-look dimensional luxury asphalt shingles' },

    // TAMKO lines Joe installs for hail country (a brand he installs, NOT a
    // certification; TAMKO sells each as its own product — there is no 'series').
    // Heritage is the value architectural floor;
    // Titan XT carries 14 of the Titan XT colors TAMKO lists; StormFighter Flex
    // + HailGuard share the same 8-color storm palette (both → tamkoStormColors).
    { id: 'tamko-heritage',     label: 'Heritage',          desc: 'TAMKO · value architectural · 130 mph',
      mfr: 'TAMKO', group: 'TAMKO', colorsRef: 'tamkoHeritageColors',
      ai: 'TAMKO Heritage architectural laminated asphalt shingles with TriShield technology' },
    { id: 'tamko-titan-xt',     label: 'Titan XT',          desc: 'TAMKO · Class 3 impact · 160 mph',
      mfr: 'TAMKO', group: 'TAMKO', colorsRef: 'tamkoTitanColors',
      ai: 'TAMKO Titan XT premium architectural laminated asphalt shingles with Class 3 impact rating (UL 2218)' },
    { id: 'tamko-stormfighter', label: 'StormFighter Flex', desc: 'TAMKO · Class 4 impact · 160 mph',
      mfr: 'TAMKO', group: 'TAMKO', colorsRef: 'tamkoStormColors',
      ai: 'TAMKO StormFighter FLEX polymer-modified architectural asphalt shingles with Class 4 impact rating (UL 2218)' },
    { id: 'tamko-hailguard',    label: 'HailGuard',         desc: 'TAMKO · Class 4 · hail warranty',
      mfr: 'TAMKO', group: 'TAMKO', colorsRef: 'tamkoStormColors',
      ai: 'TAMKO HailGuard impact-resistant architectural asphalt shingles, UL 2218 Class 4 impact rated (tested beyond Class 4)' },

    { id: 'metal',           label: 'Standing-Seam Metal', desc: 'Premium metal panels',
      group: 'Metal', colorsRef: 'metalColors',
      ai: 'standing-seam metal roofing panels (NOT metal shingles — these are flat panels with raised seams)' },
  ],

  // ── PER-LINE GAF COLOR PALETTES ───────────────────────────────
  // Each entry carries:
  //   id    — slug used in URLs / state
  //   name  — exact GAF product name (verified against gaf.com Q1 2026)
  //   hex   — dominant tone, calibrated against GAF swatch imagery
  //   light — chip needs an extra inset border on white background
  //   blend — multi-tone GRANULE description that gets injected into the
  //           image-gen prompt. Real GAF shingles are never a flat color;
  //           every color is a 3–4 granule blend. Without this, FLUX
  //           Kontext renders shingles as a painted-looking single tone.
  //           Format: "<dominant tone> with <granule 1>, <granule 2>,
  //           and <accent>; <mood/character>". Keep it under ~30 words —
  //           any longer and FLUX over-weights the color over the texture.

  // Timberline NS — 8 colors (full national lineup; entry architectural).
  timberlineNsColors: [
    { id: 'arctic-white',       name: 'Arctic White',        hex: '#dad4c6', light: true,
      blend: 'pearl-white asphalt blend with subtle warm tan and soft gray granules; reads almost off-white with gentle dimensional shadow' },
    { id: 'barkwood',           name: 'Barkwood',            hex: '#4a3a2a',
      blend: 'deep warm brown with darker chocolate-mahogany granules and lighter reddish-tan flecks; warm wood-grain shadow' },
    { id: 'charcoal',           name: 'Charcoal',            hex: '#2c2c2c',
      blend: 'deep blackish-gray with charcoal granules, slate-gray flecks, and subtle warm-gray accents; classic clean black-roof look' },
    { id: 'hickory',            name: 'Hickory',             hex: '#5e4530',
      blend: 'warm reddish-brown with darker chocolate granules and lighter tan-gold flecks; rich nutshell tone' },
    { id: 'pewter-gray',        name: 'Pewter Gray',         hex: '#5e5e5e',
      blend: 'medium cool gray with darker slate granules and lighter silver-gray flecks; subtle blue undertone' },
    { id: 'shakewood',          name: 'Shakewood',           hex: '#7a6048',
      blend: 'warm tan-brown with golden granules, darker brown flecks, and bleached cedar accents; mimics weathered cedar shake' },
    { id: 'slate',              name: 'Slate',               hex: '#46484e',
      blend: 'deep cool gray-slate with darker charcoal granules and subtle blue-gray accents; tight tonal range' },
    { id: 'weathered-wood',     name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'warm gray-brown blend with tan granules, darker brown flecks, and silver-gray accents; reads like aged hardwood' },
  ],

  // Timberline HDZ — flagship architectural line.
  // 30 total colors across four GAF sub-collections:
  //   • High Definition       (9 nationwide)
  //   • Regional HD           (10 — availability varies; included because
  //     the visualizer is browsable beyond Joe's immediate stocking zone
  //     and Beacon/ABC will special-order)
  //   • American Harvest      (7 — being phased out in favor of Bold
  //     Definition but still stocked at most distributors through 2026)
  //   • Bold Definition       (4 — launched Jan 2026; GAF's contrast-
  //     focused replacement for American Harvest)
  timberlineHdzColors: [
    // ── High Definition (nationwide) ──
    { id: 'barkwood',           name: 'Barkwood',            hex: '#4a3a2a',
      blend: 'deep warm brown with darker chocolate-mahogany granules and lighter reddish-tan flecks; HDZ deep-shadow profile' },
    { id: 'charcoal',           name: 'Charcoal',            hex: '#2c2c2c',
      blend: 'deep blackish-gray with charcoal granules, slate-gray flecks, and subtle warm-gray accents; HDZ deep-shadow profile' },
    { id: 'hickory',            name: 'Hickory',             hex: '#5e4530',
      blend: 'warm reddish-brown with darker chocolate granules and lighter tan-gold flecks; rich nutshell tone with HDZ shadow lines' },
    { id: 'hunter-green',       name: 'Hunter Green',        hex: '#2d4030',
      blend: 'deep forest green with darker pine granules, subtle olive flecks, and faint warm-brown undertone' },
    { id: 'mission-brown',      name: 'Mission Brown',       hex: '#4a3528',
      blend: 'deep dark brown with reddish mahogany granules, near-black flecks, and subtle copper undertone' },
    { id: 'pewter-gray',        name: 'Pewter Gray',         hex: '#5e5e5e',
      blend: 'medium cool gray with darker slate granules and lighter silver-gray flecks; HDZ deep-shadow profile' },
    { id: 'shakewood',          name: 'Shakewood',           hex: '#7a6048',
      blend: 'warm tan-brown with golden granules, darker brown flecks, and bleached cedar accents; weathered-shake feel' },
    { id: 'slate',              name: 'Slate',               hex: '#46484e',
      blend: 'deep cool gray-slate with darker charcoal granules and subtle blue-gray accents; tight tonal range' },
    { id: 'weathered-wood',     name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'warm gray-brown blend with tan granules, darker brown flecks, and silver-gray accents; reads like aged hardwood' },
    // ── Regional High Definition ──
    { id: 'birchwood',          name: 'Birchwood',           hex: '#a89878', light: true,
      blend: 'light tan-cream with warm beige granules, darker brown flecks, and pale gray accents; soft and airy' },
    { id: 'biscayne-blue',      name: 'Biscayne Blue',       hex: '#2c3848',
      blend: 'deep navy-charcoal with dark blue-black granules, subtle slate-gray flecks, and very faint cool highlights; coastal night' },
    { id: 'copper-canyon',      name: 'Copper Canyon',       hex: '#8c5a35',
      blend: 'warm copper-orange-brown with darker rust granules, mahogany flecks, and golden highlights' },
    { id: 'driftwood',          name: 'Driftwood',           hex: '#8b7860',
      blend: 'bleached gray-brown with weathered tan granules, soft sand flecks, and pale silver-gray accents' },
    { id: 'fox-hollow-gray',    name: 'Fox Hollow Gray',     hex: '#6e6e6e',
      blend: 'medium cool-warm gray with darker charcoal granules and lighter taupe flecks; subtle warm undertone' },
    { id: 'golden-amber',       name: 'Golden Amber',        hex: '#b8924a',
      blend: 'warm honey-gold with amber granules, darker caramel flecks, and subtle copper highlights' },
    { id: 'oyster-gray',        name: 'Oyster Gray',         hex: '#a8a39a', light: true,
      blend: 'pale pearl-gray with subtle warm cream granules and soft taupe accents; light airy gray' },
    { id: 'patriot-red',        name: 'Patriot Red',         hex: '#6e2828',
      blend: 'deep brick-red with darker burgundy granules, near-black flecks, and subtle warm red highlights' },
    { id: 'sunset-brick',       name: 'Sunset Brick',        hex: '#7e3838',
      blend: 'warm terracotta-orange-red with darker brick granules, deeper red flecks, and amber highlights' },
    { id: 'williamsburg-slate', name: 'Williamsburg Slate',  hex: '#3d4350',
      blend: 'deep blue-slate with charcoal granules, navy-blue flecks, and cool gray accents' },
    // ── American Harvest (legacy multi-blend; richer 4-tone signature) ──
    { id: 'adobe-sunset',       name: 'Adobe Sunset',        hex: '#a06840',
      blend: 'warm terracotta-orange with brick-red granules, golden-amber flecks, and darker brown variation; southwestern desert tone' },
    { id: 'appalachian-sky',    name: 'Appalachian Sky',     hex: '#4a5868',
      blend: 'storm-gray-blue with charcoal granules, slate-blue flecks, and lighter gray highlights; multi-tone like an overcast Appalachian sky' },
    { id: 'brandywine-dusk',    name: 'Brandywine Dusk',     hex: '#5e3838',
      blend: 'deep wine-burgundy with darker charcoal granules, warm brown flecks, and faint plum highlights' },
    { id: 'cedar-falls',        name: 'Cedar Falls',         hex: '#6e5235',
      blend: 'warm reddish-brown with chocolate granules, darker charcoal flecks, and amber highlights; autumnal cedar' },
    { id: 'golden-harvest',     name: 'Golden Harvest',      hex: '#a07440',
      blend: 'warm gold-brown with amber granules, darker caramel flecks, and lighter wheat-tan highlights' },
    { id: 'nantucket-morning',  name: 'Nantucket Morning',   hex: '#7a8590',
      blend: 'soft cool gray-blue with cream granules, lighter tan flecks, and pale silver accents; early morning fog' },
    { id: 'saddlewood-ranch',   name: 'Saddlewood Ranch',    hex: '#6e4530',
      blend: 'rich saddle-brown with darker chocolate granules, warm amber flecks, and copper highlights' },
    // ── Bold Definition (Jan 2026; richer tones, dramatic contrast) ──
    { id: 'chestnut-valley',    name: 'Chestnut Valley',     hex: '#5e3a25',
      blend: 'rich warm chestnut brown with deeper mahogany granules, copper-red flecks, and subtle golden highlights; bold contrast' },
    { id: 'cliffside',          name: 'Cliffside',           hex: '#8a8680',
      blend: 'sophisticated warm gray with limestone-tan granules, beige flecks, and darker charcoal accents; weathered cliff stone' },
    { id: 'midnight-mesa',      name: 'Midnight Mesa',       hex: '#252830',
      blend: 'deep dark blue-charcoal with near-black granules, navy-blue flecks, and faint warm dark-brown undertone; dramatic night sky' },
    { id: 'sierra-sand',        name: 'Sierra Sand',         hex: '#a89476',
      blend: 'warm tan-beige with golden-sand granules, lighter cream flecks, and subtle darker tan accents; desert sand' },
  ],

  // Timberline UHDZ — premium / Class 4 impact-rated; 6 colors.
  // Same blend recipes as HDZ but rendered with thicker tab + deeper shadow.
  timberlineUhdzColors: [
    { id: 'barkwood',           name: 'Barkwood',            hex: '#4a3a2a',
      blend: 'deep warm brown with darker chocolate-mahogany granules and lighter reddish-tan flecks; UHDZ ultra-deep shadow' },
    { id: 'charcoal',           name: 'Charcoal',            hex: '#2c2c2c',
      blend: 'deep blackish-gray with charcoal granules, slate-gray flecks, and subtle warm-gray accents; UHDZ ultra-deep shadow' },
    { id: 'pewter-gray',        name: 'Pewter Gray',         hex: '#5e5e5e',
      blend: 'medium cool gray with darker slate granules and lighter silver-gray flecks; UHDZ ultra-deep shadow' },
    { id: 'shakewood',          name: 'Shakewood',           hex: '#7a6048',
      blend: 'warm tan-brown with golden granules, darker brown flecks, and bleached cedar accents; weathered-shake with UHDZ depth' },
    { id: 'slate',              name: 'Slate',               hex: '#46484e',
      blend: 'deep cool gray-slate with darker charcoal granules and subtle blue-gray accents; UHDZ ultra-deep shadow' },
    { id: 'weathered-wood',     name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'warm gray-brown with tan granules, darker brown flecks, and silver-gray accents; aged hardwood with UHDZ depth' },
  ],

  // Camelot II — designer slate-look luxury line; 5 colors.
  // Designer profile: scalloped/staggered cuts mimicking natural slate.
  camelot2Colors: [
    { id: 'antique-slate',      name: 'Antique Slate',       hex: '#3a3a40',
      blend: 'multi-tone aged slate with charcoal granules, blue-gray flecks, warm gray accents, and subtle silver highlights; designer staggered slate look' },
    { id: 'barkwood',           name: 'Barkwood',            hex: '#4a3a2a',
      blend: 'deep warm brown with chocolate-mahogany granules, reddish-tan flecks, and bleached cedar accents; designer staggered profile' },
    { id: 'charcoal',           name: 'Charcoal',            hex: '#2c2c2c',
      blend: 'deep blackish-gray with charcoal granules, slate-gray flecks, and warm-gray accents; designer staggered profile' },
    { id: 'royal-slate',        name: 'Royal Slate',         hex: '#4a5266',
      blend: 'rich blue-slate with navy granules, charcoal flecks, and cool gray-blue highlights; regal stone tone with designer staggered cuts' },
    { id: 'weathered-timber',   name: 'Weathered Timber',    hex: '#7a6750',
      blend: 'warm gray-brown blend with bleached cedar granules, darker brown flecks, and weathered tan accents; designer cedar-shake look' },
  ],

  // Standing-seam metal palette (shown when roofLine === 'metal').
  // Painted metal panels are SINGLE-TONE — no granule blend. Description
  // emphasizes finish (matte / satin / mirror) and any reflective quality.
  metalColors: [
    { id: 'matte-black',     name: 'Matte Black',     hex: '#1a1a1a',
      blend: 'matte deep-black painted standing-seam metal — uniform, low-sheen, no reflective hotspots' },
    { id: 'charcoal',        name: 'Charcoal',        hex: '#3a3a3a',
      blend: 'matte charcoal-gray painted standing-seam metal — uniform medium-dark gray, low-sheen finish' },
    { id: 'galvalume',       name: 'Galvalume',       hex: '#a8a8a8', light: true,
      blend: 'unpainted Galvalume® steel with bright silver-gray reflective metallic finish; visible directional sheen along the seams' },
    { id: 'medium-bronze',   name: 'Medium Bronze',   hex: '#5e4530',
      blend: 'rich warm bronze painted metal — deep brown with subtle warm undertones; satin finish' },
    { id: 'forest-green',    name: 'Forest Green',    hex: '#1f3528',
      blend: 'deep forest-green painted metal — uniform pine green with low-sheen finish' },
    { id: 'colonial-red',    name: 'Colonial Red',    hex: '#7a1c1c',
      blend: 'classic colonial barn-red painted metal — deep brick-red with subtle warm undertone; satin finish' },
    { id: 'almond',          name: 'Almond',          hex: '#d8c8a8', light: true,
      blend: 'creamy almond painted metal — warm beige-cream; soft low-sheen finish' },
    { id: 'stone-white',     name: 'Stone White',     hex: '#e8e0d0', light: true,
      blend: 'soft stone-white painted metal — gentle off-white with warm undertone; satin finish' },
  ],

  // ── TAMKO COLOR PALETTES (Heritage, Titan XT, StormFighter FLEX, HailGuard) ─────────────────────────
  // Color names pulled from Jo's TAMKO sell sheets (Titan XT 14, StormFighter
  // Flex 8). hex = dominant tone (calibrated against TAMKO swatch imagery);
  // blend = the multi-tone granule description fed to the FLUX prompt — same
  // format as the GAF palettes above.

  // Heritage — TAMKO's value architectural line (newly reformulated, TriShield).
  // Phillipsburg-region "Classic Colors" featured palette, per Jo's brochure.
  tamkoHeritageColors: [
    { id: 'rustic-black',        name: 'Rustic Black',        hex: '#232323',
      blend: 'deep black base with dark-grey highlights and charcoal granules; bold heirloom cast-iron tone' },
    { id: 'oxford-grey',         name: 'Oxford Grey',         hex: '#44464d',
      blend: 'rich gothic grey with soft tan undertones, charcoal granules, and warm-gray flecks; refined transitional tone' },
    { id: 'weathered-wood',      name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'balanced warm-and-cool blend with tan granules, darker brown flecks, and silver-gray accents; timeless aged-wood look' },
    { id: 'antique-slate',       name: 'Antique Slate',       hex: '#3f4047',
      blend: 'multi-tone aged slate with charcoal granules, blue-gray flecks, and warm-gray accents; classic stone tone' },
  ],

  // Titan XT — TAMKO's full 14-color premium palette.
  tamkoTitanColors: [
    { id: 'autumn-brown',        name: 'Autumn Brown',        hex: '#5a3b28',
      blend: 'warm autumn brown with darker chocolate granules, reddish-rust flecks, and golden-amber accents; rich fall-foliage tone' },
    { id: 'black-walnut',        name: 'Black Walnut',        hex: '#2e2620',
      blend: 'deep walnut brown-black with near-black granules, dark espresso flecks, and faint warm-brown accents; rich dark hardwood tone' },
    { id: 'mountain-slate',      name: 'Mountain Slate',      hex: '#4a4e54',
      blend: 'cool gray-slate with darker charcoal granules, blue-gray flecks, and lighter silver accents; mountain-stone tone' },
    { id: 'natural-timber',      name: 'Natural Timber',      hex: '#6e553a',
      blend: 'warm tan-brown with golden-wheat granules, darker brown flecks, and bleached-cedar accents; natural timber look' },
    { id: 'painted-desert',      name: 'Painted Desert',      hex: '#8a5238',
      blend: 'warm terracotta-clay with brick-red granules, golden-amber flecks, and darker brown variation; southwestern desert blend' },
    { id: 'thunderstorm-grey',   name: 'Thunderstorm Grey',   hex: '#44464a',
      blend: 'deep storm-gray with charcoal granules, slate-gray flecks, and subtle cool highlights; overcast-sky tone' },
    { id: 'desert-sand',         name: 'Desert Sand',         hex: '#b6a079', light: true,
      blend: 'light sandy tan with warm cream granules, soft beige flecks, and pale taupe accents; airy desert-sand tone' },
    { id: 'olde-english-pewter', name: 'Olde English Pewter', hex: '#6a6a6a',
      blend: 'medium pewter gray with darker slate granules, lighter silver-gray flecks, and a faint warm undertone' },
    { id: 'oxford-grey',         name: 'Oxford Grey',         hex: '#3a3c40',
      blend: 'dark oxford charcoal with near-black granules, slate-gray flecks, and subtle cool-gray accents' },
    { id: 'rustic-black',        name: 'Rustic Black',        hex: '#232323',
      blend: 'deep rustic black with charcoal granules, dark slate flecks, and faint warm-gray accents; clean black-roof look' },
    { id: 'rustic-cedar',        name: 'Rustic Cedar',        hex: '#6e4128',
      blend: 'warm reddish cedar-brown with darker chocolate granules, copper-red flecks, and golden-tan accents; weathered cedar tone' },
    { id: 'rustic-evergreen',    name: 'Rustic Evergreen',    hex: '#2f4233',
      blend: 'deep evergreen with darker pine granules, olive-green flecks, and a faint warm-brown undertone; forest tone' },
    { id: 'rustic-slate',        name: 'Rustic Slate',        hex: '#4c4f57',
      blend: 'multi-tone rustic slate with charcoal granules, blue-gray flecks, and warm-gray accents; varied natural-slate look' },
    { id: 'weathered-wood',      name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'warm gray-brown with tan granules, darker brown flecks, and silver-gray accents; reads like aged weathered wood' },
  ],

  // StormFighter Flex + HailGuard — shared 8-color storm palette.
  tamkoStormColors: [
    { id: 'black-walnut',        name: 'Black Walnut',        hex: '#2e2620',
      blend: 'deep walnut brown-black with near-black granules, dark espresso flecks, and faint warm-brown accents; rich dark hardwood tone' },
    { id: 'olde-english-pewter', name: 'Olde English Pewter', hex: '#6a6a6a',
      blend: 'medium pewter gray with darker slate granules, lighter silver-gray flecks, and a faint warm undertone' },
    { id: 'oxford-grey',         name: 'Oxford Grey',         hex: '#3a3c40',
      blend: 'dark oxford charcoal with near-black granules, slate-gray flecks, and subtle cool-gray accents' },
    { id: 'rustic-black',        name: 'Rustic Black',        hex: '#232323',
      blend: 'deep rustic black with charcoal granules, dark slate flecks, and faint warm-gray accents; clean black-roof look' },
    { id: 'thunderstorm-grey',   name: 'Thunderstorm Grey',   hex: '#44464a',
      blend: 'deep storm-gray with charcoal granules, slate-gray flecks, and subtle cool highlights; overcast-sky tone' },
    { id: 'rustic-cedar',        name: 'Rustic Cedar',        hex: '#6e4128',
      blend: 'warm reddish cedar-brown with darker chocolate granules, copper-red flecks, and golden-tan accents; weathered cedar tone' },
    { id: 'rustic-slate',        name: 'Rustic Slate',        hex: '#4c4f57',
      blend: 'multi-tone rustic slate with charcoal granules, blue-gray flecks, and warm-gray accents; varied natural-slate look' },
    { id: 'weathered-wood',      name: 'Weathered Wood',      hex: '#5e4e3a',
      blend: 'warm gray-brown with tan granules, darker brown flecks, and silver-gray accents; reads like aged weathered wood' },
  ],

  sidingMaterials: [
    { id: 'vinyl',        label: 'Vinyl',         desc: 'Most affordable, low maintenance',
      ai: 'vinyl siding' },
    { id: 'fiber-cement', label: 'Fiber-Cement',  desc: 'James Hardie® brand',
      ai: 'James Hardie ColorPlus® fiber-cement siding' },
    { id: 'wood',         label: 'Wood / Cedar',  desc: 'Natural classic look',
      ai: 'natural cedar wood siding' },
  ],

  sidingStyles: [
    { id: 'lap',          label: 'Traditional Lap',   ai: 'horizontal lap profile' },
    { id: 'dutch-lap',    label: 'Dutch Lap',         ai: 'Dutch-lap profile' },
    { id: 'board-batten', label: 'Board & Batten',    ai: 'board-and-batten vertical profile' },
    { id: 'shake',        label: 'Shake',             ai: 'shake / shingle profile' },
  ],

  // Siding colors — vinyl / fiber-cement palettes are predominantly
  // SINGLE-TONE painted finishes. Blend description still helps FLUX
  // by giving exact tonal language ("warm cream" beats "cream").
  sidingColors: [
    { id: 'arctic-white',   name: 'Arctic White',     hex: '#f0e8d8', light: true,
      blend: 'crisp warm white siding with very subtle cream undertone; clean architectural look' },
    { id: 'cream',          name: 'Cream',            hex: '#e8d8b8', light: true,
      blend: 'soft warm cream — muted ivory with faint yellow undertone, low-sheen finish' },
    { id: 'linen',          name: 'Linen',            hex: '#d8c8a8', light: true,
      blend: 'soft linen-tan — warm off-white with subtle beige undertone' },
    { id: 'sandstone',      name: 'Sandstone Beige',  hex: '#c8b898',
      blend: 'warm sandstone beige — muted tan with subtle warm-stone undertone' },
    { id: 'pebble',         name: 'Pebble Clay',      hex: '#a89888',
      blend: 'medium warm taupe — earthy clay-tan, slightly cooler than sandstone' },
    { id: 'monterey-taupe', name: 'Monterey Taupe',   hex: '#8a7868',
      blend: 'rich warm taupe — deeper than pebble, with subtle gray-brown undertone' },
    { id: 'cobblestone',    name: 'Cobblestone',      hex: '#6e6e6e',
      blend: 'medium neutral gray — true warm-cool balance, low-sheen finish' },
    { id: 'pearl-gray',     name: 'Pearl Gray',       hex: '#a0a8a8', light: true,
      blend: 'pale cool pearl gray with very subtle blue-green undertone; soft modern look' },
    { id: 'iron-gray',      name: 'Iron Gray',        hex: '#4a4e54',
      blend: 'deep cool iron gray — strong neutral with subtle blue-charcoal undertone' },
    { id: 'aged-pewter',    name: 'Aged Pewter',      hex: '#3a3e44',
      blend: 'deep dark pewter — almost-black gray with faint blue-cool undertone' },
    { id: 'evening-blue',   name: 'Evening Blue',     hex: '#3e4858',
      blend: 'deep slate-blue with subtle gray-charcoal undertone; rich coastal evening tone' },
    { id: 'deep-ocean',     name: 'Deep Ocean',       hex: '#1e2c3e',
      blend: 'deep midnight navy with subtle blue-charcoal undertone; dramatic dark blue' },
    { id: 'cypress',        name: 'Cypress Green',    hex: '#3a4a3e',
      blend: 'deep cypress-pine green with warm earth undertone; muted forest tone' },
    { id: 'autumn-red',     name: 'Autumn Red',       hex: '#8e2828',
      blend: 'rich autumn brick-red with darker burgundy undertone; warm classic red' },
    { id: 'cedar',          name: 'Cedar Brown',      hex: '#6e4a30',
      blend: 'warm cedar-brown — natural wood-stain look with reddish-amber undertone' },
    { id: 'matte-black',    name: 'Matte Black',      hex: '#1c1917',
      blend: 'matte deep black — modern farmhouse look, low-sheen finish' },
  ],

  gutterStyles: [
    { id: 'k-style',    label: 'K-Style',     ai: 'K-style seamless aluminum' },
    { id: 'half-round', label: 'Half-Round',  ai: 'half-round seamless aluminum' },
  ],

  // Trim palette — used for gutters, windows, garage, shutters, doors.
  // All single-tone painted finishes (no granule blends apply).
  trimColors: [
    { id: 'white',         name: 'White',          hex: '#f8f8f8', light: true,
      blend: 'crisp painted white — bright clean trim color, low-sheen finish' },
    { id: 'almond',        name: 'Almond',         hex: '#d1c8b8', light: true,
      blend: 'warm almond-cream painted finish — soft beige with cream undertone' },
    { id: 'sandstone',     name: 'Sandstone',      hex: '#c8b898',
      blend: 'warm sandstone-tan painted finish — earthy mid-tan' },
    { id: 'gray',          name: 'Gray',           hex: '#6b7280',
      blend: 'medium neutral gray painted finish — clean modern gray' },
    { id: 'iron-gray',     name: 'Iron Gray',      hex: '#4a4e54',
      blend: 'deep cool iron-gray painted finish — strong neutral with blue undertone' },
    { id: 'black',         name: 'Black',          hex: '#1a1a1a',
      blend: 'matte deep black painted finish — uniform low-sheen black' },
    { id: 'bronze',        name: 'Dark Bronze',    hex: '#3e3024',
      blend: 'rich dark bronze painted finish — warm deep brown with subtle copper undertone' },
    { id: 'brown',         name: 'Brown',          hex: '#4a3528',
      blend: 'deep chocolate brown painted finish — warm rich brown' },
    { id: 'cedar',         name: 'Natural Cedar',  hex: '#a06840',
      blend: 'natural cedar wood stain — warm reddish-tan, slight grain visible' },
    { id: 'forest-green',  name: 'Forest Green',   hex: '#2d4030',
      blend: 'deep forest-green painted finish — dark pine with warm earth undertone' },
    { id: 'navy',          name: 'Navy',           hex: '#1e3a6e',
      blend: 'deep classic navy blue painted finish — rich saturated marine blue' },
    { id: 'red',           name: 'Red',            hex: '#7a1c1c',
      blend: 'deep brick-red painted finish — warm classic red with subtle burgundy undertone' },
  ],

  garageStyles: [
    { id: 'panel-classic',  label: 'Classic Panelled',   ai: 'classic raised-panel garage door' },
    { id: 'flush',          label: 'Flush / Modern',     ai: 'flush modern minimalist garage door' },
    { id: 'carriage',       label: 'Carriage House',     ai: 'carriage-house style garage door with decorative hinges' },
    { id: 'glass-modern',   label: 'Glass-Panel Modern', ai: 'modern frosted-glass-panel garage door' },
  ],
};

// ── STATE ──────────────────────────────────────────────────────
let uploadedFile = null;
let uploadedDataUrl = null;
const state = {
  features:        ['roof'],
  roofLine:        'timberline-hdz',
  roofColor:       'charcoal',
  sidingMaterial:  'vinyl',
  sidingStyle:     'lap',
  sidingColor:     'cream',
  gutterStyle:     'k-style',
  gutterColor:     'almond',
  windowColor:     'white',
  garageStyle:     'panel-classic',
  garageColor:     'white',
  shutterColor:    'black',
  doorColor:       'navy',
};

// ── NAV ────────────────────────────────────────────────────────


// ── UPLOAD ─────────────────────────────────────────────────────
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const previewContainer = document.getElementById('previewContainer');
const previewImg = document.getElementById('previewImg');
const toStep2Btn = document.getElementById('toStep2');

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) handleFile(f); });
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

// Max dimensions + target bytes for the backend (AI endpoint rejects
// anything over ~1.5 MB base64 which is ~1.1 MB raw). Modern phone
// photos are 3-10 MB, so client-side resize is mandatory.
const MAX_UPLOAD_EDGE = 1600;     // max pixels on the longest edge
const MAX_UPLOAD_BYTES = 1_100_000; // raw bytes before base64 inflation (leaves headroom)
const JPEG_QUALITY_START = 0.85;

async function resizeAndCompress(file) {
  // Load the file into an Image element via object URL
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image — try a different photo.'));
      i.src = objectUrl;
    });

    // Compute resize target — only downscale, never upscale
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longest > MAX_UPLOAD_EDGE ? MAX_UPLOAD_EDGE / longest : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    // Iteratively drop quality until size is under limit (rare — 1600px @ 0.85 is almost always under)
    let quality = JPEG_QUALITY_START;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > MAX_UPLOAD_BYTES && quality > 0.45) {
      quality = Math.max(0.45, quality - 0.1);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    return { dataUrl, width: w, height: h, quality };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function handleFile(file) {
  uploadedFile = file;
  // Show a quick "processing" hint on the zone in case resize takes >200ms on slow devices
  const hint = document.createElement('div');
  hint.className = 'upload-hint-temp';
  hint.style.cssText = 'font-size:.78rem;color:var(--gray);margin-top:8px;';
  hint.textContent = 'Processing photo…';
  try { uploadZone.appendChild(hint); } catch (_) {}

  try {
    const { dataUrl } = await resizeAndCompress(file);
    uploadedDataUrl = dataUrl;
    previewImg.src = dataUrl;
    uploadZone.style.display = 'none';
    previewContainer.style.display = 'block';
    toStep2Btn.disabled = false;
  } catch (err) {
    alert(err.message || 'That image could not be used. Please try another photo.');
  } finally {
    try { hint.remove(); } catch (_) {}
  }
}

function resetUpload() {
  uploadedFile = null; uploadedDataUrl = null;
  fileInput.value = '';
  uploadZone.style.display = 'block';
  previewContainer.style.display = 'none';
  toStep2Btn.disabled = true;
}

// ── RENDERERS ──────────────────────────────────────────────────
// Pills (radio or multi)
function renderPills(containerId, items, opts) {
  opts = opts || {};
  const stateKey = opts.stateKey;
  const multi    = !!opts.multi;
  const onChange = opts.onChange;
  const c = document.getElementById(containerId);
  if (!c) return;
  // Optional manufacturer/group dimension: when items carry a `group`, emit a
  // full-width group label whenever the group changes. Items without `group`
  // render as a flat list exactly as before (backward compatible).
  let lastGroup = null;
  c.innerHTML = items.map(it => {
    const sel = multi
      ? (state[stateKey] || []).includes(it.id)
      : state[stateKey] === it.id;
    const sub = it.desc ? `<span class="pill-sub">${it.desc}</span>` : '';
    let groupHdr = '';
    if (it.group && it.group !== lastGroup) {
      groupHdr = `<div class="pill-group-label">${it.group}</div>`;
      lastGroup = it.group;
    }
    return `${groupHdr}<span class="pill${sel ? ' selected' : ''}" role="button" tabindex="0" aria-pressed="${sel ? 'true' : 'false'}" data-val="${it.id}">${it.label}${sub}</span>`;
  }).join('');
  function syncPillPressed() {
    c.querySelectorAll('.pill').forEach(p => p.setAttribute('aria-pressed', p.classList.contains('selected') ? 'true' : 'false'));
  }
  c.addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    if (multi) {
      pill.classList.toggle('selected');
      state[stateKey] = [...c.querySelectorAll('.pill.selected')].map(p => p.dataset.val);
    } else {
      c.querySelectorAll('.pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      state[stateKey] = pill.dataset.val;
    }
    syncPillPressed();
    if (onChange) onChange();
  });
  // Keyboard activation (WCAG 2.1.1): Enter/Space on a role=button pill.
  c.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const pill = e.target.closest('.pill');
    if (pill) { e.preventDefault(); pill.click(); }
  });
}

// Swatches (single-select color). Each container is paired with a sibling
// `<span class="color-selected-label">` that always shows the currently
// selected color name — the on-swatch tooltip alone gets clipped behind
// the next row of chips on touch devices, so we mirror it in the header.
const SWATCH_LABEL_MAP = {
  roofColors:    'roofColorSelected',
  sidingColors:  'sidingColorSelected',
  gutterColors:  'gutterColorSelected',
  windowColors:  'windowColorSelected',
  garageColors:  'garageColorSelected',
  shutterColors: 'shutterColorSelected',
  doorColors:    'doorColorSelected',
};

function updateSelectedLabel(containerId, item) {
  const labelId = SWATCH_LABEL_MAP[containerId];
  if (!labelId) return;
  const labelEl = document.getElementById(labelId);
  if (!labelEl) return;
  if (!item) { labelEl.hidden = true; labelEl.innerHTML = ''; return; }
  labelEl.hidden = false;
  labelEl.innerHTML = `<span class="csl-dot" style="background:${item.hex}"></span>${item.name}`;
}

function renderSwatches(containerId, items, stateKey) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = items.map(it => {
    const sel = state[stateKey] === it.id;
    const cls = 'swatch' + (sel ? ' selected' : '') + (it.light ? ' light-bg' : '');
    return `<div class="${cls}" role="button" data-val="${it.id}" data-name="${it.name}" data-hex="${it.hex}" title="${it.name}" tabindex="0" aria-pressed="${sel ? 'true' : 'false'}" aria-label="${it.name}"><div class="swatch-chip" style="background:${it.hex}"></div><span class="swatch-name">${it.name}</span></div>`;
  }).join('');
  // Initialize the selected-label header from current state
  const initial = items.find(it => it.id === state[stateKey]) || items[0];
  if (initial) updateSelectedLabel(containerId, initial);
  c.addEventListener('click', e => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    c.querySelectorAll('.swatch').forEach(s => { s.classList.remove('selected'); s.setAttribute('aria-pressed', 'false'); });
    sw.classList.add('selected');
    sw.setAttribute('aria-pressed', 'true');
    state[stateKey] = sw.dataset.val;
    updateSelectedLabel(containerId, { id: sw.dataset.val, name: sw.dataset.name, hex: sw.dataset.hex });
  });
  // Keyboard activation (WCAG 2.1.1): the swatches were focusable but click-only.
  c.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const sw = e.target.closest('.swatch');
    if (sw) { e.preventDefault(); sw.click(); }
  });
}

// Initial render
renderPills('featurePills',         VIZ_OPTIONS.features,        { stateKey: 'features',       multi: true,  onChange: updateOptionVisibility });
renderPills('roofLinePills',        VIZ_OPTIONS.roofLines,       { stateKey: 'roofLine',                     onChange: onRoofLineChange });
// Roof colors are line-specific — start with whatever the default roofLine carries.
renderSwatches('roofColors',        getRoofPaletteForLine(state.roofLine), 'roofColor');
{ const lbl = document.getElementById('roofColorLabel'); if (lbl) lbl.textContent = paletteHeaderLabel(state.roofLine); }
renderPills('sidingMaterialPills',  VIZ_OPTIONS.sidingMaterials, { stateKey: 'sidingMaterial' });
renderPills('sidingStylePills',     VIZ_OPTIONS.sidingStyles,    { stateKey: 'sidingStyle' });
renderSwatches('sidingColors',      VIZ_OPTIONS.sidingColors,    'sidingColor');
renderPills('gutterStylePills',     VIZ_OPTIONS.gutterStyles,    { stateKey: 'gutterStyle' });
renderSwatches('gutterColors',      VIZ_OPTIONS.trimColors,      'gutterColor');
renderSwatches('windowColors',      VIZ_OPTIONS.trimColors,      'windowColor');
renderPills('garageStylePills',     VIZ_OPTIONS.garageStyles,    { stateKey: 'garageStyle' });
renderSwatches('garageColors',      VIZ_OPTIONS.trimColors,      'garageColor');
renderSwatches('shutterColors',     VIZ_OPTIONS.trimColors,      'shutterColor');
renderSwatches('doorColors',        VIZ_OPTIONS.trimColors,      'doorColor');

// When the roof line changes, swap to that line's stock color palette and
// reset the selection if the previously-picked color isn't carried in the
// new line. Each `roofLines` entry points at its own `colorsRef` so this
// function never has to special-case product names.
function getRoofPaletteForLine(lineId) {
  const line = VIZ_OPTIONS.roofLines.find(l => l.id === lineId) || VIZ_OPTIONS.roofLines[1];
  return VIZ_OPTIONS[line.colorsRef] || VIZ_OPTIONS.timberlineHdzColors;
}

function paletteHeaderLabel(lineId) {
  const line = VIZ_OPTIONS.roofLines.find(l => l.id === lineId);
  if (!line) return 'Roof Color';
  if (line.id === 'metal') return 'Roof Color · Standing-Seam Metal Palette';
  const brand = line.mfr ? line.mfr + ' ' : '';
  return `Roof Color · ${brand}${line.label} Palette`;
}

function onRoofLineChange() {
  const palette = getRoofPaletteForLine(state.roofLine);
  // If current roofColor isn't in the new palette, default to first
  if (!palette.find(c => c.id === state.roofColor)) state.roofColor = palette[0].id;
  // Update the header label to reflect the active line
  const lbl = document.getElementById('roofColorLabel');
  if (lbl) lbl.textContent = paletteHeaderLabel(state.roofLine);
  // Re-render swatches with new palette (replace listener via fresh render)
  const c = document.getElementById('roofColors');
  if (c) c.replaceWith(c.cloneNode(false)); // strip old listener
  renderSwatches('roofColors', palette, 'roofColor');
}

function updateOptionVisibility() {
  const f = state.features;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('roofLineGroup',       f.includes('roof'));
  show('roofColorGroup',      f.includes('roof'));
  show('sidingMaterialGroup', f.includes('siding'));
  show('sidingStyleGroup',    f.includes('siding'));
  show('sidingColorGroup',    f.includes('siding'));
  show('gutterStyleGroup',    f.includes('gutters'));
  show('gutterColorGroup',    f.includes('gutters'));
  show('windowColorGroup',    f.includes('windows'));
  show('garageStyleGroup',    f.includes('garage'));
  show('garageColorGroup',    f.includes('garage'));
  show('shutterColorGroup',   f.includes('shutters'));
  show('doorColorGroup',      f.includes('doors'));
}
updateOptionVisibility();

// ── STEP NAV ───────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.viz-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel${n}`).classList.add('active');
  document.querySelectorAll('.step-tab').forEach((t, i) => {
    t.classList.remove('active', 'done');
    if (i + 1 < n) t.classList.add('done');
    if (i + 1 === n) t.classList.add('active');
  });
}

// ── VISUALIZER ─────────────────────────────────────────────────
async function runVisualizer() {
  goToStep(3);
  document.getElementById('resultsLoading').style.display = 'block';
  document.getElementById('resultsContent').style.display = 'none';

  // Animate loading steps
  const steps = ['ls1','ls2','ls3','ls4','ls5'];
  let stepIdx = 1;
  const stepInterval = setInterval(() => {
    if (stepIdx < steps.length) {
      document.getElementById(steps[stepIdx - 1]).className = 'loading-step done';
      document.getElementById(steps[stepIdx]).className = 'loading-step active';
      stepIdx++;
    }
  }, 4500);

  // Helpers — every label/AI-name is derived from VIZ_OPTIONS so there is
  // exactly one source of truth between the UI, the AI prompt, and the
  // canvas-fallback color overlay.
  const findById = (list, id) => list.find(x => x.id === id) || list[0];
  const features = state.features.length ? state.features : ['roof'];

  const roofLine     = findById(VIZ_OPTIONS.roofLines, state.roofLine);
  const isMetalRoof  = roofLine.id === 'metal';
  const roofPalette  = getRoofPaletteForLine(state.roofLine);
  const roofColor    = findById(roofPalette, state.roofColor);
  const sidingMat    = findById(VIZ_OPTIONS.sidingMaterials, state.sidingMaterial);
  const sidingStyle  = findById(VIZ_OPTIONS.sidingStyles, state.sidingStyle);
  const sidingColor  = findById(VIZ_OPTIONS.sidingColors, state.sidingColor);
  const gutterStyle  = findById(VIZ_OPTIONS.gutterStyles, state.gutterStyle);
  const gutterColor  = findById(VIZ_OPTIONS.trimColors, state.gutterColor);
  const windowColor  = findById(VIZ_OPTIONS.trimColors, state.windowColor);
  const garageStyle  = findById(VIZ_OPTIONS.garageStyles, state.garageStyle);
  const garageColor  = findById(VIZ_OPTIONS.trimColors, state.garageColor);
  const shutterColor = findById(VIZ_OPTIONS.trimColors, state.shutterColor);
  const doorColor    = findById(VIZ_OPTIONS.trimColors, state.doorColor);

  const notes = document.getElementById('additionalNotes').value.trim();

  // AI-friendly text representation — used by the public /publicVisualizerAI
  // endpoint which expects a `selectionsText` string.
  const selectionsText = [
    features.includes('roof')     ? `Roof: ${roofLine.ai} in ${roofColor.name}` : '',
    features.includes('siding')   ? `Siding: ${sidingMat.ai} with ${sidingStyle.ai} in ${sidingColor.name}` : '',
    features.includes('gutters')  ? `Gutters: ${gutterStyle.ai} in ${gutterColor.name}` : '',
    features.includes('windows')  ? `Windows: ${windowColor.name} trim` : '',
    features.includes('garage')   ? `Garage door: ${garageStyle.ai} in ${garageColor.name}` : '',
    features.includes('shutters') ? `Shutters: ${shutterColor.name}` : '',
    features.includes('doors')    ? `Front door: ${doorColor.name}` : '',
  ].filter(Boolean).join('; ');

  // Structured payload — sent alongside selectionsText so the image-gen
  // endpoint and any future consumers don't have to re-parse the string.
  // `blend` is the multi-tone granule description from VIZ_OPTIONS; it
  // gets injected into the FLUX prompt to anchor the color realistically.
  const selections = {
    features,
    roof:    features.includes('roof')     ? { line: roofLine.id, lineName: roofLine.label, color: roofColor.id, colorName: roofColor.name, hex: roofColor.hex, blend: roofColor.blend || '' } : null,
    siding:  features.includes('siding')   ? { material: sidingMat.id, materialName: sidingMat.label, style: sidingStyle.id, color: sidingColor.id, colorName: sidingColor.name, hex: sidingColor.hex, blend: sidingColor.blend || '' } : null,
    gutters: features.includes('gutters')  ? { style: gutterStyle.id, color: gutterColor.id, colorName: gutterColor.name, hex: gutterColor.hex, blend: gutterColor.blend || '' } : null,
    windows: features.includes('windows')  ? { color: windowColor.id, colorName: windowColor.name, hex: windowColor.hex, blend: windowColor.blend || '' } : null,
    garage:  features.includes('garage')   ? { style: garageStyle.id, color: garageColor.id, colorName: garageColor.name, hex: garageColor.hex, blend: garageColor.blend || '' } : null,
    shutters:features.includes('shutters') ? { color: shutterColor.id, colorName: shutterColor.name, hex: shutterColor.hex, blend: shutterColor.blend || '' } : null,
    doors:   features.includes('doors')    ? { color: doorColor.id, colorName: doorColor.name, hex: doorColor.hex, blend: doorColor.blend || '' } : null,
  };

  // Call BOTH endpoints in parallel:
  //   1. publicVisualizerAI → Joe's text assessment (Claude, ~2s)
  //   2. visualizerImageGen → real AI-edited image (Gemini 2.5 Flash Image, ~5s)
  //
  // The image endpoint is gated by a server-side feature flag — when off
  // it returns 503 and we fall back to the canvas color filter below.
  const base64 = uploadedDataUrl.split(',')[1];
  const mediaType = uploadedDataUrl.split(';')[0].split(':')[1];
  const FUNCTIONS_BASE = 'https://us-central1-nobigdeal-pro.cloudfunctions.net';

  // Get the App Check token (shared across both requests). Silent-fail
  // is fine — the endpoints don't currently enforce App Check.
  let appCheckToken = '';
  if (window._nbdAppCheck) {
    try {
      const tokenResult = await window._nbdGetAppCheckToken(window._nbdAppCheck);
      appCheckToken = tokenResult && tokenResult.token ? tokenResult.token : '';
    } catch (_) { /* continue — request will still send */ }
  }
  const commonHeaders = {
    'Content-Type': 'application/json',
    ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
  };

  let aiText = '';
  let canvasDescription = '';
  let generatedImageDataUrl = null;   // set when Gemini image gen succeeds

  // ── Text analysis (Claude) ─────────────────────────────────────
  const textPromise = fetch(FUNCTIONS_BASE + '/publicVisualizerAI', {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ imageBase64: base64, mediaType, selectionsText, notes }),
  }).then(async (response) => {
    if (!response.ok) {
      const err = new Error('visualizer_failed_' + response.status);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    const fullText = data.text || '';
    const canvasIdx = fullText.indexOf('CANVAS:');
    return {
      aiText: canvasIdx > -1 ? fullText.substring(0, canvasIdx).trim() : fullText,
      canvasDescription: canvasIdx > -1 ? fullText.substring(canvasIdx + 7).trim() : '',
    };
  });

  // ── Image generation (Gemini 2.5 Flash Image) ──────────────────
  // Send both legacy fields (for the existing cloud function contract)
  // AND the new structured `selections` block. Cloud function can adopt
  // the structured field at its own pace; legacy fields keep it working.
  const imagePromise = fetch(FUNCTIONS_BASE + '/visualizerImageGen', {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      imageBase64: base64,
      mediaType,
      features:    state.features,
      // Legacy field names retained — map new line to the cloud function's
      // existing keys: 'metal' / 'luxury' / 'architectural'. NS, HDZ, UHDZ
      // all collapse to 'architectural' for legacy compatibility; the new
      // structured `selections.roof.line` field carries the precise line.
      roofStyle:   isMetalRoof ? 'metal' : (roofLine.id === 'camelot-2' ? 'luxury' : 'architectural'),
      roofColor:   state.roofColor,
      sidingStyle: state.sidingStyle,
      sidingColor: state.sidingColor,
      gutterColor: state.gutterColor,
      // New structured payload — single source of truth
      selections,
      selectionsText,
      notes,
    }),
  }).then(async (response) => {
    if (!response.ok) {
      const err = new Error('image_gen_failed_' + response.status);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    if (!data.imageBase64) throw new Error('image_gen_empty');
    return 'data:' + (data.mediaType || 'image/png') + ';base64,' + data.imageBase64;
  });

  // Await both; one failure shouldn't crash the other path.
  const [textResult, imageResult] = await Promise.allSettled([textPromise, imagePromise]);

  if (textResult.status === 'fulfilled') {
    aiText = textResult.value.aiText;
    canvasDescription = textResult.value.canvasDescription;
  } else {
    const err = textResult.reason || {};
    if (err && err.status === 413) {
      aiText = "That photo is too large for the AI to process. Try a different one — most phone camera photos work fine. If it still doesn't work, give Joe a call at (859) 420-7382 and he'll review it for you directly.";
    } else if (err && err.status === 429) {
      aiText = "You've hit the hourly limit for the free visualizer (5 photos per hour). Come back in an hour, or just give Joe a call at (859) 420-7382 — he'll walk you through what your selections would look like.";
    } else if (err && err.status >= 500) {
      aiText = "The AI service is having a hiccup on our end. Based on your selections, you've got solid taste — that combination works well on most Ohio homes. Give Joe a call at (859) 420-7382 and he'll walk you through exactly what it would look like.";
    } else {
      aiText = "We're having trouble connecting to the AI right now. Based on your selections, you've got great taste — that combination works well on most Ohio homes. Give Joe a call at (859) 420-7382 and he'll walk you through exactly what it would look like in person.";
    }
  }

  if (imageResult.status === 'fulfilled') {
    generatedImageDataUrl = imageResult.value;
  }
  // If image gen fails, generatedImageDataUrl stays null and the canvas
  // color-filter code below runs as a fallback (same behavior as pre-Gemini).

  clearInterval(stepInterval);
  steps.forEach(s => document.getElementById(s).className = 'loading-step done');

  // Show results
  await new Promise(r => setTimeout(r, 600));
  document.getElementById('resultsLoading').style.display = 'none';
  document.getElementById('resultsContent').style.display = 'block';
  // Result-shown event: ai_image distinguishes a real Gemini render from
  // the canvas color-filter fallback.
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'visualizer_result', {
        ai_image: imageResult.status === 'fulfilled',
        roof_line: state.roofLine || ''
      });
    }
  } catch (e) {}

  // Set original image
  document.getElementById('resultOriginalImg').src = uploadedDataUrl;

  // ── Render the AFTER image ────────────────────────────────────
  // When Gemini image gen succeeded, render the real edited photo
  // directly onto the canvas at its natural resolution (no filter).
  // When it failed, fall through to the legacy canvas color-filter
  // so users always see SOMETHING.
  const canvas = document.getElementById('resultCanvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('resultAiOutput');
  canvas.width = container.offsetWidth || 500;
  canvas.height = container.offsetHeight || 280;

  // ── Render AFTER image ──
  // Single render path. If Gemini produced an image, draw it. Otherwise
  // fall through to the canvas color-overlay fallback. No race — exactly
  // one onload triggers a render.
  const drawWatermark = () => {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, canvas.height - 30, canvas.width, 30);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 11px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✨ AI Visualization — For Reference Only', canvas.width / 2, canvas.height - 10);
  };

  if (generatedImageDataUrl) {
    const realImg = new Image();
    realImg.onload = () => {
      const srcRatio = realImg.naturalWidth / realImg.naturalHeight;
      const dstRatio = canvas.width / canvas.height;
      let drawW, drawH, drawX, drawY;
      if (srcRatio > dstRatio) {
        drawH = canvas.height; drawW = drawH * srcRatio;
        drawX = (canvas.width - drawW) / 2; drawY = 0;
      } else {
        drawW = canvas.width; drawH = drawW / srcRatio;
        drawX = 0; drawY = (canvas.height - drawH) / 2;
      }
      ctx.drawImage(realImg, drawX, drawY, drawW, drawH);
      drawWatermark();
    };
    realImg.src = generatedImageDataUrl;
  } else {
    // Legacy color-overlay fallback — uses the unified VIZ_OPTIONS hex
    // values so swatch colors and overlay colors can never drift.
    const baseImg = new Image();
    baseImg.onload = () => {
      ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.35;
      if (features.includes('roof')) {
        ctx.fillStyle = roofColor.hex;
        ctx.fillRect(0, 0, canvas.width, canvas.height * 0.38);
      }
      if (features.includes('siding')) {
        ctx.fillStyle = sidingColor.hex;
        ctx.fillRect(0, canvas.height * 0.35, canvas.width, canvas.height * 0.65);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      drawWatermark();
    };
    baseImg.src = uploadedDataUrl;
  }

  // Set AI text
  document.getElementById('aiAnalysisText').textContent = aiText;

  // Build result tags from selections — every label/hex comes from VIZ_OPTIONS
  const tagsBox = document.getElementById('aiTagsBox');
  tagsBox.innerHTML = '';
  const tagSpec = [
    { feat: 'roof',     label: `Roof · ${roofLine.label} · ${roofColor.name}`,                    hex: roofColor.hex },
    { feat: 'siding',   label: `Siding · ${sidingMat.label} · ${sidingStyle.label} · ${sidingColor.name}`, hex: sidingColor.hex },
    { feat: 'gutters',  label: `Gutters · ${gutterStyle.label} · ${gutterColor.name}`,            hex: gutterColor.hex },
    { feat: 'windows',  label: `Windows · ${windowColor.name} trim`,                              hex: windowColor.hex },
    { feat: 'garage',   label: `Garage · ${garageStyle.label} · ${garageColor.name}`,             hex: garageColor.hex },
    { feat: 'shutters', label: `Shutters · ${shutterColor.name}`,                                 hex: shutterColor.hex },
    { feat: 'doors',    label: `Front door · ${doorColor.name}`,                                  hex: doorColor.hex },
  ];
  tagSpec.forEach(t => {
    if (!features.includes(t.feat)) return;
    const tag = document.createElement('span');
    tag.className = 'ai-tag';
    tag.innerHTML = `<span class="dot" style="background:${t.hex}"></span>${t.label}`;
    tagsBox.appendChild(tag);
  });
}

/* Delegated click handlers (CSP disallows inline onclick=) */
document.addEventListener('click', function (e) {
  var step = e.target.closest('[data-step]');
  if (step) { goToStep(parseInt(step.dataset.step, 10)); return; }
  var act = e.target.closest('[data-action]');
  if (!act) return;
  var a = act.dataset.action;
  if (a === 'pickFile') document.getElementById('fileInput').click();
  else if (a === 'resetUpload') resetUpload();
  else if (a === 'runVisualizer') runVisualizer();
});
