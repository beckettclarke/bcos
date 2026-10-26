// One place that binds htm to Preact, so every module writes html`…` the same way.
import { h, render, Fragment } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, Fragment };
export * from 'preact/hooks';
