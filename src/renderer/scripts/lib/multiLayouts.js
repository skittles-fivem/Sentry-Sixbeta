// Multi-camera layouts are supplied by the active dashcam profile.
// The current player exposes six reusable slots: tl, tc, tr, bl, bc, br.

import { DASHCAM_PROFILES } from '../../../shared/dashcamProfiles.mjs';

function profileLayout(profileId, name) {
  const profile = DASHCAM_PROFILES[profileId];
  return {
    name,
    columns: 3,
    slots: profile.layoutSlots.map(({ slot, camera }) => ({
      slot,
      camera,
      label: camera ? profile.cameras[camera] : ''
    }))
  };
}

// HW3 cars record four cameras (no B-pillars): a 2×2 grid. The centre slots
// stay empty and are hidden by the two-column grid mode.
function teslaHw3Layout() {
  const cameras = DASHCAM_PROFILES.tesla.cameras;
  const slot = (id, camera) => ({ slot: id, camera, label: camera ? cameras[camera] : '' });
  return {
    name: 'HW3',
    columns: 2,
    slots: [
      slot('tl', 'front'), slot('tc', null), slot('tr', 'back'),
      slot('bl', 'left_repeater'), slot('bc', null), slot('br', 'right_repeater')
    ]
  };
}

export const MULTI_LAYOUTS = {
  six_default: profileLayout('tesla', 'Default'),
  tesla_hw3: teslaHw3Layout(),
  gm_surroundvision: profileLayout('gm_surroundvision', 'GM Surround Vision')
};

export const DEFAULT_MULTI_LAYOUT = 'six_default';
