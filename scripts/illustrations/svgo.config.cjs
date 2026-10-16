// svgo config for the technical illustrations (run with the PINNED svgo@3.3.2;
// see scripts/build-illustrations.mjs). Keeps <title>/<desc>, ids (aria-
// labelledby, markers, patterns) and the viewBox; keeps <style> (the phone
// media query lives there).
module.exports = {
  multipass: true,
  floatPrecision: 1,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          removeViewBox: false,
          removeTitle: false,
          removeDesc: false,
          cleanupIds: false,
          inlineStyles: false,
          minifyStyles: false,
          mergePaths: false,
          removeUnknownsAndDefaults: { keepRoleAttr: true, keepAriaAttrs: true },
        },
      },
    },
  ],
};
