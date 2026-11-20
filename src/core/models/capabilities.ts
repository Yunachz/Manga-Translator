declare const __MANGA_PANEL_MODEL__: boolean;
declare const __MANGA_LAMA_MODEL__: boolean;

export const optionalModels = {
  panel: typeof __MANGA_PANEL_MODEL__ !== 'undefined' && __MANGA_PANEL_MODEL__,
  lama: typeof __MANGA_LAMA_MODEL__ !== 'undefined' && __MANGA_LAMA_MODEL__,
};
