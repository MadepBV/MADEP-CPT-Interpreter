// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/icons.js — the canvas tool-rail icon set and its button
// (refactor step 9f). Moved verbatim out of legacy-controller.js:
//   stage6BishopToolIcon         4475-4521 → toolIcon(name)
//   stage6BishopCanvasToolButton 4523-4538 → canvasToolButton(options)
import { escAttr as stage6EscAttr } from '../../core/format.js';

/** One 24×24 stroked glyph of the canvas tool vocabulary. */
export function toolIcon(name){
  const icons = {
    close:'<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
    play:'<path d="M6 4l14 8-14 8V4Z"></path>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    collapse:'<path d="M15 6 9 12l6 6"></path>',
    expand:'<path d="M9 6l6 6-6 6"></path>',
    settings:'<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path><circle cx="8" cy="6" r="1.8"></circle><circle cx="15" cy="12" r="1.8"></circle><circle cx="11" cy="18" r="1.8"></circle>',
    panel:'<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M9 5v14"></path>',
    eyeOff:'<path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.5 5.2A10.5 10.5 0 0 1 12 5c5 0 8.5 4.4 9.5 7a12.8 12.8 0 0 1-2.2 3.4"></path><path d="M6.2 6.8A12.8 12.8 0 0 0 2.5 12c1 2.6 4.5 7 9.5 7 1.4 0 2.7-.3 3.8-.9"></path>',
    materials:'<rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M5 9h14"></path><path d="M5 14h14"></path><path d="M9 4v16"></path><circle cx="7" cy="6.5" r=".8"></circle><circle cx="7" cy="11.5" r=".8"></circle><circle cx="7" cy="16.5" r=".8"></circle>',
    chart:'<path d="M4 19V5"></path><path d="M4 19h16"></path><path d="m7 15 3-4 3 2 4-7"></path>',
    reset:'<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>',
    pointer:'<path d="M5 3l7 16 2-6 6-2L5 3Z"></path>',
    measure:'<path d="M4 17 17 4l3 3L7 20l-3-3Z"></path><path d="m8 13 2 2"></path><path d="m11 10 2 2"></path><path d="m14 7 2 2"></path>',
    fit:'<path d="M8 3H3v5"></path><path d="M16 3h5v5"></path><path d="M8 21H3v-5"></path><path d="M16 21h5v-5"></path><path d="M3 3l6 6"></path><path d="m15 9 6-6"></path><path d="m3 21 6-6"></path><path d="m15 15 6 6"></path>',
    terrain:'<path d="M3 17c3-6 5-8 8-5s5 1 10-6"></path><path d="M3 21h18"></path>',
    import:'<path d="M12 3v10"></path><path d="m8 9 4 4 4-4"></path><path d="M5 17v2h14v-2"></path>',
    cpt:'<path d="M12 3v18"></path><path d="M8 7h8"></path><path d="M9 21h6"></path><circle cx="12" cy="11" r="2"></circle>',
    phreatic:'<path d="M3 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"></path><path d="M3 19c2-3 4-3 6 0s4 3 6 0 4-3 6 0"></path>',
    wall:'<path d="M12 3v18"></path><path d="M8 6h8"></path><path d="M8 10h8"></path><path d="M8 14h8"></path><path d="M8 18h8"></path>',
    drain:'<path d="M4 14h16"></path><path d="M6 10h12"></path><path d="M8 6h8"></path><path d="M7 18c1.8 2 8.2 2 10 0"></path>',
    load:'<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path>',
    entry:'<path d="M4 12h15"></path><path d="m10 6-6 6 6 6"></path>',
    exit:'<path d="M5 12h15"></path><path d="m14 6 6 6-6 6"></path>',
    boundary:'<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M4 12h16"></path><circle cx="8" cy="12" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle>',
    polygon:'<path d="M12 3 20 9l-3 10H7L4 9l8-6Z"></path>',
    meshUndeformed:'<path d="M4 6h16v12H4Z"></path><path d="M4 12h16"></path><path d="M10 6v12"></path><path d="M16 6v12"></path>',
    meshDeformed:'<path d="M4 18 9 8l6 3 5-7"></path><path d="M4 18h16"></path><path d="M9 8l1 10"></path><path d="M15 11l-5 7"></path>',
    arrows:'<path d="M5 17 17 5"></path><path d="M12 5h5v5"></path><path d="M19 7v12H7"></path><path d="m7 19 4-4"></path>',
    contourFill:'<path d="M4 18c3-8 6-12 10-10s4 6 6 10"></path><path d="M4 18h16"></path><path d="M8 16h8"></path><path d="M10 13h4"></path>',
    contourLines:'<path d="M4 8c4-3 8-3 12 0s4 3 4 0"></path><path d="M4 13c4-3 8-3 12 0s4 3 4 0"></path><path d="M4 18c4-3 8-3 12 0s4 3 4 0"></path>',
    plastic:'<circle cx="8" cy="8" r="2"></circle><circle cx="16" cy="9" r="2"></circle><circle cx="12" cy="16" r="2"></circle><path d="M10 9.5 14 15"></path><path d="M10 8.2 14 8.8"></path>',
    exitGradient:'<path d="M12 3 22 20H2L12 3Z"></path><path d="M12 9v5"></path><path d="M12 17h.01"></path>',
    label:'<path d="M4 6h10l6 6-6 6H4Z"></path><circle cx="8" cy="12" r="1.5"></circle>',
    copy:'<rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15V5h10"></path>',
    cut:'<circle cx="6" cy="7" r="2"></circle><circle cx="6" cy="17" r="2"></circle><path d="M8 8.5 19 19"></path><path d="M8 15.5 19 5"></path>',
    split:'<path d="M4 6h6a4 4 0 0 1 4 4v8"></path><path d="M4 18h6a4 4 0 0 0 4-4V6"></path><path d="M18 6h2"></path><path d="M18 18h2"></path>',
    finish:'<path d="M20 6 9 17l-5-5"></path>',
    undo:'<path d="M9 7 4 12l5 5"></path><path d="M5 12h10a5 5 0 0 1 0 10h-2"></path>',
    clear:'<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>',
    layers:'<path d="m12 3 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5"></path><path d="m3 16 9 5 9-5"></path>',
    download:'<path d="M12 3v12"></path><path d="m7 12 5 5 5-5"></path><path d="M5 21h14"></path>',
    copy:'<rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="5" y="5" width="10" height="10" rx="2"></rect>'
  };
  return `<svg class="st6-canvas-tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name] || icons.pointer}</svg>`;
}

/** The icon + label button every dock group and card action uses. */
export function canvasToolButton(options){
  const label = options?.label || 'Tool';
  const className = [
    'st6-canvas-tool-btn',
    options?.active ? 'active' : '',
    options?.tone ? `tone-${options.tone}` : ''
  ].filter(Boolean).join(' ');
  const disabled = options?.disabled ? ' disabled' : '';
  const onclick = options?.disabled ? '' : ` onclick="${options.onclick || ''}"`;
  return `
    <button type="button" class="${className}"${onclick}${disabled} title="${stage6EscAttr(label)}" aria-label="${stage6EscAttr(label)}" data-tip="${stage6EscAttr(label)}">
      ${toolIcon(options?.icon || 'pointer')}
      <span>${stage6EscAttr(label)}</span>
    </button>
  `;
}
