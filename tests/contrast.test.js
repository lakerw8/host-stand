import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*oklch\\(([-.\\d]+)%\\s+([-.\\d]+)\\s+([-.\\d]+)`));
  assert.ok(match, `Missing opaque OKLCH token --${name}`);
  return { l: Number(match[1]) / 100, c: Number(match[2]), h: Number(match[3]) };
}

function relativeLuminance({ l: lightness, c: chroma, h: hue }) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = Math.min(1, Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const green = Math.min(1, Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = Math.min(1, Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const left = relativeLuminance(token(first));
  const right = relativeLuminance(token(second));
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test("small-text token pairs meet WCAG AA contrast", () => {
  const pairs = [
    ["color-ink-2", "color-paper"],
    ["color-neutral", "color-paper"],
    ["color-neutral", "color-paper-2"],
    ["color-accent", "color-paper"],
    ["color-accent", "color-accent-soft"],
    ["color-accent-ink", "color-accent"],
    ["color-graphite-ink", "color-graphite"],
    ["color-ink", "color-warning-soft"],
    ["color-ink", "color-error-soft"]
  ];

  for (const [foreground, background] of pairs) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
  }
});

test("focus and component-boundary signals meet 3:1", () => {
  assert.ok(contrast("color-focus", "color-paper") >= 3);
  assert.ok(contrast("color-rule-2", "color-paper") >= 3);
  assert.ok(contrast("color-error", "color-paper") >= 3);
  assert.ok(contrast("color-success", "color-paper") >= 3);
});
