/**
 * The glass values every component uses, so a button or a bar looks the
 * same in a sheet, a window and a menu. Dark follows ChatGPT's iOS
 * composer: a neutral body that mostly hides what is behind it, almost no
 * refraction, a crisp hairline rim that takes the colour of its surroundings.
 * Light is the same glass over a light page (Calendar's sheets, Apple
 * Music's bars).
 * @module
 */

import {scheme} from './core.js';

export const DARK = {
  /** Bars, menus and popovers. */
  bar: {material: -0.5, tint: {color: '#1d1d1d', amount: 0.58}, frost: 8, refraction: 0.012, dispersion: 0, rim: 0.25, layer: 0},
  /** Menus, dialogs, dropdowns: a heavier frost so the label under a dropdown is gone. */
  menu: {material: -0.4, tint: {color: '#242426', amount: 0.74}, frost: 18, refraction: 0.012, dispersion: 0, rim: 0.25, layer: 3},
  /** Round buttons, chips, the selection lens. */
  control: {material: -0.3, tint: {color: '#262628', amount: 0.35}, frost: 3, refraction: 0.01, dispersion: 0, rim: 0.22, layer: 1},
  /** Boxes: tiles, windows' cards. */
  tile: {material: -0.3, tint: {color: '#262628', amount: 0.6}, frost: 6, refraction: 0.01, dispersion: 0, rim: 0.2, layer: 1},
  /** The tab bar's lifted selection: clear glass that bends what is under it. */
  lens: {material: 0, tint: {color: '#2a2a2c', amount: 0.12}, frost: 0, refraction: 0.06, magnify: 1.04, dispersion: 0.7, rim: 0.4, layer: 2},
};

export const LIGHT = {
  bar: {material: 0.4, tint: {color: '#ffffff', amount: 0.5}, frost: 8, refraction: 0.012, dispersion: 0, rim: 0.3, layer: 0},
  menu: {material: 0.4, tint: {color: '#ffffff', amount: 0.76}, frost: 18, refraction: 0.012, dispersion: 0, rim: 0.3, layer: 3},
  control: {material: 0.5, tint: {color: '#ffffff', amount: 0.55}, frost: 3, refraction: 0.01, dispersion: 0, rim: 0.28, layer: 1},
  tile: {material: 0.4, tint: {color: '#ffffff', amount: 0.7}, frost: 6, refraction: 0.01, dispersion: 0, rim: 0.25, layer: 1},
  lens: {material: 0.2, tint: {color: '#ffffff', amount: 0.2}, frost: 0, refraction: 0.06, magnify: 1.04, dispersion: 0.7, rim: 0.4, layer: 2},
};

/** The material set for the current scheme. */
export function materials() {
  return scheme() === 'dark' ? DARK : LIGHT;
}

/** The blue a button's glass turns to while it has something to do (the send button). */
export const ACTION_TINT = {color: '#4499f8', amount: 0.86};
/** The red of a destructive or "done" button. */
export const DANGER_TINT = {color: '#ff3b30', amount: 0.9};
