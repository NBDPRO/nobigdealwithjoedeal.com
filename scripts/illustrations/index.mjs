// The illustration library: file name -> figure function.
import { eaveDetail } from './fig-eave.mjs';
import { systemExploded } from './fig-system.mjs';
import { rakeDetail, starterDetail } from './fig-corner.mjs';
import { nailZone } from './fig-nail.mjs';
import { stepFlashing } from './fig-step.mjs';
import { valleys, iwsValleys } from './fig-valley.mjs';
import { pipeBoot } from './fig-boot.mjs';
import { ventilation } from './fig-vent.mjs';
import { iceDam } from './fig-icedam.mjs';
import { hailImpact } from './fig-hail.mjs';
import { sidingWall } from './fig-wall.mjs';
import { windowFlashing } from './fig-window.mjs';
import { gutterSection } from './fig-gutter.mjs';
import { stormChecklist } from './fig-check.mjs';
export const FIGURES = {
  'roof-system-exploded': systemExploded,
  'eave-edge': eaveDetail,
  'rake-edge': rakeDetail,
  'starter-overhang': starterDetail,
  'nail-zone': nailZone,
  'step-kickout-flashing': stepFlashing,
  'valley-types': valleys,
  'ice-water-valleys-penetrations': iwsValleys,
  'pipe-boot-flashing': pipeBoot,
  'attic-ventilation': ventilation,
  'ice-dam': iceDam,
  'hail-impact-class4': hailImpact,
  'siding-wall-section': sidingWall,
  'window-flashing-sequence': windowFlashing,
  'gutter-section': gutterSection,
  'storm-inspection-checklist': stormChecklist,
};
