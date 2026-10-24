/**
 * sfgl/ui: iOS 26-style components built on sfgl's glass. Buttons, panels,
 * rows, text fields, bars with a morphing tab control, sheets, windows and
 * popups share one set of values (materials, springs, sizes) so an app made
 * of them looks like one thing.
 * @module
 */

export {configure, onConfigure, settings, scheme, el, icon, spring, pose, registerGlass, lensFor, reducedMotion} from './core.js';
export {attachStretch, stretchPose, rubber, overshoot} from './stretch.js';
export {installPress} from './press.js';
export {materials, DARK, LIGHT, ACTION_TINT, DANGER_TINT} from './materials.js';
export {createDomGlass} from './domglass.js';
export {createGlassHost, tintOf} from './glasshost.js';
export {createButton} from './button.js';
export {createPanel, createStatus} from './panel.js';
export {createRow, createGroup, createSection} from './rows.js';
export {createField} from './field.js';
export {createTabs} from './tabs.js';
export {createBar} from './bar.js';
export {layerRoot, createLayer} from './layers.js';
export {presentPopover, closePopovers} from './popover.js';
export {showMenu, onHold} from './menu.js';
export {presentDialog, confirmDiscard} from './dialog.js';
export {createSheet, standardHeader, safeInset} from './sheet.js';
export {createWindow} from './window.js';
